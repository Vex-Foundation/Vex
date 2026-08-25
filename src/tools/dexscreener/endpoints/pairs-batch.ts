/**
 * The v8 explicit-identity pairs channel.
 *
 * `wss://io.dexscreener.com/dex/screener/v8/pairs-search`
 *
 * Unlike every other screener channel, the membership of the answer is NOT a
 * filter over the indexed population: it is the caller's own list of
 * `{chainId, id}` pairs, sent as a protobuf SUBSCRIBE COMMAND on the open
 * socket. That is why this module encodes a command instead of building a
 * query string.
 *
 * MEASURED BEHAVIOUR, ALL OF IT LOAD-BEARING (Codex live turn 2, archived and
 * hash-verified under `live-turn2/root/`):
 *
 *  1. NO INPUT CEILING WE NEED TO INVENT. Three ids answered in 593 ms; 140
 *     ids came back in one 144,557-byte frame; a 300-input probe completed.
 *     Owner decision D-DS5 forbids an artificial Vex-side cap, so large lists
 *     are CHUNKED here and the chunking is reported rather than refused.
 *  2. THE LAUNCHPAD EXCLUSION IS THE CHANNEL'S DEFAULT, AND IT IS LIFTED HERE.
 *     Sending no `filters` at all does NOT mean "no filtering": the channel
 *     then applies the site's own hidden `excludedDEXIds` default, which drops
 *     every bonding-curve pair. Measured (EP4 `c2` vs `c3`): 100 live Pump.fun
 *     and Meteora DBC ids returned 0 rows with no filters, and 100 of 100 -
 *     the exact requested set - with `filters.excludedDEXIds = [""]`. This
 *     module therefore sends that lift on EVERY subscribe, the same lift the
 *     screener family already applies. What still vanishes silently after the
 *     lift is a genuinely unresolvable identity: no error, no marker, no
 *     count. This module reconciles the request against the answer, and every
 *     input lands in exactly one accounting bucket.
 *  3. DUPLICATES ARE PRESERVED. The same id twice came back as two identical
 *     rows. They are collapsed here and counted, because a watchlist that
 *     happens to list a pair twice wants one row and wants to be told.
 *  4. A TOKEN ADDRESS RESOLVES TO ONE PROVIDER-CANONICAL PAIR, AND IT IS NOT
 *     THE DEEPEST. Measured: WETH resolved a $4.23M pool while a $117.31M pool
 *     existed; `ethereum:USDT` resolved a Curve pool holding $902. The pick is
 *     invariant to `rankBy`, so it is a provider index pick, not a ranking.
 *     `resolutionBasis` says `provider_canonical` so nobody reads the answer as
 *     "the main pool".
 *  5. PAGINATION IS REAL, AT A PAGE SIZE OF 500 ROWS. Measured on 700 distinct
 *     ids: page 1 = 500 rows, page 2 = 200, page 3 = 0, `pairsCount` = 700 on
 *     every page, pages disjoint and contiguous by `rankBy`. `pairsCount` is a
 *     TRUE TOTAL, so `pairsCount > rows so far` is the provider's own exact
 *     signal that another page exists, and this module walks it. `page = 0`
 *     answers nothing at all (open socket, zero frames), so paging starts at 1.
 *     An earlier reading of "pages past 1 come back empty" was taken only over
 *     inputs below the page size and was false.
 *
 * FRAME POSITION IS NOT A CONTRACT here either: dispatch is on the protobuf
 * oneof, never on frame index.
 */

import { encodeDexScreenerCommand } from "../codec/encode.js";
import {
  decodeDexScreenerMessageToJson,
} from "../codec/protobuf.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";
import type { ScreenWindow } from "../screen-core/request.js";

/** The channel URL. */
export const DEXSCREENER_BATCH_WS_URL =
  "wss://io.dexscreener.com/dex/screener/v8/pairs-search";

/**
 * Identities sent in ONE subscribe command.
 *
 * This is a CHUNK size, not a cap on what the tool accepts: a longer list is
 * split across several sequential exchanges and the split is reported. 700
 * distinct ids and 800 total entries were accepted in a single command with
 * nothing dropped, so the input side has no ceiling worth inventing; 500
 * matches the provider's own RESPONSE page size, which keeps the common chunk
 * to exactly one page while page-walking covers the case where it does not.
 */
export const BATCH_CHUNK_SIZE = 500;

/**
 * Rows the provider puts on one page. Measured exactly, not assumed: 700
 * distinct ids answered 500 then 200 then 0.
 *
 * This is documentation for the reader. The page walk itself is driven by
 * `pairsCount`, which the provider reports as a true total, so a change in the
 * page size cannot silently lose rows.
 *
 * COUPLED TO `BATCH_CHUNK_SIZE` ON PURPOSE, AND THAT COUPLING HIDES THE WALK.
 * The two constants are equal today, so a chunk can never exceed one page and
 * the multi-page branch below is unreachable through the tool's own requests:
 * only a provider that shrank its page, or a chunk size raised above it, will
 * ever enter it. That is why the walk keeps its replay regression instead of
 * relying on a live call to exercise it, and why lowering
 * `BATCH_PROVIDER_PAGE_SIZE` alone is a behaviour change rather than a
 * documentation edit.
 */
export const BATCH_PROVIDER_PAGE_SIZE = 500;

/**
 * Pages one chunk may walk before the walk is refused as runaway.
 *
 * At 500 rows a page this covers 5,000 rows for a single chunk, an order of
 * magnitude past `BATCH_CHUNK_SIZE`. Reaching it means `pairsCount` and the
 * rows disagree in a way the measured contract does not allow, so it fails by
 * name rather than looping.
 */
export const BATCH_MAX_PAGES_PER_CHUNK = 10;

/**
 * The launchpad-exclusion lift, sent on every subscribe.
 *
 * Omitting `filters` entirely leaves the channel's hidden `excludedDEXIds`
 * default in force, which drops every bonding-curve pair (measured: 100 live
 * Pump.fun / Meteora DBC ids -> 0 rows without it, 100 of 100 with it).
 * Sending the field at all, even holding one empty string, replaces that
 * default. The field name is the descriptor's own spelling.
 */
function batchSubscribeFilters(): { excludedDEXIds: string[] } {
  return { excludedDEXIds: [""] };
}

/**
 * Frames to collect per page while looking for the rows frame.
 *
 * ONE, because on this channel the first binary frame IS the answer and the
 * transport resolves only when the count is reached: asking for more does not
 * make an answer arrive sooner, it makes the caller WAIT for redundant copies
 * of it. Measured over a 45 s subscription (EP4 `d1-cadence-45s`): the first
 * frame is `pairs` at 612 ms, and every frame after it is a byte-identical
 * re-send of the same 2,834-byte snapshot every ~3.2 s. There is no
 * `latestBlock` arm on this channel at all, unlike the v7 screener, so there
 * is nothing to skip past.
 *
 * The previous 6 and 10 therefore bought nothing and cost about 17 s and 30 s
 * against a 20 s deadline: the retry could not complete before the budget
 * expired, so a chunk that needed it was guaranteed to time out with the
 * answer already in hand. Re-confirmed in S8: 100 bonding ids answered in a
 * single frame at 891 ms.
 */
export const BATCH_FIRST_ATTEMPT_FRAMES = 1;
/**
 * Frames to collect on the single retry per page.
 *
 * Three, not one: the retry exists for the case where the channel leads with
 * something other than `pairs` (a future arm, or a frame that did not decode),
 * which the measurement above never saw but which frame-index assumptions are
 * exactly how this codebase gets burned. At ~3.2 s a frame this is about 10 s,
 * inside the deadline with room to spare. Dispatch is still on the protobuf
 * oneof, never on frame position.
 */
export const BATCH_RETRY_FRAMES = 3;

/**
 * Byte ceiling across the frames of ONE chunk. A 140-row frame measured
 * 144,557 bytes; four megabytes bounds a chunk with ample room and matches the
 * screener channel's own ceiling.
 */
export const BATCH_MAX_TOTAL_BYTES = 4_000_000;

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

/** What an identity was asked for as. */
export type BatchIdentityKind = "pair" | "token";

/** One `{chainId, id}` the caller asked for, after parsing. */
export interface BatchIdentity {
  readonly chainId: string;
  readonly id: string;
  readonly kind: BatchIdentityKind;
  /** The exact string the caller wrote, echoed in every accounting bucket. */
  readonly raw: string;
}

export interface BatchQuery {
  readonly identities: readonly BatchIdentity[];
  readonly window: ScreenWindow;
  readonly rankKey: string;
  readonly rankOrder: "asc" | "desc";
}

export interface BatchOptions {
  readonly transport: DexScreenerTransport;
  /** Hard deadline for ONE chunk attempt, in milliseconds. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

export interface BatchChunkReport {
  /** 1-based chunk index. */
  readonly chunk: number;
  readonly identitiesSent: number;
  readonly rowsReturned: number;
  readonly framesReceived: number;
  /** 1 when the first attempt found the frame, 2 when the retry was needed. */
  readonly attempts: number;
  /** Provider pages walked for this chunk. 1 whenever the rows fit one page. */
  readonly pagesFetched: number;
  /**
   * The provider's own `pairsCount` from the last page of this chunk: how many
   * rows it says the chunk has in total, independent of how many it sent.
   * `null` when no page reported one.
   */
  readonly pairsCount: number | null;
}

export interface BatchResult {
  /**
   * The raw `dex_screener_schema.Pair` rows across every chunk, deduplicated
   * by `chainId:pairAddress`, in the order the provider returned them.
   */
  readonly rows: readonly unknown[];
  /**
   * The identities the provider answered for, as `chainId:id` lowercased,
   * so the caller can reconcile its request without re-reading rows.
   */
  readonly resolvedKeys: ReadonlySet<string>;
  readonly chunks: readonly BatchChunkReport[];
  readonly fetchedAtMs: number;
}

/**
 * Fetch every identity, chunk by chunk, sequentially.
 *
 * SEQUENTIAL ON PURPOSE. Each chunk is one WebSocket exchange against the same
 * provider host; running them concurrently would multiply the connection rate
 * against a host we reach as a browser user, for a latency win the tool does
 * not need. The chunk reports carry what it cost.
 *
 * A chunk that produces no rows frame after its retry FAILS the whole call
 * rather than returning a short list, because a silently missing chunk is
 * exactly the failure this channel's accounting exists to prevent.
 */
export async function fetchPairsBatch(
  query: BatchQuery,
  options: BatchOptions
): Promise<BatchResult> {
  if (query.identities.length === 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.BATCH_NO_INPUTS,
      "A batch lookup was made with no pair or token identities to resolve",
      "Pass at least one entry in `pairs` or `tokens`, spelled chain:address."
    );
  }

  const chunks: BatchChunkReport[] = [];
  const rows: unknown[] = [];
  const seenRowKeys = new Set<string>();
  const resolvedKeys = new Set<string>();

  const groups = chunkIdentities(query.identities, BATCH_CHUNK_SIZE);
  for (const [index, group] of groups.entries()) {
    throwIfAborted(options.signal);
    const chunk = await fetchOneChunk(group, query, options, index + 1);
    chunks.push(chunk.report);
    for (const row of chunk.rows) {
      const key = rowKey(row);
      // The provider preserves duplicate inputs as duplicate rows; the caller
      // asked for a set of pairs, so the row is collapsed here and the
      // duplicate INPUT is accounted separately by the caller.
      if (key !== null) {
        if (seenRowKeys.has(key)) continue;
        seenRowKeys.add(key);
        resolvedKeys.add(key);
      }
      rows.push(row);
    }
    // A token input is answered by a pair row, so the token's own key never
    // appears among the row keys. Record every base-token key too, so the
    // caller can tell a resolved token from an omitted one.
    for (const row of chunk.rows) {
      const tokenKey = baseTokenKey(row);
      if (tokenKey !== null) resolvedKeys.add(tokenKey);
    }
  }

  return { rows, resolvedKeys, chunks, fetchedAtMs: Date.now() };
}

interface ChunkOutcome {
  readonly rows: readonly unknown[];
  readonly report: BatchChunkReport;
}

/**
 * Fetch one chunk, walking provider pages until every row it claims is in hand.
 *
 * The continuation signal is the provider's own `pairsCount`, measured to be a
 * true total rather than a page count. The walk stops on the first of: rows
 * collected reaching that total, a page returning no rows, or the page ceiling.
 * A short walk is never presented as complete: a page that returns nothing
 * while `pairsCount` still promises more is a typed failure, not a quiet cut.
 */
async function fetchOneChunk(
  identities: readonly BatchIdentity[],
  query: BatchQuery,
  options: BatchOptions,
  chunkIndex: number
): Promise<ChunkOutcome> {
  const rows: unknown[] = [];
  let framesReceived = 0;
  let attempts = 0;
  let pairsCount: number | null = null;
  let page = 0;

  while (page < BATCH_MAX_PAGES_PER_CHUNK) {
    page += 1;
    throwIfAborted(options.signal);
    const result = await fetchOnePage(identities, query, options, chunkIndex, page);
    framesReceived += result.framesReceived;
    attempts = Math.max(attempts, result.attempts);
    if (result.pairsCount !== null) pairsCount = result.pairsCount;
    rows.push(...result.rows);

    if (result.rows.length === 0) break;
    if (pairsCount !== null && rows.length >= pairsCount) break;
    if (pairsCount === null) {
      // No continuation signal. A short page proves the chunk ended; a full
      // page with no count is ambiguous, and stopping there would present an
      // unknown number of missing rows as a complete answer.
      if (result.rows.length < BATCH_PROVIDER_PAGE_SIZE) break;
      throw siteError(
        DexScreenerSiteErrorCodes.BATCH_NO_RESULT_FRAME,
        `Chunk ${chunkIndex} page ${page} of the batch lookup returned a full page of ${result.rows.length} rows without the pairsCount total the channel normally reports, so whether more rows exist cannot be determined`,
        "The call failed rather than presenting a possibly short list as complete. Retry once, or split the request into lists of fewer than 500 identities."
      );
    }
  }

  if (pairsCount !== null && rows.length < pairsCount) {
    throw siteError(
      DexScreenerSiteErrorCodes.BATCH_NO_RESULT_FRAME,
      `Chunk ${chunkIndex} of the batch lookup (${identities.length} identities) collected ${rows.length} rows across ${page} provider pages while the channel reported a total of ${pairsCount}`,
      "The whole call failed rather than returning a short chunk, because a partial chunk is indistinguishable from a set of pairs the provider does not know. Retry once, or split the request into smaller lists."
    );
  }

  return {
    rows,
    report: {
      chunk: chunkIndex,
      identitiesSent: identities.length,
      rowsReturned: rows.length,
      framesReceived,
      attempts,
      pagesFetched: page,
      pairsCount,
    },
  };
}

interface PageOutcome {
  readonly rows: readonly unknown[];
  readonly pairsCount: number | null;
  readonly framesReceived: number;
  readonly attempts: number;
}

async function fetchOnePage(
  identities: readonly BatchIdentity[],
  query: BatchQuery,
  options: BatchOptions,
  chunkIndex: number,
  page: number
): Promise<PageOutcome> {
  const command = encodeDexScreenerCommand(
    "dex_screener.PairsSearchChannelCommand",
    {
      subscribe: {
        ids: identities.map((identity) => ({
          chainId: identity.chainId,
          id: identity.id,
        })),
        // Always sent: omitting it leaves the channel's hidden launchpad
        // exclusion in force and silently drops every bonding-curve pair.
        filters: batchSubscribeFilters(),
        rankBy: { key: query.rankKey, order: orderEnum(query.rankOrder) },
        timeframe: timeframeEnum(query.window),
        // 1-based. `page = 0` answers nothing at all, so the walk never sends it.
        page,
      },
    }
  );

  const seen: FrameCensus = { cases: [], byteSizes: [], undecodable: 0 };
  let framesReceived = 0;

  for (const [attemptIndex, binaryFrames] of [
    BATCH_FIRST_ATTEMPT_FRAMES,
    BATCH_RETRY_FRAMES,
  ].entries()) {
    throwIfAborted(options.signal);
    const frames = await options.transport.wsExchange(DEXSCREENER_BATCH_WS_URL, {
      send: [command],
      expect: {
        binaryFrames,
        maxTotalBytes: BATCH_MAX_TOTAL_BYTES,
      },
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    framesReceived += frames.length;

    for (const bytes of frames) {
      if (bytes.byteLength === 0) {
        // The transport contract already drops keepalives; a transport that
        // does not is still not allowed to make one look like an answer.
        seen.cases.push("keepalive");
        seen.byteSizes.push(0);
        continue;
      }
      const decoded = decodeFrame(bytes, seen);
      if (decoded === null) continue;
      const arm = asObject(decoded["pairs"]);
      if (arm === null) continue;
      const payloadRows = arm["pairs"];
      return {
        rows: Array.isArray(payloadRows) ? payloadRows : [],
        pairsCount: readCount(arm["pairsCount"]),
        framesReceived,
        attempts: attemptIndex + 1,
      };
    }
  }

  throw siteError(
    DexScreenerSiteErrorCodes.BATCH_NO_RESULT_FRAME,
    `Chunk ${chunkIndex} page ${page} of the batch lookup (${identities.length} identities) received ${framesReceived} binary frames across two attempts (asking for ${BATCH_FIRST_ATTEMPT_FRAMES} then ${BATCH_RETRY_FRAMES}) without a rows frame. Frame kinds in order: ${seen.cases.join(", ") || "none"}. Frame sizes in bytes: ${seen.byteSizes.join(", ") || "none"}. Frames that did not decode: ${seen.undecodable}`,
    "The whole call failed rather than returning the other chunks, because a missing chunk would look like a set of pairs the provider does not know. Retry once."
  );
}

/** `pairsCount` arrives as a number or, for large values, a decimal string. */
function readCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/* ------------------------------------------------------------------ */
/* Wire vocabulary                                                     */
/* ------------------------------------------------------------------ */

/**
 * Split the identity list into provider-sized chunks.
 *
 * Exported so the chunk arithmetic is testable without a socket: the property
 * that matters is that concatenating the chunks reproduces the input exactly,
 * in order, with nothing dropped or repeated.
 */
export function chunkIdentities(
  identities: readonly BatchIdentity[],
  size: number
): readonly (readonly BatchIdentity[])[] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a whole number of 1 or more, received ${String(size)}`);
  }
  const groups: BatchIdentity[][] = [];
  for (let index = 0; index < identities.length; index += size) {
    groups.push([...identities.slice(index, index + size)]);
  }
  return groups;
}

/** The provider's timeframe enum name for one window. */
function timeframeEnum(window: ScreenWindow): string {
  switch (window) {
    case "m5":
      return "TIMEFRAME_KEY_M5";
    case "h1":
      return "TIMEFRAME_KEY_H1";
    case "h6":
      return "TIMEFRAME_KEY_H6";
    case "h24":
      return "TIMEFRAME_KEY_H24";
  }
}

function orderEnum(order: "asc" | "desc"): string {
  return order === "asc" ? "RANK_BY_ORDER_ASC" : "RANK_BY_ORDER_DESC";
}

/* ------------------------------------------------------------------ */
/* Row reading                                                         */
/* ------------------------------------------------------------------ */

/** `chainId:pairAddress`, lowercased, or null when the row has no identity. */
export function rowKey(row: unknown): string | null {
  const source = asObject(row);
  if (source === null) return null;
  const chainId = readString(source["chainId"]);
  const pairAddress = readString(source["pairAddress"]);
  if (chainId === null || pairAddress === null) return null;
  return `${chainId.toLowerCase()}:${pairAddress.toLowerCase()}`;
}

/**
 * `chainId:baseTokenAddress`, lowercased, for reconciling token inputs.
 *
 * THIS IS WHY THE BASE SLOT ALONE IS ENOUGH: measured 6 of 6, a requested token
 * address comes back as the BASE token of its answering pair, never the quote.
 * If that ever stopped holding, every token input would reconcile as
 * `provider_omitted` while its row sat in the answer, so the invariant is
 * recorded here rather than left implicit in the matching.
 */
export function baseTokenKey(row: unknown): string | null {
  const source = asObject(row);
  if (source === null) return null;
  const chainId = readString(source["chainId"]);
  const baseToken = asObject(source["baseToken"]);
  const address = baseToken === null ? null : readString(baseToken["address"]);
  if (chainId === null || address === null) return null;
  return `${chainId.toLowerCase()}:${address.toLowerCase()}`;
}

interface FrameCensus {
  readonly cases: string[];
  readonly byteSizes: number[];
  undecodable: number;
}

type JsonObject = Record<string, unknown>;

function decodeFrame(bytes: Uint8Array, seen: FrameCensus): JsonObject | null {
  seen.byteSizes.push(bytes.byteLength);
  try {
    const json = decodeDexScreenerMessageToJson(
      "dex_screener.PairsSearchChannelMessage",
      bytes,
      { maxBytes: BATCH_MAX_TOTAL_BYTES }
    );
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

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw siteError(
    DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
    "The batch lookup was cancelled by the caller before the next chunk",
    "Chunks already fetched were discarded; issue a new request if the result is still wanted."
  );
}
