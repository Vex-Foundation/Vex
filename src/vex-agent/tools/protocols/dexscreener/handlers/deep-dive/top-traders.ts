/**
 * Handler for `dexscreener__top_traders_list`.
 *
 * The thinnest of the four, because the provider does the ranking and there is
 * no paging to manage. What is left here is entirely about what the answer may
 * CLAIM, and every line of it is a rule-90 obligation:
 *
 *  - the surface is `bounded_non_pageable` and says so, rather than offering an
 *    offset that does nothing;
 *  - the leaderboard is UP TO 100 rows, because `onlyKol` was measured
 *    returning zero;
 *  - `netCashFlowUsd` is cash flow and `currentHoldingValueUsd` is present
 *    value, not the profit the provider's own rank names suggest;
 *  - an `unknowns` block names what this endpoint structurally cannot see, so
 *    the model has the limits of the data next to the data.
 */

import {
  fetchTopTraders,
  multiplyDecimalStrings,
  TOP_TRADERS_LOOKBACK_DAYS_MAX,
  TOP_TRADERS_PROVIDER_WINDOW,
  TOP_TRADER_SORTS,
  type TopTraderRow,
  type TopTraderSort,
} from "@tools/dexscreener/endpoints/top-traders.js";
import { sanitizeIssuerField } from "@tools/dexscreener/sanitize.js";
import { ok } from "../../../handler-helpers.js";
import {
  TOP_TRADER_LIMIT_DEFAULT,
  TOP_TRADER_LIMIT_MAX,
  TOP_TRADER_LIMIT_MIN,
} from "../../manifests/deep-dive-params.js";
import {
  HTTP_TIMEOUT_MS,
  observation,
  readBoundedInteger,
  readEnum,
  readSubject,
  subjectBlock,
} from "./_shared.js";

export async function runTopTraders(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof ok>> {
  const sortBy = readEnum<TopTraderSort>(
    params,
    "sortBy",
    TOP_TRADER_SORTS,
    "boughtUsd"
  );
  const sortDir = readEnum(params, "sortDir", ["desc", "asc"] as const, "desc");
  const limit = readBoundedInteger(
    params,
    "limit",
    TOP_TRADER_LIMIT_MIN,
    TOP_TRADER_LIMIT_MAX,
    TOP_TRADER_LIMIT_DEFAULT,
    `${TOP_TRADER_LIMIT_MAX} is the provider's entire leaderboard: there is no page beyond it to ask for.`
  );
  /*
   * THE PROVIDER'S OWN CEILING, MEASURED.
   *
   * The 3,650-day bound removed under D-DS5 was undeclared and unmeasured, and
   * removing it was right; leaving NO bound was not. Measured live 2026-08-24
   * on a 2023-vintage pool: with no `mda` the oldest first swap on every sort
   * is 30.01 days old, `mda=30` returns the same 100 makers as the default,
   * and `mda=31`, `mda=90` and `mda=365` each answer HTTP 400 with an empty
   * body (`mda=60` likewise on a Solana pool). So 30 is the provider's default
   * AND its maximum, and "omit it for the pair's whole history" was false: the
   * leaderboard is a 30-day leaderboard.
   *
   * The bound is here rather than at the 400 because a caller's own parameter
   * being out of range is not an endpoint failure, and the 400's remedy sent
   * the model to debug the AMM id it had got right.
   */
  const lookbackDays = readBoundedInteger(
    params,
    "lookbackDays",
    1,
    TOP_TRADERS_LOOKBACK_DAYS_MAX,
    TOP_TRADERS_LOOKBACK_DAYS_MAX,
    `Days back from now, as a whole number of days. ${TOP_TRADERS_LOOKBACK_DAYS_MAX} is the provider's own maximum AND its default, measured: mda=31, 60, 90 and 365 each answer HTTP 400, and omitting it returns the same 30-day window. This leaderboard cannot rank a pair's whole history.`
  );
  const onlyKol = params["onlyKol"] === true;

  const { transport, subject } = await readSubject(params, signal);

  const document = await fetchTopTraders({
    transport,
    chainId: subject.chainId,
    pairAddress: subject.pairAddress,
    ammId: subject.ammId,
    quoteTokenAddress: subject.quoteTokenAddress,
    sortBy,
    sortDir,
    lookbackDays,
    onlyKol,
    timeoutMs: HTTP_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });

  const sanitized = new Set<string>();
  const rows = document.rows.slice(0, limit);
  // The pair's own current price, from the subject that was already resolved.
  // It is the second factor of currentHoldingValueUsd and is echoed with it,
  // because a derived money figure whose inputs are invisible cannot be checked.
  const priceUsd = subject.priceUsd;

  return ok({
    summary: summarize(subject.baseTokenSymbol, document.rows, rows.length, sortBy, onlyKol),
    subject: subjectBlock(subject),
    traders: rows.map((row) => shapeRow(row, priceUsd, sanitized)),
    returned: rows.length,
    leaderboardSize: document.rows.length,
    ordering: {
      sortBy,
      sortDir,
      providerSortKey: document.providerSortKey,
      note: `The provider calls this rank "${document.providerSortKey}". Two of its four rank names are wrong about what they measure, so the public name says what the column IS: netCashFlowUsd is dollars out minus dollars in, and currentHoldingValueUsd is the present value of the position. Ranking runs on the provider over the whole pair.${sortBy === "currentHoldingValueUsd" ? " The ORDER of these rows is the provider's own unrealized rank; the per-row currentHoldingValueUsd is derived here from balanceAmount and the pair price, because the provider ranks by it and does not emit it. The two agree in meaning but the row value is a Vex derivation and says so." : ""}`,
    },
    filtersApplied: {
      // Always a number now: the window is 30 days whether or not the caller
      // named it, and reporting null let the answer read as all-time.
      lookbackDays,
      lookbackDaysNote: `Every row above is from the last ${lookbackDays} day(s), AND EVERY MONEY FIGURE ON IT IS COMPUTED OVER THAT WINDOW rather than filtered by it. buys, sells, volumeUsdBuy, volumeUsdSell, amountBuy, amountSell, firstSwapAtMs, and therefore netCashFlowUsd and activeSpanSeconds, are all recomputed for these ${lookbackDays} day(s): measured on one wallet, a 30-day window read buys 29 and volumeUsdBuy 246,836.60 while a 1-day window read buys 3 and 11,325.53 for the same wallet, a 28x difference. So volumeUsdBuy here is not the wallet's total on this pair. The provider serves no longer window: this is a ${lookbackDays}-day leaderboard, not an all-time one, and a wallet that traded heavily before it does not appear.`,
      onlyKol,
      ...(onlyKol
        ? {
            onlyKolCaveat:
              "MEASURED: this filter returned ZERO rows on the probed pair. An empty leaderboard with it on is expected and is not evidence that no notable wallet traded this pair. The labelling is the provider's own opaque classification.",
          }
        : {}),
      note: "The provider also accepts a launchpad id on this route. It is NOT sent: three requests on a live bonding pair with no lpId, a matching lpId and a wrong lpId returned the identical body with one SHA-256, so exposing it would advertise a filter that does nothing.",
    },
    /*
     * WHETHER THE HOLDING VALUE IS DERIVABLE AT ALL ON THIS RANKING.
     *
     * `balanceAmount` nullity is SORT-CORRELATED and nothing said so. Measured
     * null counts out of 100: `currentHoldingValueUsd` 0, `netCashFlowUsd` asc
     * 0, `boughtUsd` desc 58, and `boughtUsd` asc and `netCashFlowUsd` desc
     * BOTH 100 of 100. So on two of the eight sort/direction combinations
     * every row's derived holding value is null, while the tool description
     * sells that column at length. The per-row note was already honest; a
     * reader scanning an all-null column had nothing telling them it was the
     * ranking's own property rather than a broken derivation.
     */
    balanceCoverage: {
      rowsReturned: rows.length,
      balancePresent: rows.filter((row) => row.balanceAmount !== null).length,
      leaderboardBalancePresent: document.rows.filter(
        (row) => row.balanceAmount !== null
      ).length,
      leaderboardSize: document.rows.length,
      note: `The provider sends balanceAmount only on some rankings, and currentHoldingValueUsd is derived from it, so an all-null holding column is a property of THIS sort rather than a failure. Measured out of 100 rows: sortBy currentHoldingValueUsd returned 0 nulls, netCashFlowUsd with sortDir asc returned 0, boughtUsd desc returned 58, and boughtUsd asc and netCashFlowUsd desc each returned 100 nulls. This answer ranked by ${sortBy} ${sortDir}. For a reliably populated holding value, ask for sortBy currentHoldingValueUsd.`,
    },
    labelCoverage: {
      labelPresent: rows.filter((row) => row.label !== null).length,
      urlPresent: rows.filter((row) => row.url !== null).length,
      note: "label and url were EMPTY on 100 percent of 1,300 live rows across four pairs and three AMM classes. They are in the provider's wire schema and are still read, but a null in either is the measured normal and says nothing about the wallet. Do not treat a missing label as evidence that a wallet is unremarkable.",
    },
    summaryBlock: cohortSummary(rows),
    pagination: {
      mode: "bounded_non_pageable",
      hasMore: false,
      providerWindow: TOP_TRADERS_PROVIDER_WINDOW,
      note: `This surface serves ONE leaderboard of up to ${TOP_TRADERS_PROVIDER_WINDOW} wallets per sort. There is no offset, no cursor and no page parameter, so wallets ranked below it are UNREACHABLE by asking again: they are not hidden behind a page. To see different wallets, change sortBy, sortDir or lookbackDays, which gives the provider a different question to rank. For a chronological or wallet-filtered view of any depth, use dexscreener__trades_list, which does page.`,
    },
    unknowns: {
      cannotDetermine: [
        "profit or loss",
        "cost basis",
        "whether a wallet has exited",
        "transfers in or out of the wallet",
        "activity on other pools or other venues",
        "share of token supply held",
        "whether several wallets are one entity",
      ],
      note: "This endpoint sees ONE pool's swap history and nothing else. Every item above is invisible to it, so a wallet that looks like it sold everything may have moved tokens out, and a wallet that looks inactive may be trading the same token elsewhere. Do not describe any wallet here as profitable, smart money, or an exited holder.",
    },
    traderSemantics:
      "netCashFlowUsd is dollars OUT minus dollars IN on this pair and is NOT profit. currentHoldingValueUsd is what the remaining position is worth now, not unrealized gain. retainedBoughtPct is the share of what the wallet BOUGHT here that it still holds, never a share of token supply. activeSpanSeconds is the time between a wallet's first and last trade on this pair, not a holding period.",
    contextHandoff:
      "For what these wallets did and when, call dexscreener__trades_list with a maker address; for the price move they traded into, call dexscreener__candles_list.",
    sanitizedFields: [...sanitized].sort(),
    providerWindow: {
      endpoint: "/dex/log/amm/v5/{ammId}/top/{chain}/{pair}",
      serverSide: true,
      rowsReturned: document.rows.length,
      maxRows: TOP_TRADERS_PROVIDER_WINDOW,
      responseBytes: document.bytes,
      note: `Up to ${TOP_TRADERS_PROVIDER_WINDOW} rows, not exactly that many: the key-opinion-leader filter was measured returning zero.`,
    },
    sourceObservation: observation(transport, document.fetchedAtMs),
  });
}

/**
 * The present value of what a wallet still holds on this pair.
 *
 * The provider RANKS by this figure (its `unrealized` sort) and does not emit
 * it: measured, 100 of 100 rows on a fresh unrealized rank carried a balance
 * and no value. It is therefore derived here, and every property of that
 * derivation is stated on the row: the exact decimal product of the provider's
 * own `balanceAmount` and the pair's current `priceUsd`, both echoed, with no
 * binary floating point anywhere on the token lexeme. When either factor is
 * absent or is not a plain decimal, the value is NULL with the missing inputs
 * named. An approximated money figure that looks like a measured one is
 * exactly the failure rule 90 forbids.
 */
function holdingValue(
  row: TopTraderRow,
  priceUsd: string | null
): Record<string, unknown> {
  const missingInputs: string[] = [];
  if (row.balanceAmount === null) missingInputs.push("balanceAmount");
  if (priceUsd === null) missingInputs.push("pairPriceUsd");
  const product =
    row.balanceAmount === null || priceUsd === null
      ? null
      : multiplyDecimalStrings(row.balanceAmount, priceUsd);
  if (product === null && missingInputs.length === 0) {
    missingInputs.push("unparsable_decimal_lexeme");
  }
  return {
    // The DISPLAYED figure is rounded to cents; the exact product is kept
    // beside it. See `roundUsdCents` for why showing the full product was
    // dishonest about its own precision.
    currentHoldingValueUsd: roundUsdCents(product),
    currentHoldingValueBasis: {
      balanceAmount: row.balanceAmount,
      pairPriceUsd: priceUsd,
      method: "exact decimal multiplication of balanceAmount by the pair's current priceUsd, displayed rounded to cents",
      exactProductUsd: product,
      derivationPrecision:
        "THE INPUT IS ALREADY A PROVIDER ROUNDING, MEASURED IN SIGNIFICANT DIGITS RATHER THAN DECIMAL PLACES. balanceAmount arrives as a human decimal string carrying about 15 to 16 significant digits whatever the token's decimals and wherever the decimal point falls (measured over 600 live rows: \"1464600134847.065\" at 16 significant digits, and a small balance running to seven decimal places as \"0.0001992\" to reach the same precision), so the true balance can differ from it in the figures below that precision. The multiplication itself is exact over the lexemes given, which is why exactProductUsd carries every digit of it, but the displayed value is rounded to cents: emitting the full 18-significant-digit product would present far more precision than its inputs justify. A genuinely sub-cent position therefore displays as 0.00 here and is only readable in exactProductUsd beside it.",
      ...(missingInputs.length === 0 ? {} : { missingInputs }),
      note:
        product === null
          ? "NOT DERIVABLE for this row: the inputs above are what was available and missingInputs names what was not. It is null rather than zero or an estimate, because an approximated money figure is indistinguishable from a measured one once it is in the answer."
          : "Derived here, not reported by the provider: the provider ranks by this value and emits only the balance. It is the exact decimal product of the two factors above, valued at the pair price at sourceObservation.fetchedAtMs, and it moves with the price. It is present VALUE, not profit and not unrealized gain: cost basis and transfers are invisible to a venue.",
    },
  };
}

/**
 * A dollar product rendered to CENTS, on the decimal string, never via a float.
 *
 * Half-up on the third fractional digit, done by carrying on the digit string
 * itself: the value is a money figure and rule 90 forbids routing it through a
 * double to round it. Null passes through; a lexeme that is not a plain
 * decimal is returned unchanged rather than mangled.
 */
export function roundUsdCents(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d+)(?:\.(\d*))?$/u.exec(value);
  if (match === null) return value;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length <= 2) return value;
  const kept = fraction.slice(0, 2).padEnd(2, "0");
  const roundUp = (fraction[2] ?? "0") >= "5";
  const cents = BigInt(whole) * 100n + BigInt(kept) + (roundUp ? 1n : 0n);
  const digits = (cents / 100n).toString();
  const remainder = (cents % 100n).toString().padStart(2, "0");
  return `${digits}.${remainder}`;
}

function shapeRow(
  row: TopTraderRow,
  priceUsd: string | null,
  sanitized: Set<string>
): Record<string, unknown> {
  return {
    maker: row.maker,
    // A provider-supplied display label. Written by DexScreener rather than by
    // a token issuer, but still provider text and still sanitized.
    label: sanitizeIssuerField(row.label, `traders.${row.maker}.label`, sanitized),
    url: row.url,
    providerRank: row.providerRank,
    buys: row.buys,
    sells: row.sells,
    volumeUsdBuy: row.volumeUsdBuy,
    volumeUsdSell: row.volumeUsdSell,
    netCashFlowUsd: row.netCashFlowUsd,
    amountBuy: row.amountBuy,
    amountSell: row.amountSell,
    balanceAmount: row.balanceAmount,
    ...holdingValue(row, priceUsd),
    retainedBoughtPct: row.retainedBoughtPct,
    firstSwapAtMs: row.firstSwapAtMs,
    lastSwapAtMs: row.lastSwapAtMs,
    activeSpanSeconds: row.activeSpanSeconds,
  };
}

/**
 * Cohort totals across the RETURNED rows.
 *
 * Every figure names its coverage, because the cohort is a bounded leaderboard
 * and a sum over it is never a sum over the pair.
 */
function cohortSummary(rows: readonly TopTraderRow[]): Record<string, unknown> {
  let netCashFlowUsd: number | null = null;
  let boughtUsd: number | null = null;
  let soldUsd: number | null = null;
  let buySide = 0;
  let sellSide = 0;
  for (const row of rows) {
    if (row.netCashFlowUsd !== null) {
      netCashFlowUsd = (netCashFlowUsd ?? 0) + row.netCashFlowUsd;
    }
    if (row.volumeUsdBuy !== null) boughtUsd = (boughtUsd ?? 0) + row.volumeUsdBuy;
    if (row.volumeUsdSell !== null) soldUsd = (soldUsd ?? 0) + row.volumeUsdSell;
    if ((row.buys ?? 0) > 0) buySide += 1;
    if ((row.sells ?? 0) > 0) sellSide += 1;
  }
  return {
    rowsCovered: rows.length,
    netCashFlowUsd,
    boughtUsd,
    soldUsd,
    buySideCount: buySide,
    sellSideCount: sellSide,
    note: "Totals across the RETURNED rows only, which are a bounded leaderboard and not the pair. netCashFlowUsd is how many dollars this cohort has taken out net; it is not the cohort's profit and it is not the pair's net flow. buySideCount and sellSideCount count wallets that have traded on each side and say nothing about whether they still hold anything.",
  };
}

function summarize(
  symbol: string | null,
  all: readonly TopTraderRow[],
  returned: number,
  sortBy: TopTraderSort,
  onlyKol: boolean
): string {
  const subject = symbol ?? "this pair";
  if (all.length === 0) {
    return onlyKol
      ? `The key-opinion-leader filter returned no wallets for ${subject}. This filter was measured returning zero rows on a busy pair, so it is not evidence about who traded ${subject}.`
      : `The provider returned no ranked wallets for ${subject} under these filters.`;
  }
  return `${returned} of ${all.length} wallets on ${subject}'s leaderboard, ranked by ${sortBy}. This is one bounded leaderboard with no continuation; wallets below it are unreachable.`;
}
