/**
 * Curve slippage floor for a Trench Express trade.
 *
 * The RBC bonding-curve `quote()` is DETERMINISTIC and FEE-INCLUSIVE (proven by
 * the funded live probe — a buy quote matched received tokens to the wei, a sell
 * quote matched received ETH to the wei). The ONLY thing that can move the
 * expected output between our fresh quote and our own broadcast is another trade
 * hitting the same curve first, so `min` is a front-running price floor.
 *
 * The tolerance is MODEL-ADJUSTABLE (`slippageBps`), mirroring the swap venues:
 * the deterministic curve fits a tight default, but a thin/volatile fresh curve
 * token can move between quote and broadcast, so the model may raise it. Vex
 * still computes the RAW `min` itself from OUR fresh quote (never a caller
 * number) and NEVER emits `min == 0` — the Diamond disables the slippage check
 * entirely at `min == 0`, so a zero floor would sign away all price protection.
 */

import { VexError, ErrorCodes } from "../../../errors.js";

// No default slippage lives here: `curveMinOut` takes an EXPLICIT `slippageBps`,
// and what an omitted value means is Vex product policy with one home
// (`@vex-agent/tools/protocols/slippage-policy.ts` `VEX_DEFAULT_SLIPPAGE_BPS`),
// resolved by `protocols/trench/handlers/trade/shared.ts` before calling in.

/** Hard cap on the model-supplied tolerance — 10%. Above this Vex REJECTS, never clamps. */
export const TRENCH_MAX_SLIPPAGE_BPS = 1000;
const BPS_DENOMINATOR = 10_000n;

/**
 * Compute the minimum acceptable output for a curve trade from OUR fresh quoted
 * expectation and the resolved `slippageBps`. Throws (never returns 0) when the
 * expected output is non-positive or so small the floor collapses to zero —
 * signing `min == 0` disables the contract's slippage guard entirely.
 */
export function curveMinOut(expectedOutRaw: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > TRENCH_MAX_SLIPPAGE_BPS) {
    throw new VexError(
      ErrorCodes.TRENCH_INVALID_REQUEST,
      `slippageBps must be a whole number of basis points between 0 and ${TRENCH_MAX_SLIPPAGE_BPS}.`,
    );
  }
  if (expectedOutRaw <= 0n) {
    throw new VexError(
      ErrorCodes.TRENCH_INVALID_RESPONSE,
      "Curve quote returned a non-positive expected output; refusing to trade.",
      "Re-quote the trade; the curve returned no usable expected output.",
    );
  }
  const min = (expectedOutRaw * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
  if (min <= 0n) {
    throw new VexError(
      ErrorCodes.TRENCH_INVALID_RESPONSE,
      "Curve trade amount is too small for a non-zero minimum output; refusing (a zero minimum disables slippage protection).",
      "Increase the trade amount — the amount is too small to trade safely on this curve.",
    );
  }
  return min;
}

/**
 * Absolute deadline (unix seconds) for a curve trade, set LOCALLY and never from
 * model input. The window is short because the curve is deterministic and the
 * broadcast is immediate.
 */
export const TRENCH_TRADE_DEADLINE_SECONDS = 900;

export function curveTradeDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + TRENCH_TRADE_DEADLINE_SECONDS);
}
