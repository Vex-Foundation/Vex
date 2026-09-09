/**
 * Uniswap namespace shared types.
 */

import type { Address } from "viem";

export type UniswapVersion = "v2" | "v3" | "v4";

/** Resolved token leg for a swap (native input/output wraps to WETH for routing). */
export interface UniswapToken {
  /** The routed address — WETH for a native leg, else the ERC-20 contract. */
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** True when the user leg is native ETH (routed as WETH, wrapped/unwrapped by the router). */
  readonly isNative: boolean;
}

/**
 * A concrete route the quoter found. `path` is the ordered list of token
 * addresses (routed form — WETH for native legs). `fees` (V3 only) is the
 * per-hop fee tier, aligned with the hops in `path`.
 */
interface UniswapRouteAmounts {
  readonly path: readonly Address[];
  readonly fees?: readonly number[];
  readonly amountOut: bigint;
  /** QuoterV2 gas estimate (V3 only; V2 quotes carry no gas estimate). */
  readonly gasEstimate?: bigint;
}

export type UniswapRoute = UniswapRouteAmounts & (
  | { readonly version: "v2" | "v3" }
  | { readonly version: "v4"; readonly v4: import("./v4-types.js").V4RouteBinding }
);

/** Full quote payload returned by the quote engine + handler. */
export interface UniswapQuote {
  readonly chainId: number;
  readonly route: UniswapRoute;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
  /** Best-effort price impact (fraction, e.g. 0.012 = 1.2%); undefined when not computed. */
  readonly priceImpact?: number;
  /** The router that must be approved + called for this route. */
  readonly router: Address;
  /** ERC-20 spender to approve for a token input (== router). Undefined for native input. */
  readonly spender?: Address;
}
