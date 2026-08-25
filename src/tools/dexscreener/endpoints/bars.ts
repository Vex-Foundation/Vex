/**
 * OHLCV bars, on BOTH transports, with the block-anchored time-range walk.
 *
 * NAMED OMISSION (provider-depth decree). `volumeToken0` and `volumeToken1`
 * arrive on the WebSocket transport and are NOT projected, and no
 * volume-weighted average price is derived from them. They are raw fixed-point
 * strings and DexScreener publishes no token decimals on this API: a captured
 * PEPE bar carries a normal 4.58 million USD volume next to a 24-digit token
 * volume. Any of the three would be wrong by a power of ten, which on a money
 * path is a defect and not an approximation. They return when decimals and
 * orientation are proven against an independent source. That is the only
 * omission from this channel's useful surface.
 *
 * NAMED OMISSION 2 (provider-depth decree). `cs` on the HTTP chart endpoint is
 * a CIRCULATING-SUPPLY OVERRIDE and it is measured honoured: `mc=1&cs=1000000000`
 * returns the price series multiplied by exactly 1e9, overriding the provider's
 * own supply. It is deliberately NOT exposed. `series: marketCap` sends `mc=1`
 * alone, which returns the PROVIDER-COMPUTED market cap (measured matching the
 * WebSocket `BAR_TYPE_MARKET_CAP` series exactly on every completed bar), and a
 * caller-supplied supply would produce a market-cap chart that looks
 * authoritative and is whatever number the caller passed. Under rule 90 a model
 * may not originate a value that changes what a money figure means, so the
 * capability is named here rather than shipped. It returns if a caller ever has
 * an independently sourced supply and the answer can say whose it is.
 *
 * NOT AN OMISSION, A CORRECTION: `mc=1` does NOT need `cs`. Recon recorded that
 * it did; measured false, and the manifest's "market-cap bars need no supply
 * argument" is honest on BOTH transports.
 *
 * THE TRANSPORT SPLIT IS A PROVIDER FACT, NOT A MISSING CAPABILITY.
 *
 *  - HTTP `/dex/chart/amm/v3/{ammId}/bars/{chain}/{pairId}` serves `1S` through
 *    `720` and answers HTTP 400 for `5S` and for daily and above (measured).
 *  - The feed WebSocket `getHistoricalBars` serves every one of the 18
 *    resolutions including `S5`, `D1`, `W1` and `MO1`, and serves market-cap
 *    bars with NO supply argument.
 *
 * So the resolution decides the transport. Both were measured agreeing exactly:
 * across 999 H1 bars, all 998 COMPLETED bars matched on native close, USD close
 * and USD volume; only the forming bar differed between two responses five
 * seconds apart. That is why `lastBarPartial` is mandatory on every answer
 * rather than advisory.
 *
 * THE TIME-RANGE STRATEGY, AND WHY ITS ANCHOR IS APPROXIMATE BY CONTRACT.
 * `endAtMs` is resolved to a block by asking the trades channel for the nearest
 * transaction at or before that instant, then candles are anchored with
 * `bbn = block + 1`. Measured: a 90-day-old target cost 980 ms and 33 KB
 * against 1,582 ms and 436 KB for a naive three-page walk. But the anchor is
 * the nearest PRIOR TRADE, and on the measured run it sat 393 SECONDS before
 * the requested instant. That distance is real and is reported
 * (`anchorResolvedAtMs`, `anchorDistanceMs`); when no trade is found near
 * `endAtMs`, or the distance exceeds ten resolution steps, the anchor is
 * abandoned for the backward walk from now and `anchorFallback` says so.
 *
 * `abn` (afterBlockNumber) is MEASURED DEAD as a forward anchor: with a block
 * from 2024 it returned the newest 48 bars, 88 days past the target. It appears
 * nowhere in this module by design.
 */

import {
  PL_BARS_RESPONSE,
  type PlBar,
} from "../codec/dsavro-schemas.js";
import { decodeDsAvro } from "../codec/dsavro.js";
import { encodeDexScreenerCommand } from "../codec/encode.js";
import { decodeDexScreenerMessageToJson } from "../codec/protobuf.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";
import { DEXSCREENER_FEED_WS_URL } from "./pair-live.js";

/** The site host that serves the HTTP chart endpoint. */
export const DEXSCREENER_CHART_ORIGIN = "https://io.dexscreener.com";

/**
 * Bars the provider serves in ONE call, on either transport. Measured on both.
 *
 * 999 is a CAP, not a page size: on the WebSocket, `limit` of 999, 1000, 1500,
 * 2000, 2001, 5000 and 100000 all answer OK with exactly 999 bars, byte-
 * identical, so anything larger is accepted and silently clamped. Recon's
 * "limit 2000 accepted" was true and misleading.
 *
 * THE LOWER BOUND IS LOAD-BEARING AND MUST STAY. A `limit` of -1 TEARS THE
 * SOCKET DOWN with no answer at all (measured 4 of 4 attempts across two
 * spaced sessions), and `limit` of 0 returns an empty page that is
 * indistinguishable from a genuine end of history. Nothing in this module ever
 * sends a negative count today, because the walk always asks for
 * `BARS_PER_CALL` and the tool's own `limit` is floored at 1; that floor is
 * the guard, and removing it as "an unnecessary bound" would reintroduce a
 * caller-reachable path to killing the connection.
 */
export const BARS_PER_CALL = 999;

/**
 * Byte ceiling for one bars page.
 *
 * Measured 145,550 bytes for 999 H1 bars over HTTP and 271,802 over the
 * WebSocket. Two megabytes bounds a page an order of magnitude above the
 * measured worst case; over-cap is a typed rejection naming the cap.
 */
export const BARS_MAX_BYTES = 2_000_000;

/**
 * COUNTABLE frames to collect on the feed socket while looking for the answer.
 *
 * ONE, because `feed/ws` is strictly request-response: one command produces
 * exactly one countable frame and that frame IS the answer. Measured 2026-08-25
 * against the live endpoint, with the bridge's own frame accounting: a bars
 * command produced `[13873, 0, 0]` with the 13,873-byte `historicalBars`
 * answer arriving at t=0.38 s and every later frame a zero-length keepalive.
 * The same shape on trades (`[27484, 0, 0]`, answer at 0.54 s) and on token
 * insight (`[6, 0, 0]`, answer at 0.15 s), and a rejected argument answers with
 * a 6-byte frame that is likewise the first and only countable one.
 *
 * THIS VALUE WAS 4 AND THAT WAS A GUARANTEED TIMEOUT. A zero-length binary
 * frame is a keepalive and does not count toward `binaryFrames` (the
 * `WsExpectation` contract), so a budget above the number of countable frames
 * the channel actually emits can never be met: the exchange blocks until
 * `CHANNEL_TIMEOUT_MS` and throws `TRANSPORT_TIMEOUT` while holding the answer
 * that arrived in under a second. The keepalives used to pad the count and
 * mask it; they no longer do.
 *
 * The arithmetic any change must satisfy: frames x inter-frame interval must
 * stay under the caller's deadline. On this channel the interval after the
 * answer is INFINITE, because no further countable frame is ever sent, so any
 * value above 1 fails that test outright rather than merely being slow.
 * Dispatch is on the protobuf oneof and the correlation id, never on frame
 * index, so a lead frame would still be handled correctly if one ever appeared.
 */
export const BARS_FRAMES = 1;

/** Frozen walk bounds (plan section 14.5). The agent may raise both explicitly. */
export const BARS_MAX_PAGES_DEFAULT = 10;
export const BARS_DEADLINE_MS_DEFAULT = 25_000;
export const BARS_DEADLINE_MS_CEILING = 120_000;

/**
 * How far the block anchor may sit from the requested instant before it is
 * abandoned, expressed in resolution steps (plan 14.5).
 */
export const ANCHOR_MAX_RESOLUTION_STEPS = 10;

/* ------------------------------------------------------------------ */
/* The resolution vocabulary                                           */
/* ------------------------------------------------------------------ */

/** The 18 resolutions the provider serves across both transports. */
export const BAR_RESOLUTIONS = [
  "1s", "5s", "15s", "30s",
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "8h", "12h",
  "1d", "3d", "1w", "1mo",
] as const;

export type BarResolution = (typeof BAR_RESOLUTIONS)[number];

interface ResolutionSpec {
  /** The value the HTTP `res` parameter takes, or null when HTTP refuses it. */
  readonly httpRes: string | null;
  /** The `dex_feed.BarResolution` enum member. Every resolution has one. */
  readonly wsEnum: string;
  /** One bar's nominal span in milliseconds, for gap and anchor arithmetic. */
  readonly stepMs: number;
}

/**
 * Per-resolution transport and step table.
 *
 * `httpRes: null` records a MEASURED 400 from the HTTP endpoint, not a guess:
 * `5S` and every resolution of a day and above were probed live and refused.
 * Month steps use 30 days, which is a nominal span used only for gap counting
 * and anchor distance; it is never used to date a bar.
 */
const RESOLUTIONS: Readonly<Record<BarResolution, ResolutionSpec>> = {
  "1s": { httpRes: "1S", wsEnum: "BAR_RESOLUTION_S1", stepMs: 1_000 },
  "5s": { httpRes: null, wsEnum: "BAR_RESOLUTION_S5", stepMs: 5_000 },
  "15s": { httpRes: "15S", wsEnum: "BAR_RESOLUTION_S15", stepMs: 15_000 },
  "30s": { httpRes: "30S", wsEnum: "BAR_RESOLUTION_S30", stepMs: 30_000 },
  "1m": { httpRes: "1", wsEnum: "BAR_RESOLUTION_M1", stepMs: 60_000 },
  "3m": { httpRes: "3", wsEnum: "BAR_RESOLUTION_M3", stepMs: 180_000 },
  "5m": { httpRes: "5", wsEnum: "BAR_RESOLUTION_M5", stepMs: 300_000 },
  "15m": { httpRes: "15", wsEnum: "BAR_RESOLUTION_M15", stepMs: 900_000 },
  "30m": { httpRes: "30", wsEnum: "BAR_RESOLUTION_M30", stepMs: 1_800_000 },
  "1h": { httpRes: "60", wsEnum: "BAR_RESOLUTION_H1", stepMs: 3_600_000 },
  "2h": { httpRes: "120", wsEnum: "BAR_RESOLUTION_H2", stepMs: 7_200_000 },
  "4h": { httpRes: "240", wsEnum: "BAR_RESOLUTION_H4", stepMs: 14_400_000 },
  "8h": { httpRes: "480", wsEnum: "BAR_RESOLUTION_H8", stepMs: 28_800_000 },
  "12h": { httpRes: "720", wsEnum: "BAR_RESOLUTION_H12", stepMs: 43_200_000 },
  "1d": { httpRes: null, wsEnum: "BAR_RESOLUTION_D1", stepMs: 86_400_000 },
  "3d": { httpRes: null, wsEnum: "BAR_RESOLUTION_D3", stepMs: 259_200_000 },
  "1w": { httpRes: null, wsEnum: "BAR_RESOLUTION_W1", stepMs: 604_800_000 },
  "1mo": { httpRes: null, wsEnum: "BAR_RESOLUTION_MO1", stepMs: 2_592_000_000 },
};

/** Which transport serves a resolution. HTTP is preferred: it is 40 percent smaller. */
export type BarTransport = "http" | "feed_ws";

export function barTransportFor(resolution: BarResolution): BarTransport {
  return RESOLUTIONS[resolution].httpRes === null ? "feed_ws" : "http";
}

/** One bar's nominal span in milliseconds. */
export function barStepMs(resolution: BarResolution): number {
  return RESOLUTIONS[resolution].stepMs;
}

/**
 * How far the block anchor may sit from the requested instant, in milliseconds.
 *
 * Ten resolution steps (plan 14.5). Scaling with the resolution is the point:
 * the measured 393-second miss is a rounding error on a daily chart and a
 * different question entirely on a 5-second one, so one absolute tolerance
 * would be either useless or wrong depending on the request.
 */
export function resolveAnchorFallbackThreshold(
  resolution: BarResolution
): number {
  return RESOLUTIONS[resolution].stepMs * ANCHOR_MAX_RESOLUTION_STEPS;
}

/** Which series to read. Market-cap bars need NO supply argument on either transport. */
export type BarSeries = "price" | "marketCap";

/* ------------------------------------------------------------------ */
/* Projected bars                                                      */
/* ------------------------------------------------------------------ */

/**
 * One candle.
 *
 * Every price is a DECIMAL STRING, exactly as the provider sent it, and stays
 * one all the way to the model. These are token amounts on a money path and
 * must never round-trip through binary floating point.
 */
export interface ProjectedBar {
  readonly timestampMs: number;
  readonly openNative: string | null;
  readonly highNative: string | null;
  readonly lowNative: string | null;
  readonly closeNative: string | null;
  readonly openUsd: string | null;
  readonly highUsd: string | null;
  readonly lowUsd: string | null;
  readonly closeUsd: string | null;
  readonly volumeUsd: string | null;
  readonly minBlockNumber: number | null;
  readonly maxBlockNumber: number | null;
}

/** One provider page of bars, oldest first. */
export interface BarsPage {
  readonly bars: readonly ProjectedBar[];
  readonly transport: BarTransport;
  /** The URL the page was fetched from, or the socket it was commanded on. */
  readonly url: string;
  readonly bytes: number;
  readonly fetchedAtMs: number;
}

export interface BarsPageOptions {
  readonly transport: DexScreenerTransport;
  readonly chainId: string;
  readonly pairAddress: string;
  readonly ammId: string;
  /**
   * The pair's OWN quote token, verbatim from `resolvePairSubject`.
   *
   * NEVER caller-supplied and NEVER re-cased. See the invariant recorded on
   * `PairSubject.quoteTokenAddress`: this endpoint answers HTTP 200 with a
   * SILENTLY INVERTED series for a `q` that is omitted, wrong, or merely
   * lower-cased, and the inverted answer is indistinguishable from a correct
   * one at the row level. Measured here at seventeen orders of magnitude
   * (native 0.000000001683 against 593955106.9585) and re-measured on the
   * WebSocket transport, which expresses the same orientation as
   * `quoteTokenId`.
   */
  readonly quoteTokenAddress: string;
  readonly resolution: BarResolution;
  readonly series: BarSeries;
  readonly inverted: boolean;
  /** Bars to ask for. The provider caps at 999 on both transports. */
  readonly countBack: number;
  /** Anchor: return bars strictly BEFORE this block. Omit for the newest page. */
  readonly beforeBlockNumber?: number;
  /**
   * Correlation id for the socket command.
   *
   * The feed socket MULTIPLEXES: an answer is this call's answer only when its
   * `cid` matches, and a module-wide constant would make two concurrent calls
   * indistinguishable. It defaults to a fresh value per call, and is settable
   * so a test can replay a capture taken under the id the site itself used.
   */
  readonly correlationId?: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Fetch ONE page of bars on whichever transport serves the resolution. */
export async function fetchBarsPage(
  options: BarsPageOptions
): Promise<BarsPage> {
  return barTransportFor(options.resolution) === "http"
    ? fetchBarsPageHttp(options)
    : fetchBarsPageWs(options);
}

/* --- HTTP transport -------------------------------------------------- */

/** Build the HTTP chart URL. Exported so the query grammar has a testable owner. */
export function barsHttpUrl(options: BarsPageOptions): string {
  const res = RESOLUTIONS[options.resolution].httpRes;
  if (res === null) {
    throw siteError(
      DexScreenerSiteErrorCodes.BARS_RESOLUTION_UNSUPPORTED,
      `The DexScreener HTTP chart endpoint does not serve ${options.resolution} bars`,
      "This resolution is served on the feed WebSocket instead, which the tool selects itself. Reaching this refusal means the transport choice was bypassed."
    );
  }
  const query = new URLSearchParams({
    res,
    cb: String(options.countBack),
    q: options.quoteTokenAddress,
  });
  if (options.beforeBlockNumber !== undefined) {
    query.set("bbn", String(options.beforeBlockNumber));
  }
  if (options.inverted) query.set("i", "1");
  if (options.series === "marketCap") query.set("mc", "1");
  // The Solana pair id and `q` are CASE-SENSITIVE on this route, so neither is
  // re-cased here; only the chain slug is a vocabulary value.
  return (
    `${DEXSCREENER_CHART_ORIGIN}/dex/chart/amm/v3/${encodeURIComponent(options.ammId)}`
    + `/bars/${encodeURIComponent(options.chainId)}/${encodeURIComponent(options.pairAddress)}`
    + `?${query.toString()}`
  );
}

async function fetchBarsPageHttp(options: BarsPageOptions): Promise<BarsPage> {
  const url = barsHttpUrl(options);
  const response = await options.transport.httpGet(url, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBytes: BARS_MAX_BYTES,
  });
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.BARS_INVALID,
      `The DexScreener chart endpoint answered HTTP ${response.status} for ${options.resolution} bars on ${options.chainId}:${options.pairAddress}`,
      "Check the AMM id and quote token against dexscreener__pair_get. A non-200 here is an endpoint or routing problem, not proof that the pool has no price history."
    );
  }
  let decoded: { readonly bars?: readonly PlBar[] | null };
  try {
    decoded = decodeDsAvro(PL_BARS_RESPONSE, response.body).value;
  } catch (error) {
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    throw siteError(
      DexScreenerSiteErrorCodes.BARS_INVALID,
      `${response.body.byteLength} bytes from the chart endpoint did not decode as ${PL_BARS_RESPONSE.label}`,
      "The Avro field order may have changed. Re-capture the fixture and update the schema table before trusting this channel."
    );
  }
  return {
    bars: (decoded.bars ?? []).map(projectHttpBar),
    transport: "http",
    url,
    bytes: response.body.byteLength,
    fetchedAtMs: Date.now(),
  };
}

/**
 * Project one HTTP bar.
 *
 * The HTTP schema names the native columns `open`/`high`/`low`/`close` and the
 * dollar columns `openUsd` and friends; the WebSocket names them `openNative`
 * and `openUSD`. Both project into the same row so a caller cannot tell which
 * transport answered from the data, only from the reported `transport` field.
 */
function projectHttpBar(bar: PlBar): ProjectedBar {
  const native = orderExtremes(emptyToNull(bar.high), emptyToNull(bar.low));
  const usd = orderExtremes(emptyToNull(bar.highUsd), emptyToNull(bar.lowUsd));
  return {
    timestampMs: bar.timestamp,
    openNative: emptyToNull(bar.open),
    highNative: native.high,
    lowNative: native.low,
    closeNative: emptyToNull(bar.close),
    openUsd: emptyToNull(bar.openUsd),
    highUsd: usd.high,
    lowUsd: usd.low,
    closeUsd: emptyToNull(bar.closeUsd),
    volumeUsd: emptyToNull(bar.volumeUsd),
    minBlockNumber: finite(bar.minBlockNumber),
    maxBlockNumber: finite(bar.maxBlockNumber),
  };
}

/**
 * Put a bar's high and low the right way round.
 *
 * The provider TRANSPOSES the USD high and low columns on the inverted series:
 * measured 2026-08-24 on ethereum:0xA43fe169... at 1h, 853 of 999 rows came
 * back with `highUSD < lowUSD`, against 0 of 999 on the byte-identical
 * non-inverted call, while the native columns were correctly ordered in both.
 * The extremes were read straight through, so the reported period high sat
 * BELOW the true high and the reported low ABOVE the true low: a wrong number
 * on a money path, reachable with `inverted: true` alone because `priceBasis`
 * defaults to usd.
 *
 * Both bases are normalized, not just the one measured wrong: high means high
 * everywhere, and a per-row invariant is cheaper to hold than to condition on
 * a provider quirk that may move.
 *
 * The LEXEMES are swapped, never re-rendered, so no decimal precision is lost.
 * A value that is not a finite number is left where the provider put it: there
 * is nothing to compare, and inventing an order would be worse than keeping
 * one that is merely unproven.
 */
function orderExtremes(
  high: string | null,
  low: string | null
): { readonly high: string | null; readonly low: string | null } {
  if (high === null || low === null) return { high, low };
  const highN = Number(high);
  const lowN = Number(low);
  if (!Number.isFinite(highN) || !Number.isFinite(lowN)) return { high, low };
  return highN >= lowN ? { high, low } : { high: low, low: high };
}

/* --- Feed WebSocket transport ---------------------------------------- */

/**
 * A fresh correlation id per command, in 1..1,000,000.
 *
 * Per CALL, never per module: the socket multiplexes, so two concurrent bars
 * requests sharing one id could each read the other's answer.
 *
 * The range starts at 1 rather than 0 because dispatch is by id and 0 is the
 * value an OMITTED cid decodes to, so a zero would make "this call's answer"
 * and "an answer to a command that named no call" the same match. That an
 * omitted cid goes UNANSWERED was recorded once as a provider property and is
 * NOT one: the same shape was answered on a later measurement, with 2,747
 * bytes at 0.79 s. It is an observation, not a contract, and nothing here
 * depends on it either way.
 */
let barsCidCounter = 0;

function nextBarsCid(): number {
  barsCidCounter = (barsCidCounter % 1_000_000) + 1;
  return barsCidCounter;
}

async function fetchBarsPageWs(options: BarsPageOptions): Promise<BarsPage> {
  const spec = RESOLUTIONS[options.resolution];
  const cid = options.correlationId ?? nextBarsCid();
  // `inverted` is expressed by SWAPPING the quote token on this transport: the
  // command carries a quoteTokenId and no inversion flag. The caller therefore
  // gets an inverted series only when it can name the other side of the pair,
  // which the subject resolver always can.
  const command = encodeDexScreenerCommand("dex_feed.WSCommand", {
    getHistoricalBars: {
      cid,
      limit: options.countBack,
      chainId: options.chainId,
      pairId: options.pairAddress,
      ammId: options.ammId,
      resolution: spec.wsEnum,
      // MARKET_CAP takes NO supply argument on this transport (measured).
      type: options.series === "marketCap" ? "BAR_TYPE_MARKET_CAP" : "BAR_TYPE_PRICE",
      quoteTokenId: options.quoteTokenAddress,
      ...(options.beforeBlockNumber === undefined
        ? {}
        : { beforeBlockNumber: String(options.beforeBlockNumber) }),
    },
  });

  const frames = await options.transport.wsExchange(DEXSCREENER_FEED_WS_URL, {
    send: [command],
    expect: { binaryFrames: BARS_FRAMES, maxTotalBytes: BARS_MAX_BYTES },
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const page = readBarsFrames(frames, cid);
  if (page === null) {
    throw siteError(
      DexScreenerSiteErrorCodes.BARS_NO_RESULT_FRAME,
      `The DexScreener feed socket sent ${frames.length} binary frames without a historicalBars answer for ${options.resolution} bars on ${options.chainId}:${options.pairAddress}`,
      "The socket answered, so this is neither an outage nor proof the pool has no history. Retry once; if it repeats, check the AMM id and quote token with dexscreener__pair_get."
    );
  }
  return {
    ...page,
    transport: "feed_ws",
    url: DEXSCREENER_FEED_WS_URL,
    bytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0),
    fetchedAtMs: Date.now(),
  };
}

/**
 * Find this call's bars among the frames the feed socket sent.
 *
 * Exported because the two contracts that matter here are provable from
 * captured bytes alone: dispatch is on the protobuf ONEOF and the CORRELATION
 * ID, never on frame position, and a frame carrying a non-OK command code is
 * an answer of "none" rather than a decode failure.
 */
export function readBarsFrames(
  frames: readonly Uint8Array[],
  cid: number
): { readonly bars: readonly ProjectedBar[] } | null {
  for (const bytes of frames) {
    if (bytes.byteLength === 0) continue;
    let decoded: unknown;
    try {
      decoded = decodeDexScreenerMessageToJson("dex_feed.WSMessage", bytes, {
        maxBytes: BARS_MAX_BYTES,
      });
    } catch (error) {
      if (
        isDexScreenerSiteError(error) &&
        error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
      ) {
        throw error;
      }
      continue;
    }
    const arm = asObject(asObject(decoded)?.["historicalBars"]);
    if (arm === null) continue;
    if (readNumber(arm["cid"]) !== cid) continue;
    const bars = Array.isArray(arm["bars"]) ? arm["bars"] : [];
    return { bars: bars.map(projectWsBar) };
  }
  return null;
}

function projectWsBar(value: unknown): ProjectedBar {
  const bar = asObject(value) ?? {};
  const timestamp = bar["timestamp"];
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  const native = orderExtremes(str(bar["highNative"]), str(bar["lowNative"]));
  const usd = orderExtremes(str(bar["highUSD"]), str(bar["lowUSD"]));
  return {
    timestampMs: Number.isNaN(parsed)
      ? (finite(readNumber(timestamp)) ?? 0)
      : parsed,
    openNative: str(bar["openNative"]),
    highNative: native.high,
    lowNative: native.low,
    closeNative: str(bar["closeNative"]),
    openUsd: str(bar["openUSD"]),
    highUsd: usd.high,
    lowUsd: usd.low,
    closeUsd: str(bar["closeUSD"]),
    volumeUsd: str(bar["volumeUSD"]),
    minBlockNumber: readNumber(bar["minBlockNumber"]),
    maxBlockNumber: readNumber(bar["maxBlockNumber"]),
  };
}

/* ------------------------------------------------------------------ */
/* The bounded backward walk                                           */
/* ------------------------------------------------------------------ */

/** Why a walk stopped. Every one of these is reported to the model. */
export type WalkStopReason =
  /** The requested `startAtMs` was covered. */
  | "satisfied"
  /**
   * `limit` was already satisfied, so no further page could contribute a row.
   *
   * Distinct from `satisfied`: the requested range may extend below the oldest
   * bar returned, and the cursor reaches it. Fetching on regardless was
   * measured costing a second 144 KB page that returned the identical 999 rows
   * and the identical cursor.
   */
  | "row_bound"
  /**
   * The provider returned NO BARS for this subject. AMBIGUOUS BY CONSTRUCTION.
   *
   * It does NOT mean "this is the pool's first block", which is what this
   * reason used to claim. Measured 2026-08-25: a wrong `ammId`, a wrong chain
   * slug and a wrong `pairId` each answer HTTP 200 with a BYTE-IDENTICAL empty
   * page (8 bytes, sha 64a53c9b) to a genuine end of history, to `cb=0` and to
   * a pre-genesis `bbn`. The bytes cannot separate "walked to the beginning"
   * from "asked about something that does not exist", so nothing downstream
   * may either. The subject is resolver-supplied rather than caller-supplied,
   * which makes a wrong identity unlikely here rather than impossible, and the
   * handler states the ambiguity instead of resolving it by assertion.
   */
  | "provider_exhausted"
  /** `maxPages` was reached. The answer is truncated and carries a cursor. */
  | "page_budget"
  /** `deadlineMs` was reached. The answer is truncated and carries a cursor. */
  | "deadline";

export interface BarsWalkResult {
  /** Every bar collected, oldest first, de-duplicated across pages. */
  readonly bars: readonly ProjectedBar[];
  readonly transport: BarTransport;
  readonly pagesWalked: number;
  readonly bytes: number;
  readonly stopReason: WalkStopReason;
  /**
   * The exact block cursor for the next page back, when one exists.
   *
   * `minBlockNumber` of the OLDEST bar collected. A block cursor and not a
   * timestamp, because the provider anchors on blocks and a timestamp cursor
   * would re-introduce the anchor's approximation on every page.
   */
  readonly nextBeforeBlock: number | null;
  readonly fetchedAtMs: number;
}

export interface BarsWalkOptions extends Omit<BarsPageOptions, "countBack"> {
  /** Bars the caller wants. Pages of up to 999 are walked until it is met. */
  readonly limit: number;
  /** Walk back at least until this instant is covered. Optional. */
  readonly startAtMs?: number;
  readonly maxPages: number;
  readonly deadlineMs: number;
}

/**
 * Walk backward from the anchor until the caller's window is covered or a
 * declared bound is hit.
 *
 * BOUNDS ARE REPORTED, NEVER SILENT. Hitting `maxPages` or `deadlineMs`
 * produces `stopReason` plus `nextBeforeBlock`, so every bar not returned is
 * reachable by asking again. That is a bound under the no-silent-cutting
 * decree's own test, not a truncation.
 */
export async function walkBars(
  options: BarsWalkOptions
): Promise<BarsWalkResult> {
  const startedAtMs = Date.now();
  const collected: ProjectedBar[] = [];
  const seenTimestamps = new Set<number>();
  let beforeBlock = options.beforeBlockNumber;
  let pagesWalked = 0;
  let bytes = 0;
  let stopReason: WalkStopReason = "satisfied";
  let transport: BarTransport = barTransportFor(options.resolution);

  for (;;) {
    if (pagesWalked >= options.maxPages) {
      stopReason = "page_budget";
      break;
    }
    if (Date.now() - startedAtMs >= options.deadlineMs) {
      stopReason = "deadline";
      break;
    }
    const remaining = options.deadlineMs - (Date.now() - startedAtMs);
    const page = await fetchBarsPage({
      ...options,
      countBack: BARS_PER_CALL,
      ...(beforeBlock === undefined ? {} : { beforeBlockNumber: beforeBlock }),
      timeoutMs: Math.max(1, Math.min(options.timeoutMs, remaining)),
    });
    pagesWalked += 1;
    bytes += page.bytes;
    transport = page.transport;

    if (page.bars.length === 0) {
      stopReason = "provider_exhausted";
      break;
    }
    // Pages are exclusive on both transports (measured: no minBlockNumber
    // overlap between adjacent pages), but the timestamp set is deduplicated
    // anyway so a provider that starts overlapping cannot double-count volume.
    for (const bar of page.bars) {
      if (seenTimestamps.has(bar.timestampMs)) continue;
      seenTimestamps.add(bar.timestampMs);
      collected.push(bar);
    }

    const oldest = oldestOf(collected);
    if (oldest === null) {
      stopReason = "provider_exhausted";
      break;
    }
    const coveredStart =
      options.startAtMs === undefined || oldest.timestampMs <= options.startAtMs;
    // Count only bars the caller can actually receive. `limit` keeps the
    // NEWEST rows, so once that many in-range bars are in hand every further
    // page is bytes the answer will discard.
    const startAtMs = options.startAtMs;
    const usableRows =
      startAtMs === undefined
        ? collected.length
        : collected.filter((bar) => bar.timestampMs >= startAtMs).length;
    const enoughRows = usableRows >= options.limit;
    if (coveredStart) break;
    if (enoughRows) {
      stopReason = "row_bound";
      break;
    }
    if (oldest.minBlockNumber === null) {
      // Without a block on the oldest bar there is no exact cursor, so the walk
      // stops rather than guessing one and risking a skipped or repeated page.
      stopReason = "provider_exhausted";
      break;
    }
    beforeBlock = oldest.minBlockNumber;
  }

  collected.sort((left, right) => left.timestampMs - right.timestampMs);
  const oldest = collected[0];
  return {
    bars: collected,
    transport,
    pagesWalked,
    bytes,
    stopReason,
    nextBeforeBlock:
      stopReason === "provider_exhausted" || oldest === undefined
        ? null
        : oldest.minBlockNumber,
    fetchedAtMs: Date.now(),
  };
}

function oldestOf(bars: readonly ProjectedBar[]): ProjectedBar | null {
  let oldest: ProjectedBar | null = null;
  for (const bar of bars) {
    if (oldest === null || bar.timestampMs < oldest.timestampMs) oldest = bar;
  }
  return oldest;
}

/* ------------------------------------------------------------------ */
/* Value readers                                                       */
/* ------------------------------------------------------------------ */

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** uint64 renders as a STRING in protobuf JSON; both forms are read exactly. */
function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
