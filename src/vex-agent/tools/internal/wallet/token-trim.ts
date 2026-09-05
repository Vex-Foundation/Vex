/**
 * The concise DISPLAY trim of a wallet snapshot's token rows, and its row types.
 *
 * Extracted from `read.ts` unchanged when the completeness axes landed: the
 * handler owns reading chains and assembling the answer, while this owns one
 * separate question with its own reason to change - which of the rows we
 * already have does a `concise` caller get to see, and how is what it dropped
 * reported. They are different lifecycles (a display-policy change must not be
 * a change to the read path), and the file-growth gate at 750 lines is the
 * signal that they had accumulated in one place.
 *
 * Nothing here computes a total, a completeness axis, or a price. The trim is
 * measured against the FULL projected set upstream, and per the frozen
 * contract it must be incapable of moving any reported total or axis.
 */

import type { ResponseFormat } from "@vex-agent/response-format.js";
import type { ConciseKhalaniToken } from "../../protocols/khalani/projectors.js";
import type { SolanaWalletTokenRow } from "./solana-row.js";
import { hasUsdPrice, holdsBalance } from "@vex-agent/wallet-inventory/completeness.js";

/** Either lane's projected row, before the concise trim. */
export type ProjectedTokenRow = ConciseKhalaniToken | SolanaWalletTokenRow;

/**
 * A projected token row as `WalletBalances` emits it. `priceUnavailable` is
 * also set by the projector on a held row with no price feed, so the agent can
 * tell "no USD price" from "not held"; the trim sets it on the rows it retains
 * outside the caller's `limit` for the same reason.
 */
export type WalletTokenRow = ProjectedTokenRow & { priceUnavailable?: true };

/**
 * Narrowing action for a trimmed snapshot, phrased against the FULL projected
 * scan, which is what `truncated` is measured against. The concise trim drops
 * rows three ways (priced rows past `limit`, unpriced rows past the 20-row
 * cap, unpriced rows with a zero balance) and only the first is recoverable by
 * raising `limit`; the `detailed` format is the one recovery that returns
 * every row. There is no cursor and no page, so the note must not imply a
 * next call, and it must not promise `limit` more than it can deliver.
 */
export const TRUNCATION_NOTE =
  "Some rows of the FULL projected scan for this wallet are not listed: the concise trim "
  + "keeps the top `limit` priced rows, then at most 20 held-but-unpriced rows, and drops "
  + "unpriced rows with a zero balance. There is no continuation to fetch. To see every row, "
  + "pass response_format:\"detailed\" (the only complete recovery). Raising `limit` recovers "
  + "only the priced rows it cut, never the rows the 20-row unpriced cap or the zero-balance "
  + "rule removed. `tokenCount` and `totalUsd` already describe the FULL scan.";

/**
 * The bound on the held-but-unpriced rows the concise trim retains outside the
 * caller's `limit`: the agent must learn that unpriced holdings exist without a
 * dust wallet flooding its context.
 */
const MAX_UNPRICED_TOKENS_PER_SNAPSHOT = 20;

/**
 * Held USD value of a projected token row: `balance × priceUsd`, normalised to a
 * smallest-unit → human conversion (mirrors the canonical `tokenUsd` used for
 * `totalUsd`). Missing / malformed price or balance is null-safe → `0`, so a
 * row with no price/balance signal sorts last rather than throwing.
 *
 * A RANKING figure only. It is a float and never reaches a reported total; the
 * reported `pricedTotalUsd` is summed exactly from the rows' own `valueUsd`.
 */
function projectedTokenUsd(token: ProjectedTokenRow): number {
  const { balanceRaw, priceUsd, decimals } = token;
  if (!balanceRaw || !priceUsd) return 0;
  try {
    const balanceHuman = Number(BigInt(balanceRaw)) / Math.pow(10, decimals);
    const price = Number(priceUsd);
    if (!Number.isFinite(balanceHuman) || !Number.isFinite(price)) return 0;
    return balanceHuman * price;
  } catch {
    return 0;
  }
}

/** Structural native-SOL marker. No address or symbol decides this. */
function isSolanaNativeRow(token: ProjectedTokenRow): token is SolanaWalletTokenRow {
  return "assetKind" in token && token.assetKind === "native";
}

/**
 * Optionally trim a projected token list to the top-N by held USD value.
 *
 * Compatibility-first: a trim only happens when `response_format` is 'concise'
 * AND a positive `limit` was supplied. The default 'detailed' format (or an
 * omitted `limit`) returns every row untouched, so existing callers are
 * unaffected. The sort is a stable copy (no in-place mutation of the input).
 *
 * A held token with NO price feed scores 0 here, so the limit used to cut it
 * first and the agent could not tell it apart from a token it does not hold
 * (2026-08-10 incident). Such rows are therefore retained, after the priced
 * rows and outside the limit, flagged with `priceUnavailable` so the missing
 * USD figure reads as "no price feed", not "no balance".
 *
 * Retention is bounded BY THE CAP above, not by the scan set: only the local
 * chains scan a bounded set (seed ∪ pinned), while the Khalani read requests
 * every holding the provider knows with no token cap of its own
 * (`tools/khalani/balances/scan.ts`), so a wallet full of unpriced dust would
 * otherwise turn `limit:1` into an unbounded answer. Drops are reported as
 * `unpricedOmitted`, mirroring `tokenErrorsOmitted`.
 *
 * `unpricedOmitted` is a DROP counter, not a census: on the `detailed` path
 * nothing is dropped and it is legitimately `0`, while the full number of held
 * rows with no price feed is the snapshot's own `unpricedHeldCount`, which the
 * completeness owner computes from this function's INPUT on every path.
 *
 * Totals are computed upstream off the full scan and are untouched by this
 * display trim.
 */
export function trimTokens(
  tokens: ProjectedTokenRow[],
  limit: number | undefined,
  responseFormat: ResponseFormat,
): { tokens: WalletTokenRow[]; unpricedOmitted: number } {
  if (responseFormat === "detailed" || limit === undefined) return { tokens, unpricedOmitted: 0 };
  // Stable sort: rows with equal held USD (every unpriced row scores 0) keep
  // their scan order, so the retained set is deterministic.
  const sorted = [...tokens].sort((a, b) => projectedTokenUsd(b) - projectedTokenUsd(a));
  // C4.4: native SOL always exists, including at zero. It stays outside the
  // display limit so a ranked token list cannot make the native asset appear
  // absent. `assetKind` is the only discriminator; SOL_MINT also identifies
  // wSOL and must never trigger this retention.
  const native = sorted.filter(isSolanaNativeRow);
  const limitCandidates = sorted.filter((token) => !isSolanaNativeRow(token));
  const priced = limitCandidates.filter(hasUsdPrice).slice(0, limit);
  const unpricedHeld = limitCandidates.filter(
    (token) => !hasUsdPrice(token) && holdsBalance(token),
  );
  const retained: WalletTokenRow[] = unpricedHeld
    .slice(0, MAX_UNPRICED_TOKENS_PER_SNAPSHOT)
    .map((token) => ({ ...token, priceUnavailable: true as const }));
  return {
    tokens: [...native, ...priced, ...retained],
    unpricedOmitted: unpricedHeld.length - retained.length,
  };
}
