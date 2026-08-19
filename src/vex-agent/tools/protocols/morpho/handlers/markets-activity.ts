/**
 * `morpho.markets.activity` - the transaction log of Morpho Blue markets.
 *
 * A plain page: Morpho filters, ranks and pages `marketTransactions`
 * server-side, so nothing is merged or re-sorted here and `matched` is its own
 * exact `countTotal`.
 *
 * `hasMore` IS DERIVED FROM `skip + returned < countTotal`, never from
 * "returned === limit". A live read on 2026-08-14 came back with `count: 2`
 * against `limit: 3` in the middle of a 220-row history, so treating a short
 * page as the end of the list would have silently truncated somebody's audit at
 * an arbitrary point.
 *
 * The per-page breakdown is labelled as a per-page breakdown. Counting
 * liquidations in the returned rows and presenting the figure as a market's
 * liquidation rate would be wrong in both directions depending on the sort key,
 * and a liquidation count is exactly the number a reader is most likely to
 * over-read.
 */

import { getMorphoClient } from "@tools/morpho/client.js";
import { ok, fail } from "../../handler-helpers.js";
import { parseMorphoActivityParams } from "../read-params.js";
import {
  MORPHO_ACTIVITY_HISTORY_NOTE,
  MORPHO_ACTIVITY_USD_NOTE,
  projectActivityRow,
  summariseActivity,
} from "../projectors.js";
import { morphoFailureDetail } from "./shared.js";

export async function morphoMarketsActivity(
  params: Record<string, unknown>,
  context?: { abortSignal?: AbortSignal },
): Promise<ReturnType<typeof ok>> {
  const parsed = parseMorphoActivityParams(params);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;

  let page;
  try {
    page = await getMorphoClient().getActivityPage(
      { first: q.limit, skip: q.offset, orderBy: q.sort, order: q.order, where: q.filters },
      context?.abortSignal,
    );
  } catch (err) {
    return fail(`morpho.markets.activity failed ${morphoFailureDetail(err)}`);
  }

  const rows = page.transactions.map(projectActivityRow);
  const breakdown = summariseActivity(rows);
  const returnedThrough = q.offset + rows.length;
  const hasMore = returnedThrough < page.countTotal;

  return ok({
    summary:
      `${page.countTotal} Morpho market transaction(s) matched, showing ${rows.length} from offset ${q.offset}, `
      + `sorted by ${q.sort} ${q.order}.`
      + (q.types === undefined ? " Every transaction type is included." : ` Types: ${q.types.join(", ")}.`)
      + (breakdown.liquidations > 0
        ? ` ${breakdown.liquidations} of the returned row(s) are LIQUIDATIONS`
          + (breakdown.liquidationsWithBadDebt > 0
            ? `, ${breakdown.liquidationsWithBadDebt} of which left BAD DEBT the market's suppliers absorb.`
            : ".")
        : "")
      + (page.droppedRows > 0
        ? ` ${page.droppedRows} row(s) were dropped because an amount could not be read with a known asset scale; `
          + "showing them without their decimals would have been worse than omitting them."
        : ""),
    asOf: new Date().toISOString(),
    filtersApplied: q.echo,
    matched: page.countTotal,
    returned: rows.length,
    offset: q.offset,
    limit: q.limit,
    hasMore,
    nextOffset: hasMore ? returnedThrough : null,
    droppedRows: page.droppedRows,
    pageBreakdown: {
      ...breakdown,
      scope: "Counts over the RETURNED rows only, not over all matches. They are not a market's liquidation rate.",
    },
    transactions: rows,
    ranking:
      "Morpho filtered, ranked and paged this over ALL matching transactions server-side, so `matched` is exact and "
      + "`hasMore` is derived from offset plus returned against that total, never from the page looking full.",
    notes: {
      usd: MORPHO_ACTIVITY_USD_NOTE,
      history: MORPHO_ACTIVITY_HISTORY_NOTE,
      amounts:
        "Which asset an amount is in depends on the row. A supply, withdraw, borrow or repay moves the LOAN asset; "
        + "a supplyCollateral or withdrawCollateral moves the COLLATERAL asset; a liquidation moves both, with "
        + "`repaidAssets` and `badDebtAssets` in the loan asset and `seizedAssets` in the collateral asset. Every "
        + "amount carries its own decimals and the `asset` leg it belongs to, so never read one against the other "
        + "market leg's scale.",
      shares:
        "`shares` are protocol accounting units, not asset units. They carry no decimals, are not comparable "
        + "between markets, and must never be presented as an amount of money.",
      actors:
        "On a liquidation row `userAddress` is the BORROWER whose position was taken and `liquidatorAddress` is who "
        + "took it. On every other row `userAddress` is whoever moved the funds.",
    },
    nextStep:
      "Read a market in full with morpho.market.get (it needs `marketId` and `chain`) to see whether the bad debt "
      + "and the oracle explain what happened here, or morpho.positions.get to check whether a wallet still holds a "
      + "position in it.",
  });
}
