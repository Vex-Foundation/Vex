/**
 * Trusted-field validators for the Pendle projector boundary (Wave-3 doctrine).
 *
 * The tolerant client validation (`@tools/pendle/validation.ts`) only narrows
 * TYPES — the VALUES are still untrusted hosted-API data. This module narrows
 * structural strings into TRUSTED SHAPES before they are projected into
 * model-facing tool output:
 *   - addresses — EVM `0x` + 40 hex, else null;
 *   - timestamps — must parse and are RE-SERIALIZED to canonical ISO (the output
 *     string is ours, not upstream's);
 *   - category ids — strict `[a-z0-9_-]` token, bounded;
 *   - numbers — finite + bounded, else null.
 *
 * Free-text (market names, PT symbols) goes through `sanitizeForSystemPrompt` +
 * a hard length cap. A hostile string in any structural field can never reach
 * the model — it degrades to null and the projector notes the drop.
 */

import { sanitizeForSystemPrompt } from "@vex-agent/engine/prompts/sanitize.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** EVM address (0x + 40 hex); anything else ⇒ null. */
export function trustedAddress(raw: string | null): string | null {
  if (!raw) return null;
  return EVM_ADDRESS.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Validate + RE-SERIALIZE a timestamp to canonical ISO — the output is produced
 * by `Date.toISOString()`, independent of the upstream bytes.
 */
export function trustedIsoTimestamp(raw: string | null): string | null {
  if (!raw || raw.length > 40) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Finite number within ±bound; else null. */
export function trustedNumber(raw: number | null, bound = 1e15): number | null {
  if (raw === null || !Number.isFinite(raw)) return null;
  if (raw > bound || raw < -bound) return null;
  return raw;
}

/** Strict lowercased category token: letters/digits/underscore/hyphen, bounded. */
export function trustedCategoryId(raw: string): string | null {
  if (!raw || raw.length > 40) return null;
  const lower = raw.toLowerCase();
  return /^[a-z0-9_-]+$/.test(lower) ? lower : null;
}

/** Bounded, injection-sanitized free text (symbols / names). */
export function trustedText(raw: string | null, maxLen = 64): string | null {
  if (!raw) return null;
  return sanitizeForSystemPrompt(raw.slice(0, maxLen));
}

/**
 * Filter + narrow a category-id list. NOT capped (W9d).
 *
 * It used to stop at 16. That cap was invisible and it fed a FILTER: a market
 * whose 17th category was the one an agent passed to `excludeCategories` came
 * back in the result set anyway. Each surviving id is already bounded by
 * `trustedCategoryId` (≤40 chars, `[a-z0-9_-]` only) and deduped here, so the
 * list is bounded by the vocabulary rather than by a number that hides rows.
 */
export function trustedCategoryIds(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of raw) {
    const id = trustedCategoryId(c);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}
