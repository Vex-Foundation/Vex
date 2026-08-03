/**
 * Pendle LP identity families: the single-token add/remove (P5) and the R5d
 * variants — dual remove, keep-YT add, market transfer, and LP→PT.
 */

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Pendle LP single-token ADD trade identity (P5). Adding single-token liquidity
 * (token → LP) is its OWN kind — not a swap, mint, or redeem: it deposits ONE
 * payment token into a Pendle market and receives the LP token. Computed
 * IDENTICALLY at the `pendle.lp.quote` (direction "add") record-time and the
 * `pendle.lp.add` EXECUTE gate-time — both bind the MARKET (the LP anchor)
 * directly (never resolved from a PT), so the digests collide.
 *
 * Direction is structurally unmixable from a remove: `lp_add` and `lp_remove` are
 * DISTINCT kinds, so an add quote can never authorize a remove execute (and
 * vice-versa) even for the same market/amount. Material (FIXED order): ["lp_add",
 * sessionId, provider, chainId, wallet, receiver, market, tokenIn, amount,
 * slippageBps]. Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
export interface LpAddMatchInput {
  readonly kind: "lp_add";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the minted LP lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is added to. */
  readonly market: string;
  /** Payment token deposited. */
  readonly tokenIn: string;
  /** Human decimal amount of tokenIn. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP single-token REMOVE trade identity (P5). Removing single-token
 * liquidity (LP → token) is its OWN kind. Computed IDENTICALLY at the
 * `pendle.lp.quote` (direction "remove") record-time and the `pendle.lp.remove`
 * EXECUTE gate-time — both bind the MARKET directly. It carries `tokenOut` (the
 * output token; a remove can target any token, default = the market's underlying),
 * bound so a divergent output blocks. Material (FIXED order): ["lp_remove",
 * sessionId, provider, chainId, wallet, receiver, market, tokenOut, amount,
 * slippageBps].
 */
export interface LpRemoveMatchInput {
  readonly kind: "lp_remove";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the withdrawn token lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is removed from. */
  readonly market: string;
  /** Output token (default = the market's underlyingAsset; can be overridden). */
  readonly tokenOut: string;
  /** Human decimal amount of the LP token to remove. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle DUAL LP remove identity (R5d). `LP → (token, PT)` — two output legs,
 * where `lp_remove` has one. Its own kind, never `lp_remove`: the two actions
 * take the same market and the same LP amount, so a shared kind would let a
 * single-token remove quote authorize a dual remove execute (and vice-versa),
 * substituting an entirely different output shape and a different price floor.
 *
 * Material (FIXED order): ["lp_remove_dual", sessionId, provider, chainId,
 * wallet, receiver, market, tokenOut, amount, slippageBps]. The PT output leg is
 * NOT a free parameter — it is the market's own PT — so binding `market` binds
 * it; `tokenOut` is the leg the caller can vary.
 */
export interface LpRemoveDualMatchInput {
  readonly kind: "lp_remove_dual";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where both output legs land (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is removed from. */
  readonly market: string;
  /** The TOKEN output leg (the PT leg is the market's own PT, bound via `market`). */
  readonly tokenOut: string;
  /** Human decimal amount of the LP token to remove. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle KEEP-YT LP add identity (R5d). `token → (LP, YT)` — two output legs,
 * where `lp_add` has one. Its own kind, never `lp_add`: same market, same token,
 * same amount, so a shared kind would let a plain add quote authorize a keep-YT
 * execute, which returns a materially different position.
 *
 * Material (FIXED order): ["lp_add_keep_yt", sessionId, provider, chainId,
 * wallet, receiver, market, tokenIn, amount, slippageBps]. The YT output leg is
 * the market's own YT, bound via `market`.
 */
export interface LpAddKeepYtMatchInput {
  readonly kind: "lp_add_keep_yt";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the LP + YT land (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) liquidity is added to. */
  readonly market: string;
  /** Payment token deposited. */
  readonly tokenIn: string;
  /** Human decimal amount of tokenIn. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP TRANSFER identity (R5d). `LP(market A) → LP(market B)` — liquidity
 * moved between markets. Its own kind for the same reason as the rollover: both
 * markets are free parameters and both must be bound.
 *
 * Material (FIXED order): ["lp_transfer", sessionId, provider, chainId, wallet,
 * receiver, fromMarket, toMarket, amount, slippageBps].
 *
 * NO `keepYt` FIELD. The R5d card allowed one "if shipped"; it is not — no
 * `keepYt` param exists on any manifest, handler or client body in the tree
 * (`transfer-liquidity` was live-probed as `[LP(mktA)] → [LP(mktB)]`, a single
 * output leg). An identity field for a parameter the execute cannot carry would
 * bind nothing and read as though it did. If a keep-YT transfer ever ships, it
 * belongs here as a bound field BEFORE the handler accepts the param.
 */
export interface LpTransferMatchInput {
  readonly kind: "lp_transfer";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the destination LP lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The market liquidity is withdrawn from. */
  readonly fromMarket: string;
  /** The market liquidity is deposited into. */
  readonly toMarket: string;
  /** Human decimal amount of the source LP token. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP→PT identity (R5d). `LP → PT` within one market. Its own kind: the
 * output is a PT, not a token, so it can never share `lp_remove`'s material
 * without letting a token-out quote authorize a PT-out execute.
 *
 * Material (FIXED order): ["lp_to_pt", sessionId, provider, chainId, wallet,
 * receiver, market, ptOut, amount, slippageBps]. `ptOut` is bound EXPLICITLY
 * even though it is the market's own PT: the two are resolved independently on
 * the record and the gate side, and binding both makes a divergent resolution a
 * block instead of a silent agreement.
 */
export interface LpToPtMatchInput {
  readonly kind: "lp_to_pt";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the PT lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The Pendle market (== the LP token) being converted. */
  readonly market: string;
  /** The PT received (the market's PT; bound explicitly — see the doc). */
  readonly ptOut: string;
  /** Human decimal amount of the LP token to convert. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle LP ADD material (P5, FIXED order). Venue `provider` is bound so an add
 * quote can never authorize a non-Pendle execute. The full execute-variance
 * surface is bound: market / tokenIn / chainId / slippage / receiver all feed the
 * digest, so any divergence blocks. The distinct `lp_add` kind tag makes the
 * direction structurally unmixable from a remove. Addresses EVM (lowercased);
 * `amount` via `canonAmount`.
 */
export function lpAddHashMaterial(input: LpAddMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenIn),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP REMOVE material (P5, FIXED order). Mirrors the add material but binds
 * `tokenOut` (a remove can target any token) instead of `tokenIn`, and carries the
 * distinct `lp_remove` kind tag so a remove quote can never authorize an add (or
 * vice-versa). Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
export function lpRemoveHashMaterial(input: LpRemoveMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenOut),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle DUAL LP remove material (R5d, FIXED order). Mirrors `lp_remove`'s field
 * order exactly, so the ONLY difference between the two digests is the kind tag —
 * which is what makes a single-token remove quote unable to authorize a dual
 * remove execute. Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
export function lpRemoveDualHashMaterial(input: LpRemoveDualMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenOut),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle KEEP-YT LP add material (R5d, FIXED order). Mirrors `lp_add`'s field
 * order exactly; the kind tag is the only divergence, so a plain add quote can
 * never authorize a keep-YT execute for the same market/token/amount.
 */
export function lpAddKeepYtHashMaterial(input: LpAddKeepYtMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.tokenIn),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP transfer material (R5d, FIXED order). BOTH markets are bound, in a
 * fixed source→destination order, so a transfer into one market can never
 * authorize a transfer into another, and the reverse direction hashes
 * differently.
 */
export function lpTransferHashMaterial(input: LpTransferMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.fromMarket),
    canonAddress("eip155", input.toMarket),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle LP→PT material (R5d, FIXED order). Binds the market AND the PT output
 * leg; see {@link LpToPtMatchInput} for why both.
 */
export function lpToPtHashMaterial(input: LpToPtMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.market),
    canonAddress("eip155", input.ptOut),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}
