/**
 * ─── Validation module for Africa Youth Transfer Tracker sweeps ───
 *
 * Validates API-returned intel before writing to data files.
 * Catches identity confusion, schema errors, tier mismatches, and duplicates.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// ── Load club alias registry ─────────────────────────────────────────
let clubsRegistry = { aliases: {}, academyPipelines: {} };
const CLUBS_PATH = path.join(ROOT, "data", "clubs.json");
try {
  clubsRegistry = JSON.parse(fs.readFileSync(CLUBS_PATH, "utf-8"));
} catch (e) {
  console.warn("Warning: data/clubs.json not found or invalid — club validation limited.");
}

// ── Date format regex ────────────────────────────────────────────────
const DATE_PATTERN = /^(Mid-)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}$/;

// ── Known source tiers (lowercase) ──────────────────────────────────
const TIER_1_KEYWORDS = ["official", "club site", "transfermarkt", "romano", "ornstein", "moretto"];
const TIER_2_KEYWORDS = ["africafoot", "africa top sports", "foot africa", "panafricafootball", "teamtalk", "the athletic", "espn", "sky", "l'équipe", "l'equipe", "bold.dk", "gazzetta"];
const TIER_4_KEYWORDS = ["fan blog", "unverified", "tabloid", "rumour mill"];

// ── Helpers ──────────────────────────────────────────────────────────
function normalizeName(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function normalizeClub(club) {
  // Check alias registry first
  for (const [canonical, aliases] of Object.entries(clubsRegistry.aliases || {})) {
    const allForms = [canonical, ...aliases].map(s => s.toLowerCase());
    if (allForms.includes(club.toLowerCase())) return canonical.toLowerCase();
  }
  // Fallback: strip common prefixes/suffixes
  return club.toLowerCase()
    .replace(/^fc\s+/i, "").replace(/\s+fc$/i, "")
    .replace(/^ac\s+/i, "").replace(/\s+ac$/i, "")
    .trim();
}

// ── 1. Validate rumour schema ────────────────────────────────────────
export function validateRumour(rumour) {
  const errors = [];

  if (!rumour.date || typeof rumour.date !== "string") {
    errors.push("Missing or invalid date");
  } else if (!DATE_PATTERN.test(rumour.date)) {
    errors.push(`Date format invalid: "${rumour.date}" — expected "Mon DD, YYYY"`);
  }

  if (!rumour.club || typeof rumour.club !== "string" || rumour.club.trim().length === 0) {
    errors.push("Missing club name");
  } else if (rumour.club.length > 60) {
    errors.push(`Club name too long (${rumour.club.length} chars, max 60)`);
  }

  if (!rumour.detail || typeof rumour.detail !== "string" || rumour.detail.trim().length === 0) {
    errors.push("Missing detail");
  } else if (rumour.detail.length > 100) {
    errors.push(`Detail too long (${rumour.detail.length} chars, max 100)`);
  }

  if (!rumour.source || typeof rumour.source !== "string") {
    errors.push("Missing source");
  }

  if (rumour.tier === undefined || rumour.tier === null) {
    errors.push("Missing tier");
  } else if (!Number.isInteger(rumour.tier) || rumour.tier < 1 || rumour.tier > 4) {
    errors.push(`Invalid tier: ${rumour.tier} — must be 1-4`);
  }

  if (!rumour.status || typeof rumour.status !== "string") {
    errors.push("Missing status");
  }

  if (typeof rumour.recent !== "boolean") {
    errors.push("Missing or invalid 'recent' boolean");
  }

  return { valid: errors.length === 0, errors };
}

// ── 2. Validate player identity ──────────────────────────────────────
export function validatePlayerIdentity(intelItem, playersData) {
  const errors = [];
  const player = playersData.players.find(p => p.id === intelItem.playerId);

  if (!player) {
    errors.push(`Player ID ${intelItem.playerId} not found in master list`);
    return { valid: false, errors };
  }

  // Name match check (with accent tolerance + alt spellings)
  if (intelItem.playerName) {
    const apiName = normalizeName(intelItem.playerName);
    const masterName = normalizeName(player.name);
    if (apiName !== masterName) {
      const altMatch = (player.altSpellings || []).some(
        alt => normalizeName(alt) === apiName
      );
      if (!altMatch) {
        errors.push(
          `Name mismatch: API returned "${intelItem.playerName}" but ID ${intelItem.playerId} is "${player.name}"`
        );
      }
    }
  }

  // Cross-contamination check: scan detail for other players' current clubs
  if (intelItem.rumor && intelItem.rumor.detail) {
    const detail = intelItem.rumor.detail.toLowerCase();

    for (const other of playersData.players) {
      if (other.id === intelItem.playerId) continue;
      const otherClub = other.currentClub.toLowerCase();
      const playerClub = player.currentClub.toLowerCase();
      // Only flag if the mentioned club belongs to another player AND is different from this player's club
      if (otherClub !== playerClub && detail.includes(otherClub) && otherClub.length > 3) {
        errors.push(
          `Detail mentions "${other.currentClub}" which is ${other.name}'s club (ID ${other.id}), not ${player.name}'s`
        );
      }
    }

    // Academy pipeline confusion check
    for (const [academy, destination] of Object.entries(clubsRegistry.academyPipelines || {})) {
      if (detail.includes(academy.toLowerCase())) {
        // Check if this player is actually associated with this academy
        const playerClub = player.currentClub.toLowerCase();
        const academyLower = academy.toLowerCase();
        const destLower = (typeof destination === "string" ? destination : "").toLowerCase();

        // If the player's club is NOT the academy AND NOT the destination, flag it
        if (!playerClub.includes(academyLower) && !playerClub.includes(destLower)) {
          errors.push(
            `Detail references "${academy}" pipeline — ${player.name} plays for ${player.currentClub}, not associated with ${academy}`
          );
        }
      }
    }
  }

  // Confusion risk check
  if (player.confusionRisk && intelItem.rumor && intelItem.rumor.detail) {
    const detail = intelItem.rumor.detail.toLowerCase();
    // Extract club from confusionRisk format: "Name (b.YYYY, Club)"
    const clubMatch = player.confusionRisk.match(/,\s*(.+?)\)/);
    if (clubMatch) {
      const confusedClub = clubMatch[1].toLowerCase();
      if (detail.includes(confusedClub)) {
        errors.push(
          `Detail mentions "${clubMatch[1]}" from confusion risk: ${player.confusionRisk}`
        );
      }
    }
    // Also check for specific keywords in confusionRisk
    const riskLower = player.confusionRisk.toLowerCase();
    // Extract key entities from confusionRisk (things in parentheses, academy names)
    const riskEntities = player.confusionRisk.match(/\b[A-Z][a-z]+ (?:to|of|du|de) [A-Z][a-z]+\b/g) || [];
    for (const entity of riskEntities) {
      if (detail.includes(entity.toLowerCase()) &&
          !player.currentClub.toLowerCase().includes(entity.toLowerCase())) {
        errors.push(
          `Detail references "${entity}" mentioned in confusionRisk for ${player.name}`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── 3. Improved duplicate detection ──────────────────────────────────
export function isDuplicate(newRumour, existingRumours) {
  const normNewClub = normalizeClub(newRumour.club);

  return existingRumours.some(r => {
    // Exact match
    if (r.date === newRumour.date && r.club === newRumour.club && r.detail === newRumour.detail) {
      return true;
    }

    // Normalized match: same date + same club (after normalization)
    const normExistClub = normalizeClub(r.club);
    if (r.date === newRumour.date && normNewClub === normExistClub) {
      // Check detail word overlap (>60% = likely duplicate)
      const newWords = new Set(newRumour.detail.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const existWords = new Set(r.detail.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const overlap = [...newWords].filter(w => existWords.has(w)).length;
      const maxLen = Math.max(newWords.size, existWords.size);
      if (maxLen > 0 && (overlap / maxLen) > 0.6) return true;
    }

    return false;
  });
}

// ── 4. Tier consistency check (soft) ─────────────────────────────────
export function validateTierConsistency(rumour) {
  const warnings = [];
  const sourceLower = (rumour.source || "").toLowerCase();

  // Check T1 source mislabeled as T3/T4
  const isT1Source = TIER_1_KEYWORDS.some(k => sourceLower.includes(k));
  if (isT1Source && rumour.tier >= 3) {
    warnings.push(`Source "${rumour.source}" appears to be T1/T2 but labeled Tier ${rumour.tier}`);
  }

  // Check T4-ish source labeled as T1
  const isT4Source = TIER_4_KEYWORDS.some(k => sourceLower.includes(k));
  if (isT4Source && rumour.tier === 1) {
    warnings.push(`Source "${rumour.source}" appears speculative but labeled Tier 1`);
  }

  // Check known T2 sources labeled T4
  const isT2Source = TIER_2_KEYWORDS.some(k => sourceLower.includes(k));
  if (isT2Source && rumour.tier === 4) {
    warnings.push(`Source "${rumour.source}" is a known reliable source but labeled Tier 4`);
  }

  return { valid: warnings.length === 0, warnings };
}

// ── 5. Validate escalation ───────────────────────────────────────────
const VALID_STATUSES = ["active", "confirmed", "monitoring", "no_rumours"];
const VALID_TIERS = ["A", "B", "C"];

export function validateEscalation(esc, playersData) {
  const errors = [];
  const player = playersData.players.find(p => p.id === esc.playerId);
  if (!player) {
    errors.push(`Player ID ${esc.playerId} not found`);
    return { valid: false, errors };
  }
  if (esc.field === "status" && !VALID_STATUSES.includes(esc.newValue)) {
    errors.push(`Invalid status "${esc.newValue}" — must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  return { valid: errors.length === 0, errors };
}

export function validateTierChange(tc, playersData) {
  const errors = [];
  const player = playersData.players.find(p => p.id === tc.playerId);
  if (!player) {
    errors.push(`Player ID ${tc.playerId} not found`);
    return { valid: false, errors };
  }
  if (!VALID_TIERS.includes(tc.newTier)) {
    errors.push(`Invalid tier "${tc.newTier}" — must be A, B, or C`);
  }
  return { valid: errors.length === 0, errors };
}
