/**
 * OWNER-AND-MINT-BOUNDED SPL balance delta out of a raw Solana
 * `getTransaction` result - the single piece of settlement evidence the Solana
 * activity sweep is allowed to turn into an executed amount.
 *
 * WHY NOT LAMPORTS: `meta.preBalances`/`meta.postBalances` describe the fee
 * payer's whole lamport position, which on a Jupiter swap also carries the
 * network fee, the landing tip and the rent of every ATA opened or closed in
 * the same transaction. In the mainnet capture
 * `fixtures/jupiter-settlement/swap-sol-to-usdc-3SC5Mi5L.json` that delta is
 * -21,814,146 lamports for a swap whose input was a small fraction of it.
 * A lamport delta is therefore never an amount, and this module reads only
 * `meta.preTokenBalances`/`meta.postTokenBalances`.
 *
 * IT PROVES OR IT DECLINES. An amount exists only when EXACTLY ONE account
 * owned by the given wallet moved the given mint. Two moved accounts, no
 * account, a zero delta, disagreeing decimals, an unreadable entry or a
 * transaction that carries an on-chain error all yield `unproven` with a
 * reason - never a best guess. The caller's fallback (a status-only confirm)
 * is honest; a guessed settlement is not.
 *
 * ABSENT IS NOT NULL, the same rule the sweep applies to `meta.err`: a body
 * that does not CARRY both balance arrays and an `err` property is a shape we
 * did not read, not a shape that proves anything.
 */

import { z } from "zod";

/** A base58 account address or mint. Length-bounded only - it is compared verbatim, never used to derive authority. */
const solanaAddress = z.string().min(32).max(44);

/**
 * One `meta.*TokenBalances` entry, in the exact shape Solana mainnet returns
 * with `encoding: "json"`. `passthrough` because the real entry carries
 * `programId` and the display-only `uiAmount`/`uiAmountString` fields, which
 * this decoder must tolerate and must not consume: `uiAmount` is a JS number
 * and is `null` on a zero balance in the real captures.
 */
const tokenBalanceSchema = z
  .object({
    accountIndex: z.number().int().min(0),
    mint: solanaAddress,
    owner: solanaAddress,
    uiTokenAmount: z
      .object({
        /** Atomic units as digits. Never a number: a u64 balance exceeds `Number.MAX_SAFE_INTEGER`. */
        amount: z.string().regex(/^\d+$/),
        decimals: z.number().int().min(0).max(255),
      })
      .passthrough(),
  })
  .passthrough();

const settlementBodySchema = z
  .object({
    meta: z
      .object({
        /** Only an explicit `null` is proof of success - the sweep's own rule, re-checked here. */
        err: z.unknown().optional(),
        preTokenBalances: z.array(tokenBalanceSchema),
        postTokenBalances: z.array(tokenBalanceSchema),
      })
      .passthrough(),
  })
  .passthrough();

export type OwnerMintDeltaUnprovenReason =
  | "unreadable_body"
  | "on_chain_error"
  | "no_matching_account"
  | "ambiguous_accounts"
  | "zero_delta"
  | "inconsistent_decimals";

export type OwnerMintDelta =
  | { readonly outcome: "proven"; readonly deltaRaw: bigint; readonly decimals: number }
  | { readonly outcome: "unproven"; readonly reason: OwnerMintDeltaUnprovenReason };

export interface OwnerMintBound {
  /** OUR wallet. Only accounts this address owns are ever read. */
  readonly owner: string;
  /** The mint whose movement is being proven. */
  readonly mint: string;
}

export function readOwnerMintDelta(body: unknown, bound: OwnerMintBound): OwnerMintDelta {
  const parsed = settlementBodySchema.safeParse(body);
  if (!parsed.success) return { outcome: "unproven", reason: "unreadable_body" };
  const meta = parsed.data.meta;
  if (!Object.prototype.hasOwnProperty.call(meta, "err")) {
    return { outcome: "unproven", reason: "unreadable_body" };
  }
  if (meta.err !== null) return { outcome: "unproven", reason: "on_chain_error" };

  const accounts = collectBoundAccounts(meta.preTokenBalances, meta.postTokenBalances, bound);
  if (accounts.size === 0) return { outcome: "unproven", reason: "no_matching_account" };

  const moved: { readonly deltaRaw: bigint; readonly decimals: number }[] = [];
  for (const account of accounts.values()) {
    if (account.decimals === null) return { outcome: "unproven", reason: "inconsistent_decimals" };
    if (account.post !== account.pre) {
      moved.push({ deltaRaw: account.post - account.pre, decimals: account.decimals });
    }
  }
  if (moved.length === 0) return { outcome: "unproven", reason: "zero_delta" };
  if (moved.length > 1) return { outcome: "unproven", reason: "ambiguous_accounts" };

  return { outcome: "proven", ...moved[0]! };
}

type ParsedTokenBalance = z.infer<typeof tokenBalanceSchema>;

interface BoundAccount {
  pre: bigint;
  post: bigint;
  /** `null` once the same account has reported two different decimals - the amount is then unreadable. */
  decimals: number | null;
}

/**
 * Both balance arrays projected onto the accounts THIS owner holds of THIS
 * mint, keyed by `accountIndex`.
 *
 * A side that is absent stays at zero: an ATA created inside the transaction
 * has no `pre` entry (the real USDC output leg in
 * `swap-sol-to-usdc-3SC5Mi5L.json`), and one closed inside it has no `post`
 * entry. That is a genuine balance of zero, not missing evidence - unlike an
 * ATA that appears in NEITHER array, which this map simply never learns about
 * and which the caller reads as `no_matching_account`.
 */
function collectBoundAccounts(
  pre: readonly ParsedTokenBalance[],
  post: readonly ParsedTokenBalance[],
  bound: OwnerMintBound,
): Map<number, BoundAccount> {
  const accounts = new Map<number, BoundAccount>();
  const absorb = (entries: readonly ParsedTokenBalance[], side: "pre" | "post"): void => {
    for (const entry of entries) {
      if (entry.owner !== bound.owner || entry.mint !== bound.mint) continue;
      const existing = accounts.get(entry.accountIndex)
        ?? { pre: 0n, post: 0n, decimals: entry.uiTokenAmount.decimals };
      if (existing.decimals !== entry.uiTokenAmount.decimals) existing.decimals = null;
      existing[side] = BigInt(entry.uiTokenAmount.amount);
      accounts.set(entry.accountIndex, existing);
    }
  };
  absorb(pre, "pre");
  absorb(post, "post");
  return accounts;
}
