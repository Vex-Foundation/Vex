/**
 * Morpho vault LEND identities: supplying assets to a vault and redeeming them
 * back out (E3b-2, migration 080).
 *
 * TWO KINDS, NOT ONE, for the same structural reason the Pendle LP pair carries
 * two. A deposit and a withdrawal on the same vault take the SAME vault address
 * and can take the same amount, so a shared kind would let a deposit quote
 * authorize a withdrawal execute and the other way round. That is not a rounding
 * risk: it is the difference between putting the wallet's money in and taking it
 * out. `lend_deposit` and `lend_withdraw` are distinct kinds, each carrying its
 * tag as the FIRST material element, so the direction is unmixable by
 * construction rather than by a check somebody has to remember.
 *
 * THE VAULT IS THE ANCHOR, AND THE ASSET IS DELIBERATELY NOT BOUND. A Morpho
 * vault determines its own asset on chain; binding the asset as well would mean
 * the gate had to read it back from somewhere, and the execute params do not
 * carry it. The vault address plus the chain id already pins exactly one
 * contract, so the asset is a derived fact rather than an identity field.
 *
 * `slippageBps` IS bound, because it is not decoration here: it is what the
 * deposit's on-chain `maxSharePrice` guard is built from, and it is the absolute
 * per-operation share bound the settlement is later judged against. A quote at
 * 50 bps must not authorize an execute at 10 000.
 *
 * The amount is the ASSET amount in RAW base units on both sides, which is what
 * both the quote and the execute take. `canonAmount` still runs over it so a
 * stray leading zero cannot split the digest.
 */

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Morpho vault DEPOSIT identity. Material (FIXED order): ["lend_deposit",
 * sessionId, provider, chainId, wallet, receiver, vault, amount, slippageBps].
 * Addresses EVM (lowercased); `amount` via `canonAmount`.
 */
export interface LendDepositMatchInput {
  readonly kind: "lend_deposit";
  readonly sessionId: string;
  /** VENUE binding - "morpho". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (the signer). */
  readonly walletAddress: string;
  /** Where the minted shares land. Always the selected wallet on this lane. */
  readonly receiver: string;
  /** The vault the assets are supplied to. The anchor of this identity. */
  readonly vault: string;
  /** ASSET amount going in, RAW base units. */
  readonly amount: string;
  /** Approved price protection (integer bps string), default-normalized. */
  readonly slippageBps: string;
}

/**
 * Morpho vault WITHDRAW identity. Same shape and same fixed field order as the
 * deposit, under its own kind tag: the two are mirror operations on one vault
 * and nothing but the tag distinguishes their material, which is exactly why the
 * tag has to be there.
 */
export interface LendWithdrawMatchInput {
  readonly kind: "lend_withdraw";
  readonly sessionId: string;
  /** VENUE binding - "morpho". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (the signer). */
  readonly walletAddress: string;
  /** Where the redeemed assets land. Always the selected wallet on this lane. */
  readonly receiver: string;
  /** The vault the assets are redeemed from. */
  readonly vault: string;
  /** ASSET amount coming out, RAW base units. */
  readonly amount: string;
  /** Approved price protection (integer bps string), default-normalized. */
  readonly slippageBps: string;
}

/** Fixed-order material for both lend kinds. The `kind` tag leads it. */
export function lendHashMaterial(input: LendDepositMatchInput | LendWithdrawMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.vault),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}
