#!/usr/bin/env node
/**
 * ─── Africa Youth Transfer Tracker — Automated Sweep Runner ───
 *
 * Reads current data/players.json + data/intel.json, sends them to the
 * Anthropic API along with the Sweep Protocol v2.0 as the system prompt,
 * and asks Claude to perform a web-search-based sweep.
 *
 * Claude returns a structured JSON delta. If new intel is found, this script
 * patches the JSON files and triggers a rebuild via build.sh.
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

// ── Build baseline summary ────────────────────────────────────────────────
function buildBaseline() {
  const lines = [`BASELINE — ${today}`, ""];
  const players = playersData.players;

  for (const p of players) {
    const latestDate = p.rumors && p.rumors.length > 0
      ? p.rumors.reduce((max, r) => r.date > max ? r.date : max, "")
      : "—";
    const rumorCount = p.rumors ? p.rumors.length : 0;
    const clubs = p.rumors
      ? [...new Set(p.rumors.map(r => r.club))].join(", ")
      : "—";
    lines.push(
      `#${p.id} ${p.name} | ${p.country} | ${p.position} | Tier ${p.sweepTier} | ` +
      `Rumors: ${rumorCount} | Latest: ${latestDate} | Clubs: ${clubs} | Status: ${p.status}`
    );
  }

  return lines.join("\n");
}

// ── Build the system prompt (Sweep Protocol v2.0 condensed) ───────────────
const SYSTEM_PROMPT = `You are an automated transfer intelligence sweep agent for the Africa Youth Transfer Tracker.
You follow the Sweep Protocol v2.0 precisely.

TODAY'S DATE: ${today}

## THE THREE LAWS OF SWEEPING
LAW 1 — BASELINE BEFORE SEARCH. The baseline has been pre-extracted and provided to you below.
LAW 2 — ONLY NEW INTEL GETS REPORTED. A finding is 'new' only if: (a) not present in baseline, (b) has specific date+source+claim, (c) passes identity verification.
LAW 3 — EVERY PLAYER GETS SEARCHED (based on sweep type).

## SEARCH DEPTH — EQUAL FOR ALL PLAYERS
CRITICAL: Every player gets the FULL deep search pattern (6-10 searches). No player is deprioritised.
The tier classification (A/B/C) is for tracking status only — it does NOT reduce search effort.
A Tier C player with zero rumours today could be the one that breaks tomorrow. Search them all equally.

## SEARCH PATTERNS (applied to EVERY player)
Primary (always run):
Search 1: "[Full Name] transfer 2026"
Search 2: "[Full Name] [Current Club] transfer"
Search 3: "[Full Name] [nationality] football"
French language (all francophone players — Burkina Faso, Senegal, Ivory Coast, Mali):
Search 4: "[Full Name] transfert 2026"
Search 5: "[Full Name] AfricaFoot"
Club-side (for each known interested club from baseline):
Search 6: "[Interested Club] African signing 2026"
Search 7: "[Interested Club] [player nationality] transfer"
Alternative spellings (if applicable):
Search 8: "[Alt spelling] transfer 2026"
Social media:
Search 9: "[Name] site:x.com transfer"
Post-transfer (for confirmed/signed players — IN ADDITION to above):
Search 10: "[Name] [New Club] debut OR loan OR injury 2026"

## DELTA TEST (for every result)
Q1: Is this player on the tracker? No → verify identity first
Q2: Is this claim in the baseline? Yes → SKIP (recycled intel)
Q3: Genuinely new? New club/status escalation/fee details/corroboration/confirmation → ADD. Same story different outlet → SKIP.

## DATE GATING
For ALL players with existing intel, only content AFTER their latest baseline date counts. This prevents re-reporting old intel.

## SOURCE HIERARCHY
T1 (Official): Club sites, Transfermarkt, Romano, Ornstein, Moretto
T2 (Reliable): AfricaFoot, Africa Top Sports, Foot Africa, PanAfricaFootball, TEAMtalk, The Athletic, ESPN, Sky, L'Équipe, Bold.dk
T3 (Regional): AfricaSoccer, Kawowo, Pulse Sports, BeSoccer, TransferFeed, scout Twitter
T4 (Speculative): Unverified social, fan blogs, tabloids — only if specific + no better source

## IDENTITY VERIFICATION
Known confusion risks:
- Souleymane Faye (b.2010) vs Souleymane Faye (b.2003, Sporting CP)
- Mahamadou Traore (b.2009) vs Mamadou Traoré (b.1994, Dalian)
- Ettienne Mendy (b.2008) vs Édouard Mendy (b.1992, Al-Ahli)
- Mor Talla Ndiaye (b.2008) vs multiple Ndiayes
- Issouf Dabo (b.2009) vs Issouf Dayo (b.1992)
- A.L. Tapsoba (b.2010) vs Edmond Tapsoba (b.1999, Leverkusen)

## ALTERNATIVE SPELLINGS
El Hadj Malick Cissé: El Hadji Cisse, Malik Cissé, Malick Cisse, El Hadj Cisse
Mor Talla Ndiaye: El Hadji Mor Talla Ndiaye, Talla Ndiaye, Mor Talla
Mahamadou Traore: Mamadou Traoré, Mahamadou Traoré
A.L. Tapsoba: Asharaf Loukmane Tapsoba, Ashraf Loukman Tapsoba, Loukmane Tapsoba
Yao Hubert: Hubert Yao
Ettienne Mendy: Etienne Mendy
Souleymane Doumbia: Soulaymane Doumbia

## WRITING RULES
- Max 80 chars for detail line
- Lead with most important fact
- Never write 'reportedly' — Source field handles attribution
- Use abbreviations: Man Utd, Barca, BVB, PSG, PL
- Dates: "Feb 8, 2026" preferred. Acceptable: "Mid-Jan 2026". Never: "Recently"
- Recent = within 60 days of sweep. Archive = older than 60 days.

## OUTPUT FORMAT
You MUST return your findings as a JSON object with this exact structure:
{
  "sweepDate": "${today}",
  "sweepType": "${SWEEP_TYPE}",
  "sweepNumber": ${playersData.meta.sweepNumber + 1},
  "baselineItems": <total rumor count>,
  "playersSearched": <count>,
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
        "status": "<status string>",
        "recent": true
      },
      "intelUpdates": {
        // any fields to merge into data/intel.json for this player, or null
      },
      "reasoning": "<why this passed the delta test>"
    }
  ],
  "escalations": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "field": "<what changed>",
      "oldValue": "<previous>",
      "newValue": "<new>",
      "source": "<source>"
    }
  ],
  "tierChanges": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "oldTier": "<A|B|C>",
      "newTier": "<A|B|C>",
      "reason": "<why>"
    }
  ],
  "noChange": ["<player name>", "..."],
  "needsReview": [
    {
      "playerId": <number>,
      "playerName": "<string>",
      "detail": "<what was found>",
      "reason": "<why uncertain>"
    }
  ]
}

CRITICAL: Return ONLY the JSON object, no markdown fences, no commentary before or after. The JSON must be valid and parseable.
If no new intel is found at all, return the structure with empty arrays for newIntel, escalations, tierChanges, and needsReview, and list all players in noChange.`;

// ── Build the user message ────────────────────────────────────────────────
function buildUserMessage() {
  const baseline = buildBaseline();

  // Filter players based on sweep type
  let targetPlayers;
  if (SWEEP_TYPE === "flash" && FLASH_PLAYER) {
    targetPlayers = playersData.players.filter(
      p => p.name.toLowerCase().includes(FLASH_PLAYER.toLowerCase())
    );
    if (targetPlayers.length === 0) {
      console.error(`ERROR: No player found matching "${FLASH_PLAYER}"`);
      process.exit(1);
    }
  } else if (SWEEP_TYPE === "priority") {
    targetPlayers = playersData.players.filter(
      p => p.sweepTier === "A" || p.sweepTier === "B"
    );
  } else {
    targetPlayers = playersData.players;
  }

  const playerDetails = targetPlayers.map(p => {
    const intel = intelData[String(p.id)] || {};
    return `--- Player #${p.id}: ${p.name} ---
Country: ${p.country} | Position: ${p.position} | Born: ${p.birthYear}
Current Club: ${p.currentClub} | Status: ${p.status} | Tier: ${p.sweepTier}
Alt Spellings: ${(p.altSpellings || []).join(", ") || "none"}
Confusion Risk: ${p.confusionRisk || "none"}
Intel: height=${intel.height || "—"}, foot=${intel.foot || "—"}, contract=${intel.contract || "—"}
Previous Club: ${intel.previousClub || "—"}
Season Stats: ${intel.seasonStats || "—"}
Existing Rumors (${(p.rumors || []).length}):
${(p.rumors || []).map(r => `  [${r.date}] ${r.club} — ${r.detail} (${r.source}, T${r.tier}, ${r.status})`).join("\n") || "  none"}`;
  }).join("\n\n");

  return `Run a ${SWEEP_TYPE.toUpperCase()} SWEEP for the Africa Youth Transfer Tracker.

## BASELINE (pre-extracted)
${baseline}

## FULL PLAYER DATA FOR THIS SWEEP
${playerDetails}

## INSTRUCTIONS
1. For each player in scope, run the appropriate search pattern for their tier.
2. Apply the delta test to every result — only genuinely new intel passes.
3. Use date gating: ignore results on or before each player's latest baseline date.
4. Verify identity for any new findings (check birth year, club, nationality).
5. Return the structured JSON delta report.

Search each player now and report your findings.`;
}

// ── Call the API ──────────────────────────────────────────────────────────
async function runSweep() {
  const client = new Anthropic();

  const userMessage = buildUserMessage();

  if (VERBOSE) {
    console.log("=== SYSTEM PROMPT ===");
    console.log(SYSTEM_PROMPT.substring(0, 500) + "...\n");
    console.log("=== USER MESSAGE ===");
    console.log(userMessage.substring(0, 1000) + "...\n");
  }

  console.log("Sending sweep request to Claude...");
  console.log(`(This will take a while — Claude needs to search for all players)\n`);

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 250
        }
      ],
      messages: [{ role: "user", content: userMessage }]
    });
  } catch (err) {
    console.error("API call failed:", err.message);
    if (err.status === 401) {
      console.error("Check your ANTHROPIC_API_KEY.");
    }
    process.exit(1);
  }

  // ── Extract the text response ─────────────────────────────────────────
  const textBlocks = response.content.filter(b => b.type === "text");
  const fullText = textBlocks.map(b => b.text).join("\n");

  if (VERBOSE) {
    console.log("=== RAW RESPONSE ===");
    console.log(fullText.substring(0, 2000) + "...\n");
  }

  // ── Parse the JSON delta ──────────────────────────────────────────────
  let delta;
  try {
    // Try to extract JSON from the response — it might be wrapped in markdown
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in response");
    }
    delta = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Failed to parse delta JSON:", err.message);
    console.error("Raw response saved to sweeps/last_raw_response.txt");
    fs.mkdirSync(DELTA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DELTA_DIR, "last_raw_response.txt"),
      fullText,
      "utf-8"
    );
    process.exit(1);
  }

  // ── Validate the parsed delta ────────────────────────────────────
  console.log("\n=== VALIDATING SWEEP RESULTS ===");

  // Validate each new intel item
  const validatedIntel = [];
  const rejectedIntel = [];

  for (const item of (delta.newIntel || [])) {
    const errors = [];

    // Validate rumour schema
    if (item.rumor) {
      const rumourResult = validateRumour(item.rumor);
      if (!rumourResult.valid) errors.push(...rumourResult.errors);
    } else {
      errors.push("Missing rumor object");
    }

    // Validate player identity
    const identityResult = validatePlayerIdentity(item, playersData);
    if (!identityResult.valid) errors.push(...identityResult.errors);

    // Validate tier consistency (soft warnings — logged but not rejected)
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

  // Replace newIntel with only validated items
  delta.newIntel = validatedIntel;

  if (rejectedIntel.length > 0) {
    console.log(`\n=== REJECTED INTEL (${rejectedIntel.length} items) ===`);
    rejectedIntel.forEach(r => {
      console.log(`  REJECTED: ${r.item.playerName || "Unknown"} — ${r.errors.join("; ")}`);
    });
    // Add rejected items to needsReview
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

  // Validate escalations
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

  // Validate tier changes
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

  // Apply new intel (new rumors)
  if (delta.newIntel && delta.newIntel.length > 0) {
    console.log(`\n=== NEW INTEL (${delta.newIntel.length} items) ===`);
    for (const item of delta.newIntel) {
      const player = playersData.players.find(p => p.id === item.playerId);
      if (!player) {
        console.warn(`  SKIP: Player ID ${item.playerId} not found`);
        continue;
      }

      // Add the rumor
      if (item.rumor) {
        if (!player.rumors) player.rumors = [];
        // Check for duplicates (normalized matching)
        const isDupe = isDuplicate(item.rumor, player.rumors);
        if (isDupe) {
          console.log(`  SKIP (dupe): ${item.playerName} — ${item.rumor.detail}`);
          continue;
        }
        // Insert at the beginning (newest first)
        player.rumors.unshift(item.rumor);
        console.log(`  ADD: ${item.playerName} | ${item.rumor.date} | ${item.rumor.club} | ${item.rumor.detail}`);
        changed = true;
      }

      // Merge intel updates
      if (item.intelUpdates && typeof item.intelUpdates === "object") {
        const key = String(item.playerId);
        if (!intelData[key]) intelData[key] = {};
        Object.assign(intelData[key], item.intelUpdates);
        console.log(`  INTEL UPDATE: ${item.playerName} — ${Object.keys(item.intelUpdates).join(", ")}`);
        changed = true;
      }
    }
  }

  // Apply escalations (status changes on existing players)
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

  // Apply tier changes
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

  // Log no-change players
  if (delta.noChange && delta.noChange.length > 0) {
    console.log(`\n=== NO CHANGE (${delta.noChange.length} players) ===`);
    console.log(`  ${delta.noChange.join(", ")}`);
  }

  // Log needs-review items
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
