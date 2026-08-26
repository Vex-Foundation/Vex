/**
 * The v7 pairs screener channel client.
 *
 * `wss://io.dexscreener.com/dex/screener/v7/pairs/{tf}/{page}?{qs}`
 *
 * Shape of the interaction, measured: connect, receive frames, take the first
 * `pairs` frame, close. While a client stays subscribed the channel pushes a
 * full 100-row snapshot every ~3.2 s (no deltas, ~29 KB/s) plus a
 * `latestBlock` frame about every second. A tool wants one snapshot, so it
 * takes one and leaves.
 *
 * FRAME POSITION IS NOT A CONTRACT. The first binary frame was `latestBlock`
 * in 72 of 74 measured sessions, and in the two others it was not. Every
 * consumer therefore dispatches on the protobuf oneof, never on frame index.
 * This module asks the transport for several frames precisely so that a
 * `latestBlock` (18 bytes) arriving first cannot be mistaken for the answer.
 *
 * NO CACHING. The screener channels carry no cache headers and the ranking is
 * live; a cached page would be a stale ranking presented as current. The
 * throttle module's TTL cache is deliberately not used here.
 */

import {
  decodeDexScreenerMessageToJson,
  type DexScreenerMessageName,
} from "../codec/protobuf.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";
import type { ScreenQuery } from "../screen-core/request.js";

/** The site host that serves both screener channels. */
export const DEXSCREENER_SITE_WS_ORIGIN = "wss://io.dexscreener.com";

/** Rows the provider puts on one page. Fixed by the provider, not by us. */
export const SCREENER_ROWS_PER_PAGE = 100;

/**
 * Frames to collect on the first attempt.
 *
 * Six covers a `latestBlock` burst before the snapshot: at roughly one block
 * frame per second and a snapshot inside a second, five leading block frames
 * would already be an outlier.
 */
export const SCREENER_FIRST_ATTEMPT_FRAMES = 6;

/** Frames to collect on the single retry, when six produced no snapshot. */
export const SCREENER_RETRY_FRAMES = 10;

/**
 * Byte ceiling across all collected frames, and the per-frame decode cap.
 *
 * A 100-row page measures 42 to 93 KB. Four megabytes is far above any
 * measured page and still bounds a misbehaving or hostile channel. Exceeding
 * it is a typed rejection naming the cap, never a partial page.
 */
export const SCREENER_MAX_TOTAL_BYTES = 4_000_000;

/** One decoded snapshot frame, still in provider vocabulary. */
export interface ScreenerFrame {
  /** The raw `dex_screener_schema.Pair` rows, for `projectPairRow`. */
  readonly rows: readonly unknown[];
  /**
   * The provider's `pairsCount`. On the PAIRS channel this is a live
   * server-side estimate of the whole matched set (measured drifting about
   * 6.6 percent inside 30 seconds). On the TOKENS channel it is the page
   * length and nothing more; see `fetchTokensPage`.
   */
  readonly pairsCount: number | null;
  /** The frame's `stats` block, for `projectMarketStats`. */
  readonly stats: unknown;
}

/** The most recent block the channel reported during the exchange. */
export interface ScreenerLatestBlock {
  readonly blockNumber: string | null;
  readonly blockTimestampMs: number | null;
}

export interface ScreenerPageResult {
  readonly frame: ScreenerFrame;
  /** The newest `latestBlock` seen in the exchange, or null when none arrived. */
  readonly latestBlock: ScreenerLatestBlock | null;
  /** The URL the exchange actually opened. */
  readonly url: string;
  /** 1-based provider page. */
  readonly page: number;
  /** How many binary frames arrived before the snapshot was found, across all attempts. */
  readonly framesReceived: number;
  /** Position of the snapshot among the frames of the attempt that found it, 0-based. */
  readonly snapshotFrameIndex: number;
  /** 1 when the first attempt succeeded, 2 when the retry was needed. */
  readonly attempts: number;
  readonly fetchedAtMs: number;
}

export interface ScreenerPageOptions {
  /** 1-based provider page. Page 1 is the first page; there is no page 0. */
  readonly page: number;
  readonly transport: DexScreenerTransport;
  /** Hard deadline for ONE attempt, in milliseconds. The retry gets its own. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch one page of the v7 pairs screener channel.
 *
 * Returns the first frame whose oneof is `pairs`, plus the newest
 * `latestBlock` observed while looking for it. When no snapshot arrives within
 * `SCREENER_FIRST_ATTEMPT_FRAMES`, ONE retry asks for
 * `SCREENER_RETRY_FRAMES`; after that the failure is typed and names what did
 * arrive, so "the channel only sent block updates" never reads as "the
 * provider has no rows".
 */
export async function fetchScreenerPage(
  query: ScreenQuery,
  options: ScreenerPageOptions
): Promise<ScreenerPageResult> {
  return fetchScreenerChannelPage(
    "/dex/screener/v7/pairs",
    "dex_screener.PairsChannelMessage",
    query,
    options
  );
}

/**
 * The shared channel exchange for both screener channels.
 *
 * Exported because `tokens-screener.ts` is the second consumer of exactly this
 * mechanism: same path grammar, same oneof, same frame-order hazard, different
 * message name and different honesty facts about the count.
 */
export async function fetchScreenerChannelPage(
  pathPrefix: string,
  message: DexScreenerMessageName,
  query: ScreenQuery,
  options: ScreenerPageOptions
): Promise<ScreenerPageResult> {
  if (!Number.isInteger(options.page) || options.page < 1) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_FILTER_VALUE_INVALID,
      `The screener channel pages from 1; received page ${String(options.page)}`,
      "Pass a whole page number of 1 or more."
    );
  }

  const url = `${DEXSCREENER_SITE_WS_ORIGIN}${pathPrefix}/${query.timeframe}/${options.page}?${query.queryString}`;
  const seen: FrameCensus = { cases: [], byteSizes: [], undecodable: 0 };
  let framesReceived = 0;
  let latestBlock: ScreenerLatestBlock | null = null;

  for (const [attemptIndex, binaryFrames] of [
    SCREENER_FIRST_ATTEMPT_FRAMES,
    SCREENER_RETRY_FRAMES,
  ].entries()) {
    throwIfAborted(options.signal, url);
    const frames = await options.transport.wsExchange(url, {
      expect: { binaryFrames, maxTotalBytes: SCREENER_MAX_TOTAL_BYTES },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    framesReceived += frames.length;

    for (const [frameIndex, bytes] of frames.entries()) {
      if (bytes.byteLength === 0) {
        // Zero-length binary keepalives exist on the site's WS surfaces.
        seen.cases.push("keepalive");
        seen.byteSizes.push(0);
        continue;
      }
      const decoded = decodeFrame(message, bytes, seen);
      if (decoded === null) continue;
      const block = readLatestBlock(decoded);
      if (block !== null) latestBlock = block;
      const frame = readSnapshot(decoded);
      if (frame === null) continue;
      return {
        frame,
        latestBlock,
        url,
        page: options.page,
        framesReceived,
        snapshotFrameIndex: frameIndex,
        attempts: attemptIndex + 1,
        fetchedAtMs: Date.now(),
      };
    }
  }

  throw siteError(
    DexScreenerSiteErrorCodes.SCREEN_NO_RESULT_FRAME,
    `The DexScreener screener channel sent ${framesReceived} binary frames across two attempts (asking for ${SCREENER_FIRST_ATTEMPT_FRAMES} then ${SCREENER_RETRY_FRAMES}) without a result frame. Frame kinds in order: ${seen.cases.join(", ") || "none"}. Frame sizes in bytes: ${seen.byteSizes.join(", ") || "none"}. Frames that did not decode as ${message}: ${seen.undecodable}`,
    "The channel answered, so this is not an outage and not an empty result set. Retry once; if it persists, re-run the descriptor drift test, because a schema change would make every frame undecodable."
  );
}

interface FrameCensus {
  readonly cases: string[];
  readonly byteSizes: number[];
  undecodable: number;
}

type JsonObject = Record<string, unknown>;

/**
 * Decode one frame, or record it as undecodable and move on.
 *
 * A frame that does not decode must not abort the search: the goal is the
 * snapshot, and every frame that failed is counted and named in the failure
 * message if the snapshot never comes. A cap rejection is different, and is
 * rethrown: it is the caller's own bound being hit, not provider noise.
 */
function decodeFrame(
  message: DexScreenerMessageName,
  bytes: Uint8Array,
  seen: FrameCensus
): JsonObject | null {
  seen.byteSizes.push(bytes.byteLength);
  try {
    const json = decodeDexScreenerMessageToJson(message, bytes, {
      maxBytes: SCREENER_MAX_TOTAL_BYTES,
    });
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      seen.cases.push("not-a-message");
      seen.undecodable += 1;
      return null;
    }
    const object = json as JsonObject;
    seen.cases.push(Object.keys(object)[0] ?? "empty");
    return object;
  } catch (error) {
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    seen.cases.push("undecodable");
    seen.undecodable += 1;
    return null;
  }
}

/** The `pairs` arm of the oneof, or null when this frame is something else. */
function readSnapshot(frame: JsonObject): ScreenerFrame | null {
  const payload = asObject(frame["pairs"]);
  if (payload === null) return null;
  const rows = payload["pairs"];
  const pairsCount = payload["pairsCount"];
  return {
    rows: Array.isArray(rows) ? rows : [],
    pairsCount: readCount(pairsCount),
    stats: payload["stats"] ?? null,
  };
}

/** The `latestBlock` arm of the oneof, or null when this frame is something else. */
function readLatestBlock(frame: JsonObject): ScreenerLatestBlock | null {
  const outer = asObject(frame["latestBlock"]);
  if (outer === null) return null;
  const inner = asObject(outer["latestBlock"]);
  if (inner === null) return { blockNumber: null, blockTimestampMs: null };
  const blockNumber = inner["blockNumber"];
  const timestamp = inner["blockTimestamp"];
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return {
    blockNumber: typeof blockNumber === "string" ? blockNumber : null,
    blockTimestampMs: Number.isNaN(parsed) ? null : parsed,
  };
}

/**
 * `pairsCount` is a uint32 on the wire, so protobuf JSON renders it as a
 * number. A string form is accepted defensively and parsed exactly.
 */
function readCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string
): void {
  if (signal?.aborted !== true) return;
  throw siteError(
    DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
    `The screener request to ${new URL(url).host} was cancelled by the caller before the next attempt`,
    "Nothing was read; issue a new request if the result is still wanted."
  );
}
