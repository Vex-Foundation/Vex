/**
 * Pendle SY identity family (R5d): the wrap (token → SY) and the unwrap
 * (SY → token).
 */

import { canonAddress, canonAmount } from "./canonicalize.js";

/**
 * Pendle SY WRAP identity (R5d). `token → SY`. Its own kind rather than the
 * `swap` shape it shipped under: the wrap and the unwrap are one toolId pair
 * whose only structural separation used to be which leg held the SY, so a shared
 * kind left the DB gate reads unable to tell the two directions apart, and left
 * both indistinguishable from an ordinary swap prequote at the `kind` predicate.
 *
 * The DIRECTION is bound by the kind tag itself — the FIRST material element —
 * so a mint digest can never equal a redeem digest even when `sy`, `token`,
 * `amount` and slippage are identical. `sy`/`token` are therefore named by ROLE,
 * not by in/out leg: swapping the legs is no longer what distinguishes them.
 *
 * Material (FIXED order): ["sy_mint", sessionId, provider, chainId, wallet,
 * receiver, sy, token, amount, slippageBps].
 */
export interface SyMintMatchInput {
  readonly kind: "sy_mint";
  readonly sessionId: string;
  /** VENUE binding — "pendle-sy", never plain "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the minted SY lands (the wallet — no Pendle manifest takes a recipient). */
  readonly receiver: string;
  /** The SY being wrapped INTO. */
  readonly sy: string;
  /** The token being spent. */
  readonly token: string;
  /** Human decimal amount of the input leg. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle SY UNWRAP identity (R5d). `SY → token`. Structurally identical to
 * {@link SyMintMatchInput} except for the kind tag, which is the point: the tag
 * is what makes a wrap dry run unable to authorize an unwrap execute.
 *
 * Material (FIXED order): ["sy_redeem", sessionId, provider, chainId, wallet,
 * receiver, sy, token, amount, slippageBps].
 */
export interface SyRedeemMatchInput {
  readonly kind: "sy_redeem";
  readonly sessionId: string;
  /** VENUE binding — "pendle-sy", never plain "pendle". */
  readonly provider: string;
  readonly chainId: number;
  /** Selected EVM wallet (signer). */
  readonly walletAddress: string;
  /** Where the unwrapped token lands. */
  readonly receiver: string;
  /** The SY being unwrapped FROM. */
  readonly sy: string;
  /** The token received. */
  readonly token: string;
  /** Human decimal amount of the input leg. */
  readonly amount: string;
  /** Slippage tolerance (integer bps string), default-normalized on both sides. */
  readonly slippageBps: string;
}

/**
 * Pendle SY wrap/unwrap material (R5d, FIXED order), shared by both directions.
 * ONE function because the two identities bind the same fields; the DIRECTION is
 * carried by `input.kind` in the FIRST slot, so a `sy_mint` digest can never
 * equal a `sy_redeem` digest for identical sy/token/amount/slippage. That single
 * element is the whole cross-direction guarantee, which is why `sy`/`token` are
 * bound by role and never re-ordered per direction. Addresses EVM (lowercased);
 * `amount` via `canonAmount`.
 */
export function syHashMaterial(input: SyMintMatchInput | SyRedeemMatchInput): string {
  return [
    input.kind,
    input.sessionId,
    input.provider.trim().toLowerCase(),
    String(input.chainId),
    canonAddress("eip155", input.walletAddress),
    canonAddress("eip155", input.receiver),
    canonAddress("eip155", input.sy),
    canonAddress("eip155", input.token),
    canonAmount(input.amount),
    input.slippageBps,
  ].join(" ");
}
