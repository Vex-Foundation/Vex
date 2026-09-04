/**
 * Pendle PY identity families (P4): the mint (token → PT+YT) and the pre-expiry
 * PY redeem (PT+YT → token).
 */

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Pendle PY mint trade identity (P4). A mint (token → PT+YT) is its OWN kind -
 * not a swap, bridge, or matured redeem: it acquires BOTH an equal PT and YT in
 * one transaction from a single payment token. Computed IDENTICALLY at the
 * `pendle.py.quote` (direction "mint") record-time and the `pendle.py.mint`
 * EXECUTE gate-time - both resolve the market (and its YT) from the PT anchor
 * through the SAME market lookup, so the digests collide.
 *
 * Material (FIXED order): ["mint", sessionId, provider, chainId, wallet, receiver,
 * tokenIn, amount, ptAddress, ytAddress, market, slippageBps]. Addresses are EVM
 * (lowercase); `amount` is the human decimal via `canonAmount`. The FULL execute-
 * variance surface is bound (Codex doctrine): a changed `tokenIn`, `slippageBps`,
 * or `chainId` produces a different digest → the gate BLOCKS.
 */
export interface MintMatchInput {
  readonly kind: "mint";
  readonly sessionId: string;
  /** VENUE binding - "pendle". A mint quote can never authorize another venue. */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the minted PT+YT land (defaults to the selected wallet). */
  readonly receiver: string;
  /** Payment token spent to mint. */
  readonly tokenIn: string;
  /** Human decimal amount of tokenIn. */
  readonly amount: string;
  /** PT anchor (the market is resolved from it). */
  readonly ptAddress: string;
  /** YT resolved from the PT's market (record + gate resolve it identically). */
  readonly ytAddress: string;
  /** The PT's canonical market/LP address (bound so the market is unmixable). */
  readonly market: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle PRE-EXPIRY PY redeem trade identity (P4). Burns an EQUAL PT+YT pair back
 * to a token BEFORE expiry - distinct from the matured-PT `redeem` (PT only). It
 * extends the redeem material with an explicit `outputToken` (the matured redeem
 * always outputs the underlying; a pre-expiry redeem can output any token, so it
 * must be bound). Computed IDENTICALLY at `pendle.py.quote` (direction "redeem")
 * record-time and the `pendle.py.redeem` EXECUTE gate-time.
 *
 * Material (FIXED order): ["redeem_py", sessionId, provider, chainId, wallet,
 * receiver, ptAddress, ytAddress, amount, outputToken, slippageBps].
 */
export interface RedeemPyMatchInput {
  readonly kind: "redeem_py";
  readonly sessionId: string;
  /** VENUE binding - "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the redeemed token lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** PT being burned (half of the pair). */
  readonly ptAddress: string;
  /** YT being burned (resolved from the PT's market - the other half). */
  readonly ytAddress: string;
  /** Human decimal amount of the PT+YT pair to burn (equal legs). */
  readonly amount: string;
  /** Output token (default = the market's underlyingAsset; can be overridden). */
  readonly outputToken: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle PY mint material (P4, FIXED order). Venue `provider` is bound so a mint
 * quote can never authorize a non-Pendle execute. The full execute-variance
 * surface is bound: tokenIn / chainId / slippage / market / YT / receiver all
 * feed the digest, so any divergence blocks. Addresses are EVM (lowercased);
 * `amount` via `canonAmount`.
 */
export function mintHashMaterial(input: MintMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.tokenIn),
    canonAmount(input.amount),
    canonAddress("eip155", input.ptAddress),
    canonAddress("eip155", input.ytAddress),
    canonAddress("eip155", input.market),
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle PRE-EXPIRY PY redeem material (P4, FIXED order). Extends the redeem
 * material with `outputToken` (a pre-expiry redeem can target any token) + venue
 * binding. Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
export function redeemPyHashMaterial(input: RedeemPyMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.ptAddress),
    canonAddress("eip155", input.ytAddress),
    canonAmount(input.amount),
    canonAddress("eip155", input.outputToken),
    input.slippageBps,
  ].join(" ");
}
