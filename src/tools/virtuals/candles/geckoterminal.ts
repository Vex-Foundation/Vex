/**
 * OHLCV candles for a Virtuals agent, from GeckoTerminal's PUBLIC v2 API.
 *
 * WHY THIS PROVIDER AND NOT THE OBVIOUS ONE. Virtuals ships a candle endpoint,
 * `vp-api.virtuals.io/vp-api/klines`, and it is dead: twelve live probes across
 * two granularities, five windows, seconds and milliseconds, and three tokens -
 * including one whose TRADES tape was non-empty in the same session - every one
 * returned `{"Klines":[]}`. The production front end never calls it either.
 * GeckoTerminal is what app.virtuals.io actually renders a graduated agent's
 * chart from (captured live on agent 96200's page).
 *
 * WHICH GECKOTERMINAL. The app's own chart uses
 * `app.geckoterminal.com/api/p1/candlesticks/<id>/<id>`, whose two numeric ids
 * are internal to GeckoTerminal's front end and are not derivable from a pool
 * address by any public call. Building on them would mean guessing identifiers.
 * This module uses the PUBLIC, address-keyed sibling instead:
 *
 *   GET api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/{timeframe}
 *       ?aggregate=&limit=&currency=&token=&before_timestamp=
 *
 * verified live on 2026-09-04 against the Robinhood pool of agent 96200, the
 * Base pool of agent 18820, and a Solana Meteora pool.
 *
 * THE BOUNDS ARE THE PROVIDER'S OWN WORDS, read out of its 400s rather than
 * spelled from convention:
 *
 *   ohlcv/week            -> 400 "Invalid timeframe. Allowed values: day, hour, minute, second"
 *   ?limit=2000           -> 400 "Invalid limit. must be positive integer less than or equal to 1000"
 *   ?aggregate=7          -> 400 "Invalid aggregate. Allowed values: 1, 4, 12"
 *
 * WHAT IS NOT COVERED, AND WHY IT IS A REFUSAL RATHER THAN AN EMPTY LIST. A
 * bonding-curve pair on an EVM chain is not an indexed AMM pool: the live
 * bonding pair of agent 139082 answered 404 Not Found. Solana is the exception -
 * its bonding pools are Meteora DBC pools that GeckoTerminal does index, and a
 * live Solana bonding pool returned real candles. So the honest matrix is per
 * chain AND per lifecycle stage, and `readGeckoTerminalCandles` reports a
 * not-indexed pool as exactly that.
 *
 * RATE LIMIT. The free tier is tight and undocumented in the response headers:
 * five calls spaced 1.2 s apart earned a 429 pointing at CoinGecko's paid
 * plans. This module runs its own slow bucket and surfaces a 429 as a
 * retryable failure rather than as "no candles".
 */

import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import logger from "../../../utils/logger.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import { VexError, ErrorCodes } from "../../../errors.js";
import { VirtualsThrottle, parseRetryAfterMs } from "../throttle.js";
import type { VirtualsChain } from "../types.js";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

/**
 * GeckoTerminal's network slug per Virtuals chain. `base`, `robinhood` and
 * `solana` were each exercised live; `eth` is GeckoTerminal's documented slug
 * for Ethereum but no Virtuals agent on ETH has been probed through it, so the
 * tool reports that cell as unverified rather than claiming coverage.
 */
const GECKOTERMINAL_NETWORK: Record<VirtualsChain, string> = {
  BASE: "base",
  ROBINHOOD: "robinhood",
  SOLANA: "solana",
  ETH: "eth",
};

/** Read out of the provider's own 400. */
export const GECKOTERMINAL_TIMEFRAMES = ["minute", "hour", "day"] as const;
export type GeckoTerminalTimeframe = (typeof GECKOTERMINAL_TIMEFRAMES)[number];

/**
 * `second` is legal upstream but omitted here on purpose: a Virtuals agent's
 * chart is never read at second resolution and the bucket count explodes.
 * Named as an omission in `../Virtuals.md` rather than silently dropped.
 */
export const GECKOTERMINAL_OMITTED_TIMEFRAMES = ["second"] as const;

/**
 * `aggregate` is PER TIMEFRAME, and getting that wrong is how the first live
 * run of this module failed: `hour` accepts 1/4/12, so `timeframe: "day",
 * aggregate: 4` looked legal against a single global set and came back 400.
 * Each row is quoted from the provider's own rejection:
 *
 *   ohlcv/day?aggregate=4     -> 400 "Invalid aggregate. Allowed values: 1"
 *   ohlcv/hour?aggregate=7    -> 400 "Invalid aggregate. Allowed values: 1, 4, 12"
 *   ohlcv/minute?aggregate=4  -> 400 "Invalid aggregate. Allowed values: 1, 5, 15"
 *
 * and each accepted value was then sent live and answered 200.
 */
export const GECKOTERMINAL_AGGREGATES_BY_TIMEFRAME = {
  minute: [1, 5, 15],
  hour: [1, 4, 12],
  day: [1],
} as const satisfies Record<string, readonly number[]>;

/** Every aggregate legal on SOME timeframe - the schema-level superset. */
export const GECKOTERMINAL_AGGREGATES = [1, 4, 5, 12, 15] as const;
export type GeckoTerminalAggregate = (typeof GECKOTERMINAL_AGGREGATES)[number];

/** The aggregates this timeframe accepts, for a refusal that names them. */
export function geckoTerminalAggregatesFor(
  timeframe: GeckoTerminalTimeframe,
): readonly number[] {
  return GECKOTERMINAL_AGGREGATES_BY_TIMEFRAME[timeframe];
}

/** The provider's own ceiling, quoted from its 400, not a number we chose. */
export const GECKOTERMINAL_MAX_LIMIT = 1000;

/**
 * One candle. Timestamps are unix SECONDS; prices and volume are kept as the
 * DECIMAL STRINGS we render them into, never re-exported as JS floats - the
 * provider sends bare numbers and a float is not a token amount (rule 90).
 */
export interface VirtualsCandle {
  timestampSeconds: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Quote-side volume for the bucket, in the requested `currency`. */
  volume: string;
}

export interface GeckoTerminalCandlesFound {
  found: true;
  candles: VirtualsCandle[];
  network: string;
  poolAddress: string;
}

/** The pool exists nowhere in GeckoTerminal's index (its own 404). */
export interface GeckoTerminalPoolNotIndexed {
  found: false;
  reason: string;
}

export type GeckoTerminalCandlesResult =
  | GeckoTerminalCandlesFound
  | GeckoTerminalPoolNotIndexed;

/**
 * Five calls at 1.2 s apart earned a 429, so this bucket is deliberately an
 * order of magnitude slower than the Strapi one and the cache TTL is longer:
 * a candle bucket does not close more than once a minute at the finest
 * resolution this module exposes.
 */
const throttle = new VirtualsThrottle({ ratePerMinute: 6, ttlMs: 60_000 });

function decimal(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // `toFixed(20)` would pad noise; `toString()` can emit exponent notation on
    // very small prices, which is still a faithful decimal rendering of the
    // number the provider sent, so it is kept verbatim rather than reshaped.
    return String(v);
  }
  if (typeof v === "string" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return v;
  return null;
}

function readCandle(raw: unknown): VirtualsCandle | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const ts = raw[0];
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const [open, high, low, close, volume] = [raw[1], raw[2], raw[3], raw[4], raw[5]].map(decimal);
  if (open === null || high === null || low === null || close === null || volume === null) {
    return null;
  }
  return { timestampSeconds: ts, open, high, low, close, volume };
}

export interface ReadGeckoTerminalCandlesParams {
  chain: VirtualsChain;
  /** The AMM pool: `lpAddress` once graduated, `preTokenPair` while bonding. */
  poolAddress: string;
  timeframe: GeckoTerminalTimeframe;
  aggregate: GeckoTerminalAggregate;
  limit: number;
  /** Walk backwards: ask for buckets strictly before this unix-seconds mark. */
  beforeTimestampSeconds?: number;
  /** `usd` (default) or `token` - the provider's own two values. */
  currency?: "usd" | "token";
}

/**
 * Read OHLCV for one pool.
 *
 * @returns `{ found: false, reason }` when GeckoTerminal answers 404 - the pool
 * is not in its index, which for an EVM bonding pair is the expected state and
 * is a different fact from "this pool has no trades".
 * @throws a mapped {@link VexError} on 429 or any other upstream failure, so a
 * rate limit is never mistaken for an empty chart.
 */
export async function readGeckoTerminalCandles(
  params: ReadGeckoTerminalCandlesParams,
): Promise<GeckoTerminalCandlesResult> {
  const network = GECKOTERMINAL_NETWORK[params.chain];
  const url = new URL(
    `${GECKOTERMINAL_BASE}/networks/${network}/pools/${encodeURIComponent(params.poolAddress)}`
    + `/ohlcv/${params.timeframe}`,
  );
  url.searchParams.set("aggregate", String(params.aggregate));
  url.searchParams.set("limit", String(Math.min(Math.max(1, params.limit), GECKOTERMINAL_MAX_LIMIT)));
  url.searchParams.set("currency", params.currency ?? "usd");
  if (params.beforeTimestampSeconds !== undefined) {
    url.searchParams.set("before_timestamp", String(params.beforeTimestampSeconds));
  }
  const href = url.toString();

  return throttle.run(href, throttle.defaultTtlMs, async () => {
    const response = await fetchWithTimeout(href, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    if (response.status === 404) {
      return {
        found: false,
        reason:
          `GeckoTerminal does not index pool ${params.poolAddress} on ${network}. On an EVM chain `
          + "that is the expected answer for a bonding-curve pair: the curve is not an AMM pool, so "
          + "no OHLCV provider has a history for it. Read the live tape with "
          + "virtuals__agent_trades_list instead, or the 24 h series the agent row carries.",
      } satisfies GeckoTerminalPoolNotIndexed;
    }

    if (!response.ok) {
      const raw = await readJson(response);
      if (response.status === 429) {
        throttle.penalize(parseRetryAfterMs(response.headers?.get?.("retry-after"), 60_000));
        const err = new VexError(
          ErrorCodes.VIRTUALS_RATE_LIMITED,
          "GeckoTerminal rate limited the candle request (HTTP 429).",
          "GeckoTerminal's free tier is tight and shared across this process. Wait and retry, or "
          + "ask for a coarser timeframe so one call covers the window.",
        );
        err.retryable = true;
        err.httpStatus = 429;
        throw err;
      }
      logger.warn("virtuals.geckoterminal.http_error", {
        status: response.status,
        network,
        detail: raw === null ? null : JSON.stringify(raw).slice(0, 200),
      });
      const err = new VexError(
        ErrorCodes.VIRTUALS_API_ERROR,
        `GeckoTerminal returned HTTP ${response.status} for the candle request.`,
        // The provider states its own legal values in the 400 body, and that
        // sentence is more useful to the agent than anything we could author.
        "GeckoTerminal states the legal timeframe, aggregate and limit in its own rejection; "
        + "re-read the tool's parameter descriptions and try again.",
      );
      err.httpStatus = response.status;
      err.retryable = response.status >= 500;
      throw err;
    }

    const raw = await readJson(response);
    const attributes = isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.attributes)
      ? raw.data.attributes
      : null;
    const list = attributes !== null && Array.isArray(attributes.ohlcv_list)
      ? attributes.ohlcv_list
      : [];
    const candles = list
      .map(readCandle)
      .filter((c): c is VirtualsCandle => c !== null)
      // The provider returns newest-first; oldest-first is what a chart and a
      // human both read, and stating the order beats leaving it implicit.
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    return {
      found: true,
      candles,
      network,
      poolAddress: params.poolAddress,
    } satisfies GeckoTerminalCandlesFound;
  });
}
