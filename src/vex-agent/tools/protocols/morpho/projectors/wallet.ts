/**
 * Projection of an on-chain wallet snapshot into agent-facing shape.
 *
 * THE ALLOWANCE IS THE SECURITY SURFACE, so it is rendered to be read rather
 * than to be pretty. Each entry names the spender contract, says what that
 * contract does in a Morpho flow, carries the exact raw integer, and flags
 * `unlimited` only on an exact match with `type(uint256).max`. The 78-digit
 * number is useless to a reader on its own and dangerous to summarise away, so
 * both forms travel together.
 *
 * A FAILED READ IS NEVER PROJECTED AS A ZERO. `src/tools/morpho/wallet-reads.ts`
 * keeps unknown balances and unknown allowances in their own fields, and this
 * module carries them through under names that say so. The direction of the
 * mistake matters: an unknown allowance shown as `0` reads as "nothing is
 * approved", which is the reassuring answer and the wrong one.
 */

import { formatRawAmount, type ProjectedAmount } from "./_shared.js";
import type { MorphoWalletSnapshot } from "@tools/morpho/wallet-reads.js";

export const MORPHO_ALLOWANCE_NOTE =
  "An allowance is a standing permission for a contract to move that token out of the wallet, and it survives until "
  + "it is changed. `unlimited: true` means the approval is the maximum possible value, so the contract may move the "
  + "entire balance, now and in future, without another signature. That is normal practice and it is still a standing "
  + "risk worth naming when reporting - especially on GeneralAdapter1, which is the contract that actually pulls "
  + "tokens in a bundled Morpho action. `effectivelyUnlimited: true` with `unlimited: false` means the approval WAS "
  + "set to the maximum and part of it has since been drawn: the remainder is still astronomically above any real "
  + "balance, so treat it as unbounded and report it as such. Vex cannot change an approval yet; this tool only reads.";

export const MORPHO_BALANCE_FRESHNESS_NOTE =
  "Balances and allowances are point-in-time, read at the block the node answered from. They can change before any "
  + "action built on them is sent, so re-read immediately before acting rather than trusting this snapshot.";

export interface ProjectedAllowance {
  spender: string;
  spenderRole: string;
  raw: string;
  human: string;
  unlimited: boolean;
  effectivelyUnlimited: boolean;
}

export interface ProjectedTokenBalance {
  tokenAddress: string;
  balance: ProjectedAmount;
  allowances: readonly ProjectedAllowance[];
  /** Spenders this token could not answer for. Unknown, not absent. */
  allowancesUnavailable: readonly { spender: string; reason: string }[];
}

export interface ProjectedWalletBalance {
  chain: string;
  walletAddress: string;
  native: ProjectedAmount | null;
  nativeUnavailable: string | null;
  tokens: readonly ProjectedTokenBalance[];
  tokensUnavailable: readonly { tokenAddress: string; reason: string }[];
  spendersUnavailable: readonly { spender: string; reason: string }[];
}

export function projectWalletSnapshot(
  snapshot: MorphoWalletSnapshot,
  chainSlug: string,
): ProjectedWalletBalance {
  return {
    chain: chainSlug,
    walletAddress: snapshot.walletAddress,
    native:
      snapshot.native === null
        ? null
        : {
            raw: snapshot.native.balanceRaw,
            decimals: snapshot.native.decimals,
            symbol: snapshot.native.symbol,
            human: formatRawAmount(snapshot.native.balanceRaw, snapshot.native.decimals),
            // The chain coin is not priced here. This tool reads a node, not a
            // price feed, and inventing a mark would be the one number in the
            // answer that no on-chain read backs.
            usd: null,
          },
    nativeUnavailable: snapshot.nativeFailure,
    tokens: snapshot.tokens.map((token) => ({
      tokenAddress: token.address,
      balance: {
        raw: token.balanceRaw,
        decimals: token.decimals,
        symbol: token.symbol,
        human: formatRawAmount(token.balanceRaw, token.decimals),
        usd: null,
      },
      allowances: token.allowances.map((allowance) => ({
        spender: allowance.spender,
        spenderRole: allowance.spenderRole,
        raw: allowance.raw,
        human: formatRawAmount(allowance.raw, token.decimals),
        unlimited: allowance.unlimited,
        effectivelyUnlimited: allowance.effectivelyUnlimited,
      })),
      allowancesUnavailable: token.allowanceGaps.map((gap) => ({
        spender: gap.role,
        reason: gap.reason,
      })),
    })),
    tokensUnavailable: snapshot.failures.map((failure) => ({
      tokenAddress: failure.address,
      reason: failure.reason,
    })),
    spendersUnavailable: snapshot.chainSpenderGaps.map((gap) => ({
      spender: gap.role,
      reason: gap.reason,
    })),
  };
}

/**
 * Count the standing unbounded approvals, the fact most worth leading with.
 *
 * Counts `effectivelyUnlimited` rather than `unlimited`, so a max approval that
 * has been partially drawn is still counted. Leading with the exact flag would
 * report "0 unlimited approvals" for a wallet carrying one, which is the
 * reassuring answer and the wrong one.
 */
export function countUnlimitedApprovals(projected: ProjectedWalletBalance): number {
  return projected.tokens.reduce(
    (total, token) => total + token.allowances.filter((allowance) => allowance.effectivelyUnlimited).length,
    0,
  );
}
