/**
 * The pair-local trader leaderboard.
 *
 * `GET /dex/log/amm/v5/{ammId}/top/{chain}/{pairId}?q=&s=&sd=[&mda=][&k=1]`
 *
 * Site Avro, decoded against the `TOPMAKERS` table S1 proved byte-exact
 * against a captured response. 12 to 14 KB, about 250 ms, up to 100 rows.
 *
 * SEVEN MEASURED FACTS THAT SHAPE THIS MODULE.
 *
 *  1. `s` AND `sd` ARE REQUIRED. The provider does not default them, so this
 *     module always sends both and the tool's `sortBy` has no "unset" state.
 *  2. `lpId` IS IGNORED. Three requests on a live Pump.fun bonding pair at
 *     98.21 percent progress (no `lpId`, `lpId=pumpfun`, `lpId=wrong`) each
 *     returned the identical 13,085-byte body with one SHA-256. It is not sent
 *     and not exposed: a parameter that changes nothing is a lie about the
 *     surface.
 *  3. THE SET IS UP TO 100 ROWS, NOT EXACTLY 100. `k=1` (the KOL filter)
 *     returned ZERO rows on the measured pair, so a tool promising 100 would
 *     be wrong exactly when the filter is used.
 *  4. THERE IS NO CONTINUATION. No offset, no cursor, no page parameter. One
 *     bounded leaderboard, and the wallets beyond it are unreachable. That is
 *     `bounded_non_pageable` and it is stated rather than papered over with
 *     client-side slicing that would advertise paging that does not exist.
 *     Re-proven 2026-08-25 by direct fuzz: `limit`, `offset` and `page` each
 *     returned a body byte-identical to the baseline, with `cf-cache-status:
 *     MISS` on the variants, so this is the origin ignoring them and not a
 *     shared cache entry.
 *  5. `q` IS THE ORIENTATION KEY AND IT IS CASE-SENSITIVE. See the invariant
 *     recorded on `PairSubject.quoteTokenAddress`. A `q` that is wrong, that
 *     names the BASE token, or that is merely the correct address LOWER-CASED
 *     answers HTTP 200 with the pair INVERTED: measured on ethereum PEPE, the
 *     correct `q=0xC02aaA39...` gave the top maker `buys 956, volumeUsdBuy
 *     5,219,201.99, amountBuy "1468926772500.29"` (PEPE), and
 *     `q=0xc02aaa39...` gave `buys 864, volumeUsdBuy 4,315,234.24, amountBuy
 *     "1913.84"` (WETH) - buy and sell transposed, amounts in the other token,
 *     and 200 with 100 plausible rows either way. `netCashFlowUsd` FLIPS SIGN
 *     under it. So `q` is passed verbatim from `resolvePairSubject` and is
 *     never re-cased or hand-built anywhere on this path.
 *  6. AN AMOUNT LEXEME IS ALREADY A PROVIDER ROUNDING, AND THE LAW IS
 *     SIGNIFICANT DIGITS, NOT DECIMAL PLACES. `amountBuy`, `amountSell` and
 *     `balanceAmount` arrive as human decimal strings carrying about 15 to 16
 *     SIGNIFICANT digits, wherever the decimal point falls. Measured over 600
 *     live rows: the widest are `"1464600134847.065"` (16 significant) and
 *     `"183173121587.015"` (15), while a small balance keeps going well past
 *     four decimal places to reach the same precision (`"0.0001992"`, seven
 *     decimal places; `"0.008341"`, six). An earlier note here read "at most
 *     four fractional digits", which was an artefact of sampling only large
 *     balances and was false of every small one. The arithmetic over these
 *     lexemes is exact, but the inputs are not: the true amount can differ in
 *     the figures below that precision, so a derived product must not be
 *     presented at eighteen significant digits as though it were.
 *  7. `label` AND `url` WERE EMPTY ON 100 PERCENT OF 1,300 LIVE ROWS across
 *     four pairs. The fields exist in the wire schema and are kept, but a null
 *     there is the provider's normal and is not information about the wallet.
 *
 * SEMANTICS, CORRECTED. The provider's four ranks are named `bought`, `sold`,
 * `pnl` and `unrealized`. Two of those names are wrong about what they
 * measure and this module does not repeat them:
 *
 *  - "pnl" is `volumeUsdSell - volumeUsdBuy`, i.e. NET CASH FLOW on this pair.
 *    Cost basis and transfers are invisible to a venue, so it is not profit.
 *  - "unrealized" is `priceUsd * balanceAmount`, i.e. what the position is
 *    worth NOW. It is not unrealized profit.
 *
 * `lastSwap - firstSwap` is an ACTIVE TRADING SPAN, not a holding period, and
 * `balancePercentage` is retained share of what the wallet bought, not supply.
 * Nothing here emits a profit, exit, or smart-money claim.
 */

import { TOPMAKERS, type TopMaker } from "../codec/dsavro-schemas.js";
import { decodeDsAvro } from "../codec/dsavro.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";

/** The site host that serves the leaderboard. */
export const DEXSCREENER_TOP_TRADERS_ORIGIN = "https://io.dexscreener.com";

/** The provider's bounded leaderboard size. Up to, not exactly. */
export const TOP_TRADERS_PROVIDER_WINDOW = 100;

/**
 * The provider's own lookback ceiling, in days, measured live 2026-08-24.
 *
 * `mda=30` returns the same makers as omitting it; `mda=31`, `mda=60`,
 * `mda=90` and `mda=365` each answer HTTP 400 with an empty body. This is the
 * provider's bound, not a Vex policy, and it is stated so a caller learns it
 * from a refusal instead of from a 400 that blames the wrong thing.
 */
export const TOP_TRADERS_LOOKBACK_DAYS_MAX = 30;

/**
 * Byte ceiling for one leaderboard.
 *
 * Measured 11,265 to 14,123 bytes across the four sorts. One megabyte bounds
 * it two orders of magnitude above the measured worst case.
 */
export const TOP_TRADERS_MAX_BYTES = 1_000_000;

/**
 * The public sort vocabulary, and its mapping onto the provider's own.
 *
 * The public names say what the column MEASURES; the provider's names say what
 * DexScreener calls it. Two of the provider's names are wrong (see the module
 * header), and repeating a wrong name in a tool schema would put the error in
 * front of the model on every call.
 */
export const TOP_TRADER_SORTS = [
  "boughtUsd", "soldUsd", "netCashFlowUsd", "currentHoldingValueUsd",
] as const;

export type TopTraderSort = (typeof TOP_TRADER_SORTS)[number];

const PROVIDER_SORT: Readonly<Record<TopTraderSort, string>> = {
  boughtUsd: "bought",
  soldUsd: "sold",
  netCashFlowUsd: "pnl",
  currentHoldingValueUsd: "unrealized",
};

/** One wallet's aggregate over the pair, with corrected semantics. */
export interface TopTraderRow {
  readonly maker: string;
  /** A provider-supplied display label, when it has one. Issuer-independent. */
  readonly label: string | null;
  readonly url: string | null;
  readonly buys: number | null;
  readonly sells: number | null;
  readonly volumeUsdBuy: number | null;
  readonly volumeUsdSell: number | null;
  /** Base-token amounts, decimal strings, never floats. */
  readonly amountBuy: string | null;
  readonly amountSell: string | null;
  readonly balanceAmount: string | null;
  /**
   * `balanceAmount / volumeBuy * 100`: retained share of what this wallet
   * BOUGHT on this pair. NOT percent of token supply.
   */
  readonly retainedBoughtPct: number | null;
  readonly firstSwapAtMs: number | null;
  readonly lastSwapAtMs: number | null;
  /**
   * `volumeUsdSell - volumeUsdBuy`: net cash flow on this pair.
   *
   * NOT realized profit: cost basis and transfers are invisible to the venue.
   */
  readonly netCashFlowUsd: number | null;
  /**
   * `lastSwap - firstSwap`: the span over which this wallet traded the pair.
   *
   * NOT a holding period. A wallet that bought once and sold once an hour
   * later has a one-hour span whether or not it still holds anything.
   */
  readonly activeSpanSeconds: number | null;
  /** 1-based position in the provider's own ranking. */
  readonly providerRank: number;
}

/** One leaderboard. */
export interface TopTradersDocument {
  readonly rows: readonly TopTraderRow[];
  readonly sortBy: TopTraderSort;
  readonly providerSortKey: string;
  readonly sortDir: "asc" | "desc";
  readonly lookbackDays: number | null;
  readonly onlyKol: boolean;
  readonly url: string;
  readonly bytes: number;
  readonly fetchedAtMs: number;
  /**
   * The response headers of the HTTP read that produced this, when there was
   * one.
   *
   * S10-36: `sourceObservation` hardcoded cacheState "not_cached" on this
   * family, which asserts freshness for documents the edge may have held for
   * up to 25 seconds. `cf-cache-status` and `age` are the only evidence either
   * way, so they travel with the document instead of being dropped here.
   * ABSENT on a WebSocket page, where no cache sits between a frame and its
   * socket and `not_cached` really is the truth.
   */
  readonly responseHeaders?: ReadonlyMap<string, string>;
}

export interface TopTradersOptions {
  readonly transport: DexScreenerTransport;
  readonly chainId: string;
  readonly pairAddress: string;
  readonly ammId: string;
  /**
   * The pair's OWN quote token, VERBATIM from the subject resolver.
   *
   * Never re-cased, never hand-built, never caller-supplied. See fact 5 in the
   * module header and the invariant on `PairSubject.quoteTokenAddress`: a
   * lower-cased spelling of the CORRECT address silently inverts the whole
   * leaderboard and flips the sign of `netCashFlowUsd`.
   */
  readonly quoteTokenAddress: string;
  readonly sortBy: TopTraderSort;
  readonly sortDir: "asc" | "desc";
  /** The provider's `mda`. Omitted means the pair's whole history. */
  readonly lookbackDays?: number;
  /** The provider's `k=1`. Measured returning zero rows on the probed pair. */
  readonly onlyKol: boolean;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Build the leaderboard URL. Exported so the query grammar has a testable owner. */
export function topTradersUrl(options: TopTradersOptions): string {
  const query = new URLSearchParams({
    q: options.quoteTokenAddress,
    // Both are REQUIRED by the provider, so neither is conditional.
    s: PROVIDER_SORT[options.sortBy],
    sd: options.sortDir,
  });
  if (options.lookbackDays !== undefined) {
    query.set("mda", String(options.lookbackDays));
  }
  if (options.onlyKol) query.set("k", "1");
  // `lpId` is deliberately absent: measured byte-identical with and without it.
  return (
    `${DEXSCREENER_TOP_TRADERS_ORIGIN}/dex/log/amm/v5/${encodeURIComponent(options.ammId)}`
    + `/top/${encodeURIComponent(options.chainId)}/${encodeURIComponent(options.pairAddress)}`
    + `?${query.toString()}`
  );
}

/** Fetch and project one leaderboard. */
export async function fetchTopTraders(
  options: TopTradersOptions
): Promise<TopTradersDocument> {
  const url = topTradersUrl(options);
  const response = await options.transport.httpGet(url, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBytes: TOP_TRADERS_MAX_BYTES,
  });
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.TOP_TRADERS_INVALID,
      `The DexScreener top-traders endpoint answered HTTP ${response.status} for ${options.chainId}:${options.pairAddress}`,
      response.status === 404
        ? "A 404 on this route is a WRONG AMM ID for this pair: measured, a uniswap pair asked for as solamm and a solamm pair asked for as pumpfundex each answered 404 with an empty body, while every valid identity answered 200. It is not a statement that nobody traded the pool and it is not a 400. Re-resolve the AMM id with dexscreener__pair_get and ask again; the provider sends no error body on this route, so the status is the whole diagnosis."
        : `A non-200 here is an endpoint or routing problem, not proof that nobody traded this pool. Check the AMM id and quote token with dexscreener__pair_get. Every input this tool can send is already bounded to what the provider accepts (the closed sort vocabulary, the required direction, and a lookback of 1 to ${TOP_TRADERS_LOOKBACK_DAYS_MAX}), so a 400 reaching here would mean the route grammar changed rather than that a parameter was out of range; the realistic non-200 is 404, which means the AMM id does not match this pair.`
    );
  }
  return {
    rows: parseTopTraders(response.body),
    sortBy: options.sortBy,
    providerSortKey: PROVIDER_SORT[options.sortBy],
    sortDir: options.sortDir,
    lookbackDays: options.lookbackDays ?? null,
    onlyKol: options.onlyKol,
    url,
    bytes: response.body.byteLength,
    fetchedAtMs: Date.now(),
    responseHeaders: response.headers,
  };
}

/**
 * Decode and project one leaderboard body.
 *
 * Exported without the transport so the projection has a testable owner, the
 * same shape every sibling endpoint module uses.
 */
export function parseTopTraders(body: Uint8Array): readonly TopTraderRow[] {
  let rows: readonly TopMaker[];
  try {
    rows = decodeDsAvro(TOPMAKERS, body).value;
  } catch (error) {
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    throw siteError(
      DexScreenerSiteErrorCodes.TOP_TRADERS_INVALID,
      `${body.byteLength} bytes from /dex/log/amm/v5 did not decode as ${TOPMAKERS.label}`,
      "The Avro field order may have changed. Re-capture the fixture and update the schema table before trusting this endpoint."
    );
  }
  return rows.map((row, index) => projectRow(row, index + 1));
}

function projectRow(row: TopMaker, providerRank: number): TopTraderRow {
  const buyUsd = finite(row.volumeUsdBuy);
  const sellUsd = finite(row.volumeUsdSell);
  const firstSwapAtMs = finite(row.firstSwap);
  const lastSwapAtMs = finite(row.lastSwap);
  return {
    maker: row.maker,
    label: text(row.label),
    url: text(row.url),
    buys: finite(row.buys),
    sells: finite(row.sells),
    volumeUsdBuy: buyUsd,
    volumeUsdSell: sellUsd,
    amountBuy: text(row.amountBuy),
    amountSell: text(row.amountSell),
    balanceAmount: text(row.balanceAmount),
    retainedBoughtPct: finite(row.balancePercentage),
    firstSwapAtMs,
    lastSwapAtMs,
    // Null and not zero when either side is missing: an unknown flow and a
    // balanced flow are different facts and a reader must be able to tell.
    netCashFlowUsd: buyUsd === null || sellUsd === null ? null : sellUsd - buyUsd,
    activeSpanSeconds:
      firstSwapAtMs === null || lastSwapAtMs === null
        ? null
        : Math.max(0, Math.round((lastSwapAtMs - firstSwapAtMs) / 1000)),
    providerRank,
  };
}

/* ------------------------------------------------------------------ */
/* Exact decimal multiplication                                        */
/* ------------------------------------------------------------------ */

/**
 * Longest decimal lexeme either factor may carry. Both arrive as PROVIDER
 * input, so the digit count is bounded before any BigInt work.
 */
export const HOLDING_VALUE_MAX_LEXEME_CHARS = 64;

const PLAIN_DECIMAL = /^\d{1,40}(?:\.\d{1,40})?$/u;

/**
 * `a * b` for two plain non-negative decimal STRINGS, exactly, or null when
 * either lexeme is not one.
 *
 * WHY NOT `Number`. Both factors are money-path values: a token balance whose
 * integer part runs to twelve digits and a price whose significant digits
 * start six places after the point. `Number("298880636640.41") * Number(
 * "0.000004051")` is a binary approximation of a decimal product, and rule 90
 * forbids floating point on a token amount. Scaling two integers and adding
 * their scales is exact by construction: no rounding step exists to get wrong.
 *
 * Deliberately local rather than reused from `token-watch-price/decimal.ts`:
 * that module is the wake watch's private vocabulary, has no multiply, and is
 * imported by nothing outside its own feature.
 */
export function multiplyDecimalStrings(a: string, b: string): string | null {
  const left = parseDecimalLexeme(a);
  const right = parseDecimalLexeme(b);
  if (left === null || right === null) return null;
  return formatDecimal(
    left.units * right.units,
    left.scale + right.scale
  );
}

interface ScaledDecimal {
  readonly units: bigint;
  readonly scale: number;
}

function parseDecimalLexeme(raw: string): ScaledDecimal | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > HOLDING_VALUE_MAX_LEXEME_CHARS) {
    return null;
  }
  if (!PLAIN_DECIMAL.test(trimmed)) return null;
  const point = trimmed.indexOf(".");
  if (point === -1) return { units: BigInt(trimmed), scale: 0 };
  const fraction = trimmed.slice(point + 1);
  return {
    units: BigInt(trimmed.slice(0, point) + fraction),
    scale: fraction.length,
  };
}

/** Plain decimal notation, no exponent, no trailing fraction zeros. */
function formatDecimal(units: bigint, scale: number): string {
  const digits = units.toString();
  if (scale === 0) return digits;
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale).replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
