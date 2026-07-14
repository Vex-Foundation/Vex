/**
 * Mission patch parser — safe boundary between model output and DB write.
 *
 * Model output is treated as `unknown` (untrusted).
 * Pipeline: extractMissionPatch() → sanitizePatch() → Partial<MissionDraft>
 * Then mapper.domainToRow() → Partial<MissionDraftRow> → repo.updateDraft()
 *
 * Puzzle 04: `stopConditionsAccepted` was removed from MissionDraft and
 * from the allowed-keys allowlist below. Acceptance is host-only via
 * `mission.acceptContract` IPC + `missions.accepted_contract_hash` (mig
 * 023). Any model attempt to set acceptance via prose JSON or tool args
 * is silently dropped at the boundary — see the patch-parser test for
 * the security regression guard.
 */

import { hyperliquidMissionRiskSchema } from "../../../lib/hyperliquid-policy.js";
import type { MissionDraft, MissionPatch } from "../types.js";

// ── Allowed keys ────────────────────────────────────────────────

const ALLOWED_STRING_KEYS = new Set<keyof MissionDraft>([
  "title", "goal", "capitalSource", "startingCapital",
  "riskProfile", "deadline",
]);

const ALLOWED_ARRAY_KEYS = new Set<keyof MissionDraft>([
  "allowedWallets", "allowedChains", "allowedProtocols",
  "successCriteria", "stopConditions",
]);

const ALL_ALLOWED_KEYS = new Set<string>([
  ...ALLOWED_STRING_KEYS,
  ...ALLOWED_ARRAY_KEYS,
  "hyperliquidRisk",
]);

/** Max string field length (prevents unbounded model output). */
const MAX_STRING_LENGTH = 2000;
/** Max array items per field. */
const MAX_ARRAY_ITEMS = 50;
/** Max string length per array item. */
const MAX_ARRAY_ITEM_LENGTH = 500;

// ── Extract ─────────────────────────────────────────────────────

/**
 * Extract a mission patch from raw model output.
 * Returns null if the input is not a valid object.
 */
export function extractMissionPatch(raw: unknown): MissionPatch | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;
  const patch: MissionPatch = {};
  let hasValidKey = false;

  for (const [key, value] of Object.entries(obj)) {
    if (!ALL_ALLOWED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    patch[key] = value;
    hasValidKey = true;
  }

  return hasValidKey ? patch : null;
}

// ── Sanitize ────────────────────────────────────────────────────

/**
 * Sanitize a mission patch into typed Partial<MissionDraft>.
 * - Trims strings, enforces length limits
 * - Validates array items are strings
 * - Rejects values with wrong types
 */
export function sanitizePatch(patch: MissionPatch): Partial<MissionDraft> {
  const result: Partial<MissionDraft> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (ALLOWED_STRING_KEYS.has(key as keyof MissionDraft)) {
      const sanitized = sanitizeString(value);
      if (sanitized !== undefined) {
        (result as Record<string, unknown>)[key] = sanitized;
      }
    } else if (ALLOWED_ARRAY_KEYS.has(key as keyof MissionDraft)) {
      const sanitized = sanitizeStringArray(value);
      if (sanitized !== undefined) {
        (result as Record<string, unknown>)[key] = sanitized;
      }
    } else if (key === "hyperliquidRisk") {
      const parsed = value === null
        ? { success: true as const, data: null }
        : hyperliquidMissionRiskSchema.safeParse(value);
      if (parsed.success) result.hyperliquidRisk = parsed.data;
    }
  }

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────

function sanitizeString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined; // reject wrong type
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_STRING_LENGTH);
}

// ── Model output parser ─────────────────────────────────────────

/**
 * Parse model text response for structured mission data.
 * Looks for a JSON block (```json ... ```) or a raw JSON object in the text.
 * Returns the parsed object for extractMissionPatch(), or null if nothing found.
 */
export function parseModelMissionOutput(text: string): unknown {
  // Try ```json block first
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch { /* not valid JSON */ }
  }

  // Try raw JSON object in text (first { to last })
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch { /* not valid JSON */ }
  }

  return null;
}

function sanitizeStringArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined; // reject wrong type

  const items: string[] = [];
  for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
    if (typeof item !== "string") continue; // skip non-string items
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    items.push(trimmed.slice(0, MAX_ARRAY_ITEM_LENGTH));
  }

  return items.length > 0 ? items : null;
}
