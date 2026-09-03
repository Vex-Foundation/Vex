/**
 * Resolve the slippage this call applies, or Vex's rejection reason.
 *
 * The manifest `unit: "bps"` gate (`runtime/bps-param.ts`) proves the value is a
 * whole, non-negative number of basis points but deliberately applies no
 * maximum; the maximum is product policy with one owner
 * (`slippage-policy.ts`). No `venueMaxBps` is passed - Uniswap publishes no
 * venue maximum below Vex's ceiling (`applySlippage` is pure arithmetic over
 * `[0, 10000]`), so the ceiling binds on its own.
 *
 * REJECTED, never clamped. `applySlippage` used to fold an out-of-range value
 * to 10,000 bps, which silently authorised a total-loss tolerance instead of
 * surfacing the caller's mistake - the same failure class as silently dropping
 * a caller-supplied fee parameter. Resolved identically for the quote and the
 * execute so the pair cannot disagree about what was authorised.
 */

import { checkSlippageBps, VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

import { num } from "../../../handler-helpers.js";

export function resolveUniswapSlippageBps(
  handlerToolId: string,
  p: Record<string, unknown>,
): { readonly ok: true; readonly bps: number } | { readonly ok: false; readonly reason: string } {
  const bps = num(p, "slippageBps") ?? VEX_DEFAULT_SLIPPAGE_BPS;
  const violation = checkSlippageBps(`Parameter "slippageBps" for ${handlerToolId}`, bps);
  return violation ? { ok: false, reason: violation } : { ok: true, bps };
}
