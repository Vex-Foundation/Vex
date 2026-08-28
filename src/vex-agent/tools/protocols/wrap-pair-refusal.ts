/**
 * The one place a swap venue recognises that it was asked for a WRAP rather
 * than a trade, and says so by name.
 *
 * A native <-> wrapped-native pair is not a route. The wrapped-native contract
 * mints and burns at par, so there is no price, no slippage and no liquidity
 * question - and every venue that pretends otherwise answers badly: KyberSwap
 * routes it through a `wrapped-native` pseudo-pool at roughly four times the
 * gas of a direct call, applies slippage to a 1:1 conversion, drifts a wei on
 * build, and cannot price either leg in USD (measured 2026-08-27, robinhood).
 * Uniswap cannot route it at all, because its own router treats the two as the
 * same asset.
 *
 * The refusal therefore names `WalletWrapPrepare`, the tool that does build the
 * conversion, instead of leaving the agent to read "no route" as "no liquidity"
 * and go looking for a venue that will quote it.
 *
 * IDENTITY IS THE VERIFIED CONTRACT, never the native flag alone. "One leg is
 * native" is true of most trades ever made; what makes this pair a wrap is that
 * the OTHER leg is the wrapped-native contract Vex verified for that exact
 * chain (`@tools/evm-chains/wrapped-native.ts`). A chain with no verified entry
 * yields no wrap claim, because the claim would be a guess about which contract
 * holds the user's deposit.
 */

import { isWrappedNativeContract } from "@tools/evm-chains/wrapped-native.js";

/** The minimum a venue must know about a resolved leg to classify the pair. */
export interface WrapPairLeg {
  readonly address: string;
  readonly isNative: boolean;
}

/**
 * True when this is the canonical native <-> wrapped-native pair on `chainId`:
 * exactly one native leg, and the other leg is the verified wrapped-native
 * contract for that chain.
 */
export function isCanonicalWrapPair(
  chainId: number,
  tokenIn: WrapPairLeg,
  tokenOut: WrapPairLeg,
): boolean {
  if (tokenIn.isNative === tokenOut.isNative) return false;
  const wrapped = tokenIn.isNative ? tokenOut : tokenIn;
  return isWrappedNativeContract(chainId, wrapped.address);
}

/**
 * The agent-facing refusal for a canonical wrap pair, or `null` when the pair is
 * an ordinary trade. `venue` is the venue's own tool id, so the sentence says
 * which surface declined.
 */
export function canonicalWrapPairRefusal(
  chainId: number,
  tokenIn: WrapPairLeg,
  tokenOut: WrapPairLeg,
  venue: string,
): string | null {
  if (!isCanonicalWrapPair(chainId, tokenIn, tokenOut)) return null;
  const direction = tokenIn.isNative ? "native into its wrapped form" : "wrapped-native back into native";
  return (
    `${venue} refused this pair: converting ${direction} is not a trade. The wrapped-native contract on `
    + `chain ${chainId} mints and burns at exactly 1:1, so there is no route, no price and no slippage to quote, `
    + `and routing it through a swap venue only adds gas and a rounding loss. Use WalletWrapPrepare, which builds `
    + `the conversion against the verified contract, then WalletWrapConfirm.`
  );
}
