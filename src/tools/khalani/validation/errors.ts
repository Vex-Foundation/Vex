/**
 * Khalani error-body parser + Solana address heuristic (codex-002 Phase 2).
 *
 * `parseKhalaniErrorBody` is the lenient (never-throw) error-body validator;
 * `isSolanaAddressLike` is the base58 address heuristic. Both are imported by
 * the Khalani client/helpers, so they stay on the public barrel. Moved verbatim
 * from `validation.ts`.
 */

import { z } from "zod";
import type { KhalaniErrorBody } from "../types.js";
import { isRecordValue } from "./_shared.js";

// ---------------------------------------------------------------------------
// Error body (lenient: null on bad input)
// ---------------------------------------------------------------------------

/**
 * Lenient error-body reader. Returns `null` only when the payload carries NO
 * usable signal at all — not when a field the provider treats as optional is
 * absent (W2d).
 *
 * Before W2d this demanded `message` AND `name` together, so a `{"message":"…"}`
 * gateway body and any `name`-less JSON became `null` and the agent was handed
 * `Khalani API error (HTTP 400)` instead of the provider's sentence. `name` is
 * a CLASSIFIER, not a precondition for reading the reason.
 */
export function parseKhalaniErrorBody(raw: unknown): KhalaniErrorBody | null {
  const result = z
    .unknown()
    .transform((v): KhalaniErrorBody | null => {
      if (!isRecordValue(v)) return null;
      const message = typeof v.message === "string" ? v.message : undefined;
      const name = typeof v.name === "string" ? v.name : undefined;
      const details =
        Array.isArray(v.details) || isRecordValue(v.details)
          ? (v.details as KhalaniErrorBody["details"])
          : undefined;
      if (message === undefined && name === undefined && details === undefined) return null;
      return { message, name, details };
    })
    .safeParse(raw);
  // The transform never fails, so success is always true.
  return result.success ? result.data : null;
}

/**
 * The RAW response text → an error body, for clients that read the body
 * themselves instead of going through `readJson`.
 *
 * Exists because Khalani does not always answer JSON: live 2026-08-03,
 * `GET /v1/nope` returns `content-type: text/plain` with the body `404 Not
 * Found`. `response.json()` throws on that, `readJson` swallows the throw and
 * returns `null`, and the provider's own words never reach the agent. Reading
 * the payload as TEXT once and parsing it ourselves keeps both spellings.
 *
 * A non-JSON payload becomes `{ message: <the text> }` — no `name`, so the
 * classifier in `mapKhalaniError` treats it exactly like any unnamed body.
 */
export function parseKhalaniErrorPayload(rawText: string): KhalaniErrorBody | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  try {
    return parseKhalaniErrorBody(JSON.parse(trimmed));
  } catch {
    return { message: trimmed };
  }
}

export function isSolanaAddressLike(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
