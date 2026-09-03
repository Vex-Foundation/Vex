/**
 * The tolerance resolution both `kyberswap.swap.quote` and
 * `kyberswap.swap.execute` apply - deliberately ONE owner, because a quote
 * that resolved slippage differently from the execute would authorize a
 * tolerance the execute refuses.
 */

import { KYBERSWAP_MAX_SLIPPAGE_BPS } from "@tools/kyberswap/constants.js";
import { checkSlippageBps, VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { num } from "../../../handler-helpers.js";

/**
 * Resolve the slippage this call will apply, or a rejection reason.
 *
 * `slippageBps` is BOTH the number handed to `/route/build` and the number the
 * build's embedded floor is re-derived from, so it is resolved identically at
 * quote time and execute time - an omitted value takes the SAME venue default
 * on both sides, which is what lets a quote-without-slippage authorize an
 * execute-without-slippage. That default is Vex-wide
 * ({@link VEX_DEFAULT_SLIPPAGE_BPS}), not a KyberSwap fact. It is also the ONLY price protection on this
 * trade: the Vex ceiling is applied here (and only here for this venue), while
 * the manifest `unit: "bps"` gate proves integrality but deliberately applies
 * no maximum.
 */
export function resolveKyberSlippageBps(
  toolId: string,
  p: Record<string, unknown>,
): { readonly ok: true; readonly bps: number } | { readonly ok: false; readonly reason: string } {
  const raw = num(p, "slippageBps");
  const bps = raw ?? VEX_DEFAULT_SLIPPAGE_BPS;
  const violation = checkSlippageBps(
    `Parameter "slippageBps" for ${toolId}`,
    bps,
    KYBERSWAP_MAX_SLIPPAGE_BPS,
  );
  return violation ? { ok: false, reason: violation } : { ok: true, bps };
}
