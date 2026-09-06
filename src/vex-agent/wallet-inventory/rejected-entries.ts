/**
 * How a balance surface REPORTS the entries the Khalani boundary refused.
 *
 * Two live tools answer a balance question (`WalletBalances` and
 * `khalani.tokens.balances`) and both must say the same thing about the same
 * refusals, in the same words: the boundary
 * (`@tools/khalani/validation/chains-tokens.ts`) admits only entries whose
 * `decimals` are a whole number in [0, 36] and hands the rest back with their
 * identity and, when the provider gave one, their exact atomic amount. The
 * SYNC path's own decision about what a refusal costs durable rows lives in
 * `@vex-agent/sync/balance-sync/rejected-entry-salvage.js`; this is the
 * READ-side counterpart, and it owns only the bound and its disclosure.
 *
 * The list is bounded because the input is attacker-reachable - anyone can mint
 * a token with hostile `decimals` and airdrop it - and the count is exact
 * because a bound that cannot say what it left out is a silent cut.
 */

import type { KhalaniRejectedTokenBalanceEntry } from "@tools/khalani/types.js";

/**
 * Same bound and same reason as the token/account error caps on these
 * surfaces: the agent must learn that refusals happened and see a sample of
 * which tokens, without a dust wallet filling its context.
 */
export const MAX_REJECTED_ENTRIES_PER_SNAPSHOT = 20;

/**
 * The recovery instruction for a bounded `rejectedEntries` list. There is no
 * continuation and no parameter that widens it: the COUNT is the complete
 * figure and the listed entries are a sample of it, which is exactly what the
 * reader has to be told rather than left to infer.
 */
export const REJECTED_ENTRIES_NOTE =
  "`rejectedEntries` lists at most 20 of the balance entries the boundary refused for their "
  + "`decimals`; `rejectedEntriesOmitted` counts the ones not listed and `rejectedEntryCount` is "
  + "the exact total. There is no continuation to fetch and no parameter widens this list.";

/** The disclosure fields a balance surface emits for its refused entries. */
export interface BoundedRejectedEntries {
  readonly rejectedEntryCount: number;
  readonly rejectedEntries: KhalaniRejectedTokenBalanceEntry[];
  /** Present only when the bound actually left entries out. */
  readonly rejectedEntriesOmitted?: number;
}

/**
 * Bound the list, keep the count exact, and name the omission when there is
 * one. The entries are emitted VERBATIM: their identity and `balanceRaw` are
 * true facts about the wallet, and the offending `decimals` are not part of the
 * shape at all, so nothing an agent could size a trade from is echoed.
 */
export function boundRejectedEntries(
  entries: readonly KhalaniRejectedTokenBalanceEntry[],
): BoundedRejectedEntries {
  const listed = entries.slice(0, MAX_REJECTED_ENTRIES_PER_SNAPSHOT);
  const omitted = entries.length - listed.length;
  return {
    rejectedEntryCount: entries.length,
    rejectedEntries: listed,
    ...(omitted > 0 ? { rejectedEntriesOmitted: omitted } : {}),
  };
}
