/**
 * Slippage canonicalization for the prequote match-hash. Shared by BOTH the
 * record path (reads the QUOTE params) and the gate path (reads the EXECUTE
 * params) so a quote↔execute that both omit slippage collide while differing
 * values diverge. Kept in ONE module so the two sides can never drift.
 *
 * The hash material is a security surface: two DIFFERENT applied slippages must
 * never produce the same digest, or the gate authorises a pair it never
 * compared. Nothing here may therefore round, floor, truncate, or default an
 * out-of-contract value into hash material — an invalid slippage THROWS, which
 * both callers already treat as fail-closed (the recorder skips the row, so the
 * gate then blocks for want of a prequote; the gate blocks directly).
 */

import { VexError, ErrorCodes } from "../../../../errors.js";

/**
 * Canonicalize a slippage value for the match-hash.
 *
 * A whole, non-negative number → its integer string (so `50` and a `"50"`-derived
 * `50` collide). `null`/`undefined` → the stable sentinel `""` (a quote-omitted
 * and an execute-omitted slippage collide).
 *
 * A present-but-invalid value (fractional, negative, non-finite) THROWS. It
 * previously went through `String(Math.trunc(value))`, which collapsed `0.5`
 * and `0.9` to the SAME `"0"`: the digests collided and the gate passed a pair
 * whose applied slippage differed by 40 bps. Truncation also silently reads a
 * caller's `0.5` (meaning 0.5%) as 0 bps. Neither may be inferred at a
 * price-protection boundary, so the identity is refused instead.
 */
export function canonSlippageBps(value: number | null | undefined): string {
  if (value == null) return "";
  if (!Number.isInteger(value) || value < 0) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      "slippageBps must be a whole, non-negative number of basis points.",
    );
  }
  return String(value);
}

/**
 * Canonicalize a slippage value that has a HANDLER DEFAULT when omitted (the
 * Pendle identities: the handler substitutes its own default, so the identity
 * must bind that same default or a quote-without-slippage would not authorize
 * an execute-without-slippage).
 *
 * ABSENT (`undefined`/`null`) → the default. PRESENT → canonicalized strictly,
 * throwing on a fractional/negative value. A present value of the WRONG TYPE
 * (a string, a boolean) also throws: previously it silently fell back to the
 * default and folded that default into the digest, so `slippageBps: "9999"`
 * hashed identically to an omitted slippage.
 */
export function canonSlippageBpsWithDefault(
  params: Record<string, unknown>,
  defaultBps: number,
): string {
  const raw = params.slippageBps;
  if (raw === undefined || raw === null) return canonSlippageBps(defaultBps);
  if (typeof raw !== "number") {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      "slippageBps must be a number of basis points.",
    );
  }
  return canonSlippageBps(raw);
}

/**
 * Read `slippageBps` from a tool's PARAMS for the swap match-hash. Both swap
 * quotes (kyber/jupiter) and both EVM executes type slippageBps as a number;
 * anything non-numeric (absent / wrong type) is treated as omitted (null) so the
 * canonicalizer maps it to the stable "" sentinel. Bound from params on BOTH
 * sides (recorder reads the quote params, gate reads the execute params) so a
 * quote↔execute that both omit slippage collide while differing values diverge.
 */
export function readParamSlippageBps(params: Record<string, unknown>): number | null {
  const raw = params.slippageBps;
  return typeof raw === "number" ? raw : null;
}
