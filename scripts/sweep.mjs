#!/usr/bin/env node
/**
 * ─── Africa Youth Transfer Tracker — Automated Sweep Runner ───
 *
 * Two-phase approach:
 *   Phase 1 — Claude searches the web for transfer intel (web_search tool).
 *   Phase 2 — A second Claude call takes the search findings and produces
 *             a structured JSON delta (no tools, guaranteed output).
 *
 * This split ensures the JSON is always produced, even if searches are
 * expensive. It also allows batching for full sweeps (groups of 5-7 players).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/sweep.mjs [--type full|priority|flash] [--player "Name"]
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required
 *   SWEEP_MODEL         — optional, defaults to claude-sonnet-4-20250514
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateRumour,
  validatePlayerIdentity,
  isDuplicate,
  validateTierConsistency,
  validateEscalation,
  validateTierChange
} from "./validate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const SWEEP_TYPE = getArg("--type", "full");       // full | priority | flash
const FLASH_PLAYER = getArg("--player", null);      // only for flash sweeps
const DRY_RUN = args.includes("--dry-run");          // don't write files
const VERBOSE = args.includes("--verbose");

// ── Paths ─────────────────────────────────────────────────────────────────
const PLAYERS_PATH = path.join(ROOT, "data", "players.json");
const INTEL_PATH = path.join(ROOT, "data", "intel.json");
const DELTA_DIR = path.join(ROOT, "sweeps");
const BUILD_SCRIPT = path.join(ROOT, "build.sh");

// ── Validate ──────────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY environment variable is required.");
  process.exit(1);
}
if (!fs.existsSync(PLAYERS_PATH) || !fs.existsSync(INTEL_PATH)) {
  console.error("ERROR: data/players.json or data/intel.json not found.");
  process.exit(1);
}

const MODEL = process.env.SWEEP_MODEL || "claude-sonnet-4-20250514";

// ── Load current data ─────────────────────────────────────────────────────
const playersData = JSON.parse(fs.readFileSync(PLAYERS_PATH, "utf-8"));
const intelData = JSON.parse(fs.readFileSync(INTEL_PATH, "utf-8"));

const today = new Date().toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric"
});

console.log(`\n=== SWEEP RUNNER ===`);
console.log(`Type: ${SWEEP_TYPE.toUpperCase()}`);
console.log(`Date: ${today}`);
console.log(`Model: ${MODEL}`);
console.log(`Players: ${playersData.players.length}`);
console.log(`Existing intel items: ${Object.values(intelData).length}`);
if (FLASH_PLAYER) console.log(`Flash target: ${FLASH_PLAYER}`);
if (DRY_RUN) console.log(`DRY RUN — no files will be written`);
console.log("");

// ── Get target players based on sweep type ────────────────────────────────
function getTargetPlayers() {
  if (SWEEP_TYPE === "flash" && FLASH_PLAYER) {
    const targets = playersData.players.filter(
      p => p.name.toLowerCase().includes(FLASH_PLAYER.toLowerCase())
    );
    if (targets.length === 0) {
      console.error(`ERROR: No player found matching "${FLASH_PLAYER}"`);
      process.exit(1);
    }
    return targets;
  } else if (SWEEP_TYPE === "priority") {
    return playersData.players.filter(
      p => p.sweepTier === "A" || p.sweepTier === "B"
    );
  } else {
    return playersData.players;
  }
}

// ── Build player detail string for a batch ────────────────────────────────
function buildPlayerDetails(players) {
  return players.map(p => {
    const intel = intelData[String(p.id)] || {};
    return `--- Player #${p.id}: ${p.name} ---
Country: ${p.country} | Position: ${p.position} | Born: ${p.birthYear}
Current Club: ${p.currentClub} | Status: ${p.status} | Tier: ${p.sweepTier}
Alt Spellings: ${(p.altSpellings || []).join(", ") || "none"}
Confusion Risk: ${p.confusionRisk || "none"}
Contract: ${intel.contract || "—"} | Previous Club: ${intel.previousClub || "—"}
Existing Rumors (${(p.rumors || []).length}):
${(p.rumors || []).map(r => `  [${r.date}] ${r.club} — ${r.detail} (${r.source}, T${r.tier})`).join("\n") || "  none"}`;
  }).join("\n\n");
}

// ── Phase 1: Search ──────────────────────────────────────────────────────
// Claude uses web_search to find transfer intel. Returns raw text findings.
async function phase1Search(client, players) {
  const playerDetails = buildPlayerDetails(players);
  const playerNames = players.map(p => p.name).join(", ");
  const maxSearches = SWEEP_TYPE === "flash" ? 15 : Math.min(players.length * 5, 50);

  const searchPrompt = `You are a football transfer research assistant. Search for the latest transfer news and rumours for these players. Today is ${today}.

For EACH player below, run 3-5 web searches using their name + "transfer 2026", their name + club, and French variants for francophone players.

IMPORTANT:
- Search ALL players listed — do not skip any
- For each search result, note the DATE, SOURCE, and KEY CLAIM
- Be careful about identity: check birth year and nationality match
- Only note genuinely new findings (not already in their existing rumors)
- Keep your text output brief — just list findings per player

PLAYERS TO SEARCH:
${playerDetails}

Search each player now. For each, write a brief summary of what you found (or "No new intel found").`;

  console.log(`Phase 1: Searching for ${players.length} player(s): ${playerNames}`);
  console.log(`  Max searches: ${maxSearches}\n`);

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    system: "You are a football transfer research agent. Search for transfer news and report findings concisely. Do NOT produce JSON — just describe what you found for each player.",
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: maxSearches
      }
    ],
    messages: [{ role: "user", content: searchPrompt }]
  });

  let searchCount = 0;
  stream.on("event", (event) => {
    if (event.type === "content_block_start" && event.content_block?.type === "web_search_tool_result") {
      searchCount++;
      process.stdout.write(`  [Search ${searchCount}/${maxSearches}] `);
    }
  });

  const response = await stream.finalMessage();
  console.log(`\n  Phase 1 complete: ${searchCount} searches performed.`);

  // Extract all text blocks (the research findings)
  const textBlocks = response.content.filter(b => b.type === "text");
  const findings = textBlocks.map(b => b.text).join("\n");

  if (VERBOSE) {
    console.log("\n=== PHASE 1 FINDINGS ===");
    console.log(findings.substring(0, 3000) + (findings.length > 3000 ? "..." : ""));
    console.log("");
  }

  return findings;
}

// ── Phase 2: Produce JSON delta ──────────────────────────────────────────
// Takes search findings from Phase 1 and produces the structured JSON.
// No web_search tool — guaranteed to produce output.
async function phase2Produce(client, players, allFindings) {
  const playerDetails = buildPlayerDetails(players);

  const jsonPrompt = `You are the JSON formatter for the Africa Youth Transfer Tracker. Based on the research findings below, produce the structured delta JSON.

TODAY'S DATE: ${today}

## RULES
1. Only include genuinely NEW intel not already in the player's existing rumors
2. Apply date gating: ignore anything on or before each player's latest rumour date
3. Verify identity: check birth year, club, nationality match our player
4. Max 80 chars for "detail" field. Lead with the most important fact.
5. Dates: "Feb 8, 2026" format. Never "Recently".
6. Source tiers: T1 (Official/Romano/Transfermarkt), T2 (AfricaFoot/ESPN/Athletic), T3 (Regional), T4 (Speculative)

## KNOWN CONFUSION RISKS
- Souleymane Faye (b.2010) vs Souleymane Faye (b.2003, Sporting CP)
- Mahamadou Traore (b.2009) vs Mamadou Traoré (b.1994, Dalian)
- Ettienne Mendy (b.2008) vs Édouard Mendy (b.1992, Al-Ahli)
- Mor Talla Ndiaye (b.2008) vs multiple Ndiayes
- Issouf Dabo (b.2009) vs Issouf Dayo (b.1992)
- A.L. Tapsoba (b.2010) vs Edmond Tapsoba (b.1999, Leverkusen)

## CURRENT PLAYER DATA
${playerDetails}

## RESEARCH FINDINGS FROM WEB SEARCH
${allFindings}

## OUTPUT
Return ONLY a valid JSON object with this exact structure (no markdown fences, no commentary):
{
  "sweepDate": "${today}",
  "sweepType": "${SWEEP_TYPE}",
  "sweepNumber": ${playersData.meta.sweepNumber + 1},
  "baselineItems": ${playersData.players.reduce((sum, p) => sum + (p.rumors?.length || 0), 0)},
  "playersSearched": ${players.length},
  "newIntel": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "rumor": {
        "date": "<Mon DD, YYYY>",
        "club": "<club name>",
        "detail": "<max 80 chars>",
        "source": "<source name>",
        "tier": <1-4>,
        "status": "<rumour|advanced|confirmed|official>",
        "recent": true
      },
      "intelUpdates": { <fields to update in intel.json, or null> },
      "reasoning": "<why this passed the delta test>"
    }
  ],
  "escalations": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "field": "status",
      "oldValue": "<previous status>",
      "newValue": "<new status>",
      "source": "<source>"
    }
  ],
  "tierChanges": [],
  "noChange": [<names of players with no new intel>],
  "needsReview": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "detail": "<what was found>",
      "reason": "<why uncertain>"
    }
  ]
}

If no new intel was found for any player, return empty arrays and list all names in noChange.
Return ONLY the JSON — nothing else.`;

  console.log("\nPhase 2: Producing structured JSON delta...");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: jsonPrompt }]
  });

  const fullText = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n");

  if (VERBOSE) {
    console.log("=== PHASE 2 RAW OUTPUT ===");
    console.log(fullText.substring(0, 2000) + (fullText.length > 2000 ? "..." : ""));
    console.log("");
  }

  return fullText;
}

// ── Run the sweep ────────────────────────────────────────────────────────
async function runSweep() {
  const client = new Anthropic();
  const targetPlayers = getTargetPlayers();

  console.log(`Target players: ${targetPlayers.length}`);
  console.log(`Players: ${targetPlayers.map(p => p.name).join(", ")}\n`);

  // Batch players for full sweeps (groups of 7), single batch for flash/priority
  const BATCH_SIZE = 7;
  let batches;
  if (SWEEP_TYPE === "full" && targetPlayers.length > BATCH_SIZE) {
    batches = [];
    for (let i = 0; i < targetPlayers.length; i += BATCH_SIZE) {
      batches.push(targetPlayers.slice(i, i + BATCH_SIZE));
    }
    console.log(`Splitting into ${batches.length} batches of up to ${BATCH_SIZE} players each.\n`);
  } else {
    batches = [targetPlayers];
  }

  // Phase 1: Search each batch
  let allFindings = "";
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batches.length > 1) {
      console.log(`\n─── Batch ${i + 1}/${batches.length} ───`);
    }
    try {
      const findings = await phase1Search(client, batch);
      allFindings += `\n=== Batch ${i + 1} findings ===\n${findings}\n`;
    } catch (err) {
      console.error(`Phase 1 batch ${i + 1} failed:`, err.message);
      allFindings += `\n=== Batch ${i + 1}: SEARCH FAILED ===\n`;
    }
  }

  // Save raw findings for debugging
  fs.mkdirSync(DELTA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DELTA_DIR, "last_raw_findings.txt"),
    allFindings,
    "utf-8"
  );

  // Phase 2: Produce JSON from all findings
  let jsonText;
  try {
    jsonText = await phase2Produce(client, targetPlayers, allFindings);
  } catch (err) {
    console.error("Phase 2 failed:", err.message);
    process.exit(1);
  }

  // Parse the JSON delta
  let delta;
  try {
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in Phase 2 response");
    }
    delta = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Failed to parse delta JSON:", err.message);
    console.error("Raw Phase 2 response saved to sweeps/last_raw_response.txt");
    fs.writeFileSync(
      path.join(DELTA_DIR, "last_raw_response.txt"),
      jsonText,
      "utf-8"
    );
    process.exit(1);
  }

  // ── Validate the parsed delta ────────────────────────────────────
  console.log("\n=== VALIDATING SWEEP RESULTS ===");

  const validatedIntel = [];
  const rejectedIntel = [];

  for (const item of (delta.newIntel || [])) {
    const errors = [];

    if (item.rumor) {
      const rumourResult = validateRumour(item.rumor);
      if (!rumourResult.valid) errors.push(...rumourResult.errors);
    } else {
      errors.push("Missing rumor object");
    }

    const identityResult = validatePlayerIdentity(item, playersData);
    if (!identityResult.valid) errors.push(...identityResult.errors);

    if (item.rumor) {
      const tierResult = validateTierConsistency(item.rumor);
      if (!tierResult.valid) {
        tierResult.warnings.forEach(w => console.warn(`  TIER WARNING: ${item.playerName} — ${w}`));
      }
    }

    if (errors.length > 0) {
      rejectedIntel.push({ item, errors });
    } else {
      validatedIntel.push(item);
    }
  }

  delta.newIntel = validatedIntel;

  if (rejectedIntel.length > 0) {
    console.log(`\n=== REJECTED INTEL (${rejectedIntel.length} items) ===`);
    rejectedIntel.forEach(r => {
      console.log(`  REJECTED: ${r.item.playerName || "Unknown"} — ${r.errors.join("; ")}`);
    });
    if (!delta.needsReview) delta.needsReview = [];
    delta.needsReview.push(
      ...rejectedIntel.map(r => ({
        playerId: r.item.playerId,
        playerName: r.item.playerName || "Unknown",
        detail: r.item.rumor?.detail || "Unknown",
        reason: "Auto-rejected: " + r.errors.join("; ")
      }))
    );
  }

  if (delta.escalations && delta.escalations.length > 0) {
    delta.escalations = delta.escalations.filter(esc => {
      const result = validateEscalation(esc, playersData);
      if (!result.valid) {
        console.warn(`  REJECTED ESCALATION: ${esc.playerName} — ${result.errors.join("; ")}`);
        return false;
      }
      return true;
    });
  }

  if (delta.tierChanges && delta.tierChanges.length > 0) {
    delta.tierChanges = delta.tierChanges.filter(tc => {
      const result = validateTierChange(tc, playersData);
      if (!result.valid) {
        console.warn(`  REJECTED TIER CHANGE: ${tc.playerName} — ${result.errors.join("; ")}`);
        return false;
      }
      return true;
    });
  }

  const totalValidated = validatedIntel.length;
  const totalRejected = rejectedIntel.length;
  console.log(`\nValidation complete: ${totalValidated} accepted, ${totalRejected} rejected`);

  return delta;
}

// ── Apply delta to data files ─────────────────────────────────────────────
function applyDelta(delta) {
  let changed = false;

  if (delta.newIntel && delta.newIntel.length > 0) {
    console.log(`\n=== NEW INTEL (${delta.newIntel.length} items) ===`);
    for (const item of delta.newIntel) {
      const player = playersData.players.find(p => p.id === item.playerId);
      if (!player) {
        console.warn(`  SKIP: Player ID ${item.playerId} not found`);
        continue;
      }

      if (item.rumor) {
        if (!player.rumors) player.rumors = [];
        const isDupe = isDuplicate(item.rumor, player.rumors);
        if (isDupe) {
          console.log(`  SKIP (dupe): ${item.playerName} — ${item.rumor.detail}`);
          continue;
        }
        player.rumors.unshift(item.rumor);
        console.log(`  ADD: ${item.playerName} | ${item.rumor.date} | ${item.rumor.club} | ${item.rumor.detail}`);
        changed = true;
      }

      if (item.intelUpdates && typeof item.intelUpdates === "object") {
        const key = String(item.playerId);
        if (!intelData[key]) intelData[key] = {};
        Object.assign(intelData[key], item.intelUpdates);
        console.log(`  INTEL UPDATE: ${item.playerName} — ${Object.keys(item.intelUpdates).join(", ")}`);
        changed = true;
      }
    }
  }

  if (delta.escalations && delta.escalations.length > 0) {
    console.log(`\n=== ESCALATIONS (${delta.escalations.length}) ===`);
    for (const esc of delta.escalations) {
      const player = playersData.players.find(p => p.id === esc.playerId);
      if (!player) continue;
      if (esc.field === "status") {
        player.status = esc.newValue;
        console.log(`  ${esc.playerName}: ${esc.oldValue} → ${esc.newValue}`);
        changed = true;
      }
    }
  }

  if (delta.tierChanges && delta.tierChanges.length > 0) {
    console.log(`\n=== TIER CHANGES (${delta.tierChanges.length}) ===`);
    for (const tc of delta.tierChanges) {
      const player = playersData.players.find(p => p.id === tc.playerId);
      if (!player) continue;
      player.sweepTier = tc.newTier;
      console.log(`  ${tc.playerName}: Tier ${tc.oldTier} → Tier ${tc.newTier} (${tc.reason})`);
      changed = true;
    }
  }

  if (delta.noChange && delta.noChange.length > 0) {
    console.log(`\n=== NO CHANGE (${delta.noChange.length} players) ===`);
    console.log(`  ${delta.noChange.join(", ")}`);
  }

  if (delta.needsReview && delta.needsReview.length > 0) {
    console.log(`\n=== NEEDS REVIEW (${delta.needsReview.length}) ===`);
    for (const nr of delta.needsReview) {
      console.log(`  ${nr.playerName}: ${nr.detail} — ${nr.reason}`);
    }
  }

  return changed;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const delta = await runSweep();

  // Save the raw delta report
  fs.mkdirSync(DELTA_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const deltaPath = path.join(DELTA_DIR, `sweep_${timestamp}.json`);
  fs.writeFileSync(deltaPath, JSON.stringify(delta, null, 2), "utf-8");
  console.log(`\nDelta report saved: ${deltaPath}`);

  // Apply changes
  const hasChanges = applyDelta(delta);

  if (!hasChanges) {
    console.log("\n--- No changes detected. Tracker is up to date. ---");
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log("\n--- DRY RUN: Changes detected but not written. ---");
    process.exit(0);
  }

  // Update sweep metadata
  playersData.meta.lastSweep = today;
  playersData.meta.sweepNumber = delta.sweepNumber || playersData.meta.sweepNumber + 1;

  // Backup current files before overwriting
  const backupDir = path.join(ROOT, "sweeps", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(PLAYERS_PATH, path.join(backupDir, `players_pre_sweep_${timestamp}.json`));
  fs.copyFileSync(INTEL_PATH, path.join(backupDir, `intel_pre_sweep_${timestamp}.json`));
  console.log("Pre-sweep backups saved.");

  // Write updated JSON files
  fs.writeFileSync(PLAYERS_PATH, JSON.stringify(playersData, null, 2), "utf-8");
  fs.writeFileSync(INTEL_PATH, JSON.stringify(intelData, null, 2), "utf-8");
  console.log("\nData files updated.");

  // Run build
  console.log("Running build...");
  try {
    const output = execSync(`bash "${BUILD_SCRIPT}"`, { cwd: ROOT, encoding: "utf-8" });
    console.log(output.trim());
  } catch (err) {
    console.error("Build failed:", err.message);
    process.exit(1);
  }

  console.log("\n=== SWEEP COMPLETE ===");
  const newCount = delta.newIntel ? delta.newIntel.length : 0;
  const escCount = delta.escalations ? delta.escalations.length : 0;
  const reviewCount = delta.needsReview ? delta.needsReview.length : 0;
  console.log(`New: ${newCount} | Escalated: ${escCount} | Review: ${reviewCount}`);
}

main().catch(err => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
