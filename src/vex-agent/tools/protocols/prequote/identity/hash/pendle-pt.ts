/**
 * Pendle PT identity families: the matured-PT redeem (Wave 5) and the PT
 * rollover between maturities (R5d).
 */

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Pendle PT redeem trade identity (Wave 5). A matured-PT redemption is NEITHER a
 * swap nor a bridge — it has no slippage/route surface and its risk leg is the
 * PT+YT pair, not a token-in/token-out pair. Computed IDENTICALLY at the Pendle
 * QUOTE record-time (`pendle.pt.quote`, when Convert returns action `redeem-py`)
 * and the Pendle redeem EXECUTE gate-time (`pendle.pt.redeem`) — both resolve the
 * YT from the PT through the SAME market lookup, so the digests collide. Never
 * reuses the Khalani/Relay bridge identity (Codex G2#3).
 *
 * Material (FIXED order): ["redeem", sessionId, provider, chainId, wallet,
 * ptAddress, ytAddress, amount, receiver, slippageBps]. Addresses are EVM
 * (lowercase); `amount` is the human decimal via `canonAmount`.
 *
 * `slippageBps` is bound too (Codex blocker fix): the redeem EXECUTE accepts a
 * `slippageBps` param, so without binding it a 50 bps quote could authorize a
 * 5000 bps execute. The shared builder normalizes the default identically on both
 * sides, so a quote-without-slippage still matches an execute-without-slippage,
 * while divergent slippage → different digest → gate BLOCK (swap-identity
 * doctrine, `SwapMatchInput.slippageBps`).
 */
export interface RedeemMatchInput {
  readonly kind: "redeem";
  readonly sessionId: string;
  /** VENUE binding — "pendle". A redeem quote can never authorize another venue. */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** PT being redeemed. */
  readonly ptAddress: string;
  /** YT resolved from the PT's market (record + gate resolve it identically). */
  readonly ytAddress: string;
  /** Human decimal amount of PT to redeem. */
  readonly amount: string;
  /** Where the redeemed asset lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle PT ROLLOVER identity (R5d). `PT(market A) → PT(market B)` — a maturity
 * roll. Its own kind: both PTs are free parameters, and binding only one of them
 * would let a quote for a roll into one maturity authorize an execute rolling
 * into another.
 *
 * Material (FIXED order): ["pt_rollover", sessionId, provider, chainId, wallet,
 * receiver, fromPt, toPt, amount, slippageBps].
 */
export interface PtRolloverMatchInput {
  readonly kind: "pt_rollover";
  readonly sessionId: string;
  /** VENUE binding — "pendle". */
  readonly provider: string;
  /** Both legs are on ONE chain — a rollover is not a bridge. */
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the destination PT lands (defaults to the selected wallet). */
  readonly receiver: string;
  /** The PT being rolled OUT of (source maturity). */
  readonly fromPt: string;
  /** The PT being rolled INTO (destination maturity). */
  readonly toPt: string;
  /** Human decimal amount of the source PT. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle redeem material (Wave 5, FIXED order). Venue `provider` is bound so a
 * redeem quote can never authorize a non-Pendle execute. PT/YT/receiver/wallet
 * are EVM addresses (lowercased); `amount` via `canonAmount`.
 */
export function redeemHashMaterial(input: RedeemMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.ptAddress),
    canonAddress("eip155", input.ytAddress),
    canonAmount(input.amount),
    canonAddress("eip155", input.receiver),
    // Slippage tail (Codex blocker): integer bps string; the builder normalizes
    // the default identically on both sides so quote↔execute collide when both
    // omit it, and a divergent slippage blocks.
    input.slippageBps,
  ].join(" ");
}

/**
 * Pendle PT rollover material (R5d, FIXED order). BOTH PTs are bound, in a fixed
 * source→destination order, so a roll into one maturity can never authorize a
 * roll into another (and a reversed roll hashes differently).
 */
export function ptRolloverHashMaterial(input: PtRolloverMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.fromPt),
    canonAddress("eip155", input.toPt),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}
