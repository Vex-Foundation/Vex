/**
 * The string spelling of a DECLARED-NUMBER param.
 *
 * WHY THIS EXISTS. A live session (2026-07-30) called
 * `execute_tool {toolId: "dexscreener.search", query: "robinhood", limit: "10"}`.
 * Once the flat-args lift put `limit` in the params bag (see `./flat-args.ts`),
 * the strict gate answered `expected number, got string` — correct, and still a
 * burnt call over a value that means exactly one number and nothing else. JSON
 * tool-call arguments are stringly-typed at the model's end often enough that
 * `"10"` for a count is a spelling mistake, not an intent mistake.
 *
 * WHY THIS IS SAFE ON A MONEY REPO. Amounts here travel as STRING params by
 * design (rule 90: a raw amount must carry its own precision and must not pass
 * through a float), so a param the manifest DECLARED `type: "number"` is
 * structurally non-monetary — limits, counts, offsets, thresholds, page
 * numbers, ids. This module only ever looks at declared-number params, so no
 * amount is in its reach. That invariant was FALSE when this was written:
 * `solana.swap.quote/execute` declared `amount` as `type: "number"` (human
 * decimals) and converted it through `uiAmount * 10 ** decimals`. W5a renamed
 * it to `amountIn`, typed it `string`, and deleted the float multiply, so the
 * sentence above is now true of the whole fleet rather than aspirational.
 * Proven by
 * `src/__tests__/vex-agent/tools/protocol-param-numeric-string.test.ts`.
 *
 * LOSSLESS ONLY, AND THE TEST IS THE ROUND-TRIP. A string is rewritten only
 * when `String(Number(trimmed)) === trimmed` — the number, printed back,
 * reproduces exactly what was sent. That admits `"10"`, `"0"`, `"-3"`, `"2.5"`
 * and refuses every ambiguous or lossy spelling: `""`, `"0x10"`, `"1,000"`,
 * `"010"`, `"2.50"`, `"1e3"`, `"10.5abc"`, `"NaN"`, `"Infinity"`. A refused
 * value is left exactly as the model sent it, so the unchanged
 * `validateProtocolParams` gate — with its type, range, and unit contracts —
 * still runs after this and still names the real problem. Nothing ambiguous is
 * ever guessed at: a near-miss costs the same precise error it costs today.
 *
 * Booleans and every other declared type are out of scope by construction.
 */

import type { ProtocolToolManifest } from "../types.js";

export interface NumericCoercedParams {
  /** A NEW object when something was coerced; the input reference otherwise. */
  readonly params: Record<string, unknown>;
  readonly coercedKeys: readonly string[];
}

/**
 * The number a string losslessly spells, or `null` to leave the value alone.
 *
 * Exported because `ToolSearch` needs the identical admit/refuse rule: it
 * is a meta-tool with no manifest, so it cannot go through
 * `coerceNumericStringParams`, and a second hand-rolled "is this a number"
 * would be the same decision made twice and drifting apart.
 */
export function parseLosslessNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return String(parsed) === trimmed ? parsed : null;
}

export function coerceNumericStringParams(
  manifest: ProtocolToolManifest,
  params: Record<string, unknown>,
): NumericCoercedParams {
  const coercedKeys: string[] = [];
  const coerced: Record<string, number> = {};

  for (const param of manifest.params) {
    if (param.type !== "number") continue;
    const value = params[param.key];
    if (typeof value !== "string") continue;
    const parsed = parseLosslessNumber(value);
    if (parsed === null) continue;
    coerced[param.key] = parsed;
    coercedKeys.push(param.key);
  }

  if (coercedKeys.length === 0) return { params, coercedKeys: [] };
  return { params: { ...params, ...coerced }, coercedKeys };
}
