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

import type { DeployedCapital, MissionDraft, MissionPatch } from "../types.js";
import { normalizeDeployedCapital } from "./deployed-capital.js";

// ── Allowed keys ────────────────────────────────────────────────

const ALLOWED_STRING_KEYS = new Set<keyof MissionDraft>([
  "title", "goal", "capitalSource", "startingCapital",
  "riskProfile", "deadline",
]);

const ALLOWED_ARRAY_KEYS = new Set<keyof MissionDraft>([
  "allowedWallets", "allowedChains", "allowedProtocols",
  "successCriteria", "stopConditions",
]);

/**
 * `durationMinutes` is model-set NUMERIC data (a whole-minute time-box), not
 * a string — it must not go through `ALLOWED_STRING_KEYS`/`sanitizeString`,
 * which rejects any non-string typeof and would silently drop every numeric
 * value (the run then falls back to the 60-minute default with no signal to
 * the model or the operator).
 */
const ALLOWED_NUMBER_KEYS = new Set<keyof MissionDraft>(["durationMinutes"]);

/**
 * `deployedCapital` is a nested OBJECT, so it can go through neither the string
 * nor the array nor the number sanitizer. It is normalized as a whole by the
 * one shared normalizer in `deployed-capital.ts`.
 *
 * It is deliberately NOT in `MODEL_FORBIDDEN_KEYS`. It is a DECLARATION, not a
 * fee, limit or destination: nothing refuses a spend because of it, so rule
 * 90's model-input prohibition does not attach. It is exactly as model-writable
 * as `startingCapital` already is, and any write clears acceptance
 * (`setup.ts`), so the user re-reads the number before it can bind again.
 */
const ALLOWED_OBJECT_KEYS = new Set<keyof MissionDraft>(["deployedCapital"]);

/**
 * DELIBERATELY NOT ALLOWED — do not add these, whatever a later task seems to
 * need (contract C6).
 *
 * `maxLaunchValueRaw` / `maxLaunchValueDecimals` are the hard spend ceiling on
 * an autonomous token launch, and `maxLaunchCount` is the hard cap on how many
 * tokens it may create. Rule 90: "fee, limit, and destination parameters
 * must never originate from model input." A model that can raise its own cap
 * has no cap — the field would look like a control and enforce nothing, which
 * is worse than having none, because the UI would show the user a limit that
 * does not bind.
 *
 * They are HOST-AUTHORED ONLY. The model READS its ceiling through
 * `draftToPromptContext` and chooses an amount up to it. Pinned by
 * `mission/patch-parser-launch-ceiling.test.ts`.
 */
const MODEL_FORBIDDEN_KEYS = new Set<keyof MissionDraft>([
  "maxLaunchValueRaw",
  "maxLaunchValueDecimals",
  "maxLaunchCount",
]);

const ALL_ALLOWED_KEYS = new Set<string>(
  [
    ...ALLOWED_STRING_KEYS,
    ...ALLOWED_ARRAY_KEYS,
    ...ALLOWED_NUMBER_KEYS,
    ...ALLOWED_OBJECT_KEYS,
  ].filter((key) => !MODEL_FORBIDDEN_KEYS.has(key)),
);

export { MODEL_FORBIDDEN_KEYS };

/** Max string field length (prevents unbounded model output). */
const MAX_STRING_LENGTH = 2000;
/** Max array items per field. */
const MAX_ARRAY_ITEMS = 50;
/** Max string length per array item. */
const MAX_ARRAY_ITEM_LENGTH = 500;
/** Ceiling for `durationMinutes` — mirrors the 24h hard-deadline clamp. */
const MAX_DURATION_MINUTES = 1440;

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
    } else if (ALLOWED_NUMBER_KEYS.has(key as keyof MissionDraft)) {
      const sanitized = sanitizeDurationMinutes(value);
      if (sanitized !== undefined) {
        (result as Record<string, unknown>)[key] = sanitized;
      }
    } else if (ALLOWED_OBJECT_KEYS.has(key as keyof MissionDraft)) {
      const sanitized = sanitizeDeployedCapital(value);
      if (sanitized !== undefined) {
        (result as Record<string, unknown>)[key] = sanitized;
      }
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

/**
 * Sanitize the mission's `durationMinutes` time-box: a positive whole-number
 * minute count, clamped to `MAX_DURATION_MINUTES`. Rejects the wrong type
 * (including numeric strings — the model must send a JSON number) and
 * non-positive/non-finite values so a bad value falls through to the
 * env/60-minute default instead of persisting garbage.
 */
function sanitizeDurationMinutes(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  const wholeMinutes = Math.trunc(value);
  if (wholeMinutes < 1) return undefined;
  return Math.min(wholeMinutes, MAX_DURATION_MINUTES);
}

/**
 * Sanitize the C3 deployed-capital declaration.
 *
 * Three outcomes, and the middle one is the deliberate part:
 *   - `null` (the model's explicit clear) is PRESERVED and written as absent;
 *   - a non-object is REJECTED (`undefined`, no key in the result, no write) -
 *     a wrong-typed value is a mistake, not an instruction to clear;
 *   - an object is normalized as a whole and a MALFORMED one lands as `null`
 *     rather than being dropped. A half-typed capital that silently persisted
 *     would be worse than none: the draft would carry a denominator nobody can
 *     read, and the measurability warnings would go quiet as if it were fine.
 */
function sanitizeDeployedCapital(value: unknown): DeployedCapital | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return normalizeDeployedCapital(value);
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
