/**
 * The single-pair live channel, and the two optional side reads that hang off
 * it.
 *
 * `wss://io.dexscreener.com/dex/screener/v7/pair/{chainId}/{pairAddress}`
 *
 * The channel pushes a full snapshot of ONE pair, about 1 KB, and keeps
 * pushing while a client stays subscribed. A tool wants one snapshot, so it
 * takes the first frame whose oneof arm is `pair` and leaves.
 *
 * FRAME POSITION IS NOT A CONTRACT, exactly as on the screener channels: the
 * measured first binary frame is `latestBlock` in 72 of 74 sessions. Dispatch
 * is on the protobuf oneof, never on frame index. The captured fixture for
 * this module happens to open with the `pair` arm; the client is written so
 * that this is luck rather than something it depends on.
 *
 * AN EMPTY `pair` ARM IS THE PROVIDER'S "I DO NOT KNOW THIS POOL". Measured
 * 2026-08-25 on a well-formed but unindexed ethereum address and on an unknown
 * chain slug alike: a 2-byte frame decoding to `{"pair":{}}`, arriving on the
 * same 0.47 s tick as a real snapshot and re-sent forever. It is a decided
 * answer, so this module raises it as a typed unknown-pair failure on the
 * first attempt rather than retrying or timing out on it.
 *
 * DECLARED OMISSIONS ON THIS CHANNEL (rule: name every gap, do not leave it
 * silent). All three are read from the checked-in descriptor and were present
 * or absent as recorded:
 *
 *  - `isBoostable` (measured `true` on 4 of 4 live pairs): the provider's own
 *    "this token is ELIGIBLE to buy visibility" flag. It is a UI capability,
 *    not a market fact, and nothing in the surface routes on eligibility, so
 *    it is not projected.
 *  - `isDEXFeedStreamEnabled` (measured `false` on 4 of 4): the gate on the
 *    `SubscribeTransactions` live push this surface does not consume. Shipping
 *    a flag about a capability we deliberately do not use would invite the
 *    model to reason about it.
 *  - `baseToken.totalSupply` / `quoteToken.totalSupply`: in the descriptor,
 *    absent on every live pair captured. Not projected, and a supply figure
 *    that arrives on nothing cannot be relied on for any derivation; the
 *    safety and supply surface is `dexscreener__pair_details_get`.
 *
 * `liquidity.base` and `liquidity.quote` (the pool reserves, present on every
 * live row) ARE projected, by the shared screening projection in
 * `../screen-core/`, which owns every field of this row shape.
 *
 * THE PAIR ADDRESS IS LOWERCASED IN THE PATH. Measured: the channel is served
 * on the lowercase spelling, and the row it answers with carries the
 * provider's own mixed-case spelling. The client lowercases the path segment
 * and does NOT rewrite the row, so an EVM checksum address the agent passes in
 * is honoured and the address it gets back is the provider's.
 *
 * THE TWO SIDE READS ARE OPTIONAL AND FAIL SOFT, BY CONTRACT:
 *
 *  - `fetchPairReactions` is a 142-byte JSON counter set. It is crowd
 *    sentiment, not a metric, and a pair with no reactions is normal.
 *    ZEROS AND AN UNKNOWN PAIR ARE THE SAME ANSWER HERE, MEASURED: the endpoint
 *    replies with the full counter set at zero for a pair it has never seen,
 *    exactly as it does for a real pair nobody has reacted to. So a zeroed set
 *    is not evidence that the pair exists, and it is not evidence that it does
 *    not. Nothing downstream may read it as either; the pair snapshot beside it
 *    is what establishes that the pair is real.
 *  - `fetchTokenInsight` asks the feed socket for a provider-generated
 *    paragraph, as the unary envelope RPC
 *    `/dex_feed.PublicWSService/GetTokenInsight` (`../codec/feed-envelope.ts`;
 *    the `dex_feed.WSCommand.getTokenInsight` command it replaced was retired
 *    by the site in 2026-10 and goes unanswered). The measured answer for a
 *    token that has none is `STATUS_NOT_FOUND`, which is an ABSENT FIELD and
 *    never an error: an optional blurb that does not exist must not turn a
 *    working pair snapshot into a failed tool call. The site's own client
 *    reads that status the same way (its `getTokenInsight` catches NOT_FOUND
 *    and returns no insight).
 *
 * THE INSIGHT REQUEST HAS THREE MEASURED OUTCOMES, not two, and they are three
 * different facts (2026-10-07, fixtures `feed-envelope-insight-*`):
 * `STATUS_OK` carries a blurb; `STATUS_NOT_FOUND` is a real absence (the
 * provider has written nothing about this token); any other status is the
 * provider REFUSING or FAULTING (`STATUS_INVALID_ARGUMENT` measured on an empty
 * chainId plus tokenId, which the retired protocol answered with an INTERNAL
 * code) and says nothing about whether a blurb exists. This module reports the
 * status verbatim as `code` and states the distinction as `faulted`;
 * collapsing a fault into one "no blurb" reading is the caller's bug to avoid.
 *
 * COVERAGE, measured through the `SubscribeTokenInsights` stream: 98 of 98
 * insights on 2026-10-07 were `solana` (1,218 of 1,218 on 2026-08-25). No
 * other chain has any, and majors do not either. An insight request on a
 * non-Solana token is therefore hopeless before it is sent, which is a fact
 * the tool description owes the model. The pair row now says so itself:
 * `dex_screener_schema.Pair.Token.hasInsights` was added in the same deploy.
 *
 * TWO OPPOSITE CASE INVARIANTS, both measured, neither guessable:
 *
 *  - the reactions id is CASE-INSENSITIVE, so `fetchPairReactions` may and
 *    does lowercase it;
 *  - `GetTokenInsight.tokenId` is CASE-SENSITIVE: the lowercased spelling of a
 *    solana token that HAS an insight answers `STATUS_NOT_FOUND` (re-measured
 *    on the envelope protocol 2026-10-07). `fetchTokenInsight` passes the
 *    address verbatim and must keep doing so. A future "normalize addresses
 *    everywhere" edit would turn every Solana insight into a silent absence.
 *  - `GetTokenInsight.chainId` is case-sensitive TOO, and this is the trap of
 *    the pair: `Solana` for `solana` produces the SAME `STATUS_NOT_FOUND` that a
 *    token with no blurb produces (re-measured 2026-10-07), so a wrongly-cased
 *    chain slug is indistinguishable from a real absence in the answer. Both
 *    fields are passed through exactly as the caller's resolved subject spelled
 *    them.
 */

import {
  decodeDexScreenerMessageToJson,
  type DexScreenerMessageName,
} from "../codec/protobuf.js";
import {
  DEXSCREENER_FEED_WS_URL,
  encodeFeedRequest,
  nextFeedRequestId,
  readFeedResponse,
} from "../codec/feed-envelope.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";

/** The site host that serves the pair channel and the reactions endpoint. */
export const DEXSCREENER_SITE_WS_ORIGIN = "wss://io.dexscreener.com";
export const DEXSCREENER_SITE_HTTP_ORIGIN = "https://io.dexscreener.com";

/**
 * The feed socket the token-insight request is sent on. Owned by
 * `../codec/feed-envelope.ts`; re-exported because bars, trades and the board
 * services have always imported it from here.
 */
export { DEXSCREENER_FEED_WS_URL };

/**
 * Frames to collect while looking for the snapshot.
 *
 * TWO, and the number is a latency contract rather than a guess. Measured on
 * this channel (2026-08-25, and again in the S8 endpoint pass): the server
 * pushes the snapshot on connect and the SECOND copy lands in the same tick -
 * frames at 0.468 s and 0.468 s on a known-good solana pool, and two 2-byte
 * empty-arm frames at 0.470 s and 0.471 s on an unknown one. Every further
 * frame is a full re-send on a ~3.2 s tick.
 *
 * Asking for six therefore bought nothing and cost about 13 seconds of wall
 * clock for an answer already in hand at half a second, on `pair_get` AND on
 * every `resolvePairSubject` caller (candles, trades, top traders). Two frames
 * is one more than the answer needs, which keeps the dispatch honest: the
 * frame the caller wants is still found by its protobuf oneof arm and never by
 * its position.
 */
export const PAIR_FIRST_ATTEMPT_FRAMES = 2;
/**
 * Frames to collect on the single retry.
 *
 * FOUR, and it must stay under the caller's deadline to mean anything. At the
 * measured ~3.2 s re-send tick, frame 4 lands near 10 s, inside the 20 s
 * `pair_get` gives one attempt. The previous value of 10 put frame 10 at about
 * 26.2 s against that same 20 s budget, so the retry could not finish by
 * arithmetic and `PAIR_NO_SNAPSHOT_FRAME` was unreachable in production: an
 * unknown pool spent ~33 s and came back as a transport TIMEOUT.
 *
 * The retry exists only for the case where frames arrived and none of them was
 * a pair arm at all. An unknown pool no longer reaches it: the empty arm is a
 * decided answer on the first attempt.
 */
export const PAIR_RETRY_FRAMES = 4;

/** The unknown-pool outcome: an empty `pair` arm is the provider's answer. */
const PAIR_UNKNOWN_CODE = DexScreenerSiteErrorCodes.PAIR_UNKNOWN;

/**
 * Byte ceiling across the collected frames.
 *
 * One snapshot measured 960 bytes. One megabyte is three orders of magnitude
 * above that and still bounds a misbehaving channel. Over-cap is a typed
 * rejection naming the cap, never a partial frame.
 */
export const PAIR_MAX_TOTAL_BYTES = 1_000_000;

/** Byte ceiling for the reactions document. Measured at 142 bytes. */
export const REACTIONS_MAX_BYTES = 64_000;

/** Byte ceiling for one feed frame. The measured NOT_FOUND answer is 6 bytes. */
export const INSIGHT_MAX_TOTAL_BYTES = 256_000;

/**
 * Frames to collect on the feed socket while looking for the insight answer.
 *
 * ONE, because `GetTokenInsight` is a unary envelope RPC: one request frame,
 * one `ServerEnvelope.response` frame with the same id, and that frame IS the
 * answer. Measured live 2026-10-07: the first non-empty frame
 * was the response on every request (6 bytes for `STATUS_NOT_FOUND`, 1,189
 * bytes for `STATUS_OK`, at ~0.6 s), and an idle socket otherwise carries only
 * zero-length keepalives (one at 15.4 s), which do not count toward
 * `WsExpectation.binaryFrames`. Asking for more countable frames than the
 * socket will ever produce is a guaranteed `TRANSPORT_TIMEOUT` with the answer
 * already in hand.
 *
 * This module opens its OWN socket and sends its OWN single request, so it is
 * not multiplexed with anything; `readTokenInsightFrames` still dispatches by
 * envelope id, which costs nothing and keeps the reader correct if a caller
 * ever shares a socket with it.
 */
export const INSIGHT_FRAMES = 1;

/* ------------------------------------------------------------------ */
/* The pair snapshot                                                   */
/* ------------------------------------------------------------------ */

export interface PairSnapshotResult {
  /**
   * The raw `dex_screener_schema.Pair` row, in protobuf JSON, ready for
   * `projectPairRow`. Deliberately NOT reshaped here: the projection contract
   * (a missing input becomes null with its name recorded) has one owner and
   * this module is not it.
   */
  readonly row: unknown;
  /** The URL the exchange actually opened. */
  readonly url: string;
  /** Binary frames that arrived before the snapshot, across all attempts. */
  readonly framesReceived: number;
  /** 1 when the first attempt succeeded, 2 when the retry was needed. */
  readonly attempts: number;
  readonly fetchedAtMs: number;
}

export interface PairSnapshotOptions {
  readonly chainId: string;
  /** The pair address as the caller wrote it. Lowercased for the path only. */
  readonly pairAddress: string;
  readonly transport: DexScreenerTransport;
  /** Hard deadline for ONE attempt, in milliseconds. The retry gets its own. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch one live snapshot of one pair.
 *
 * THREE OUTCOMES, AND THEY ARE THREE DIFFERENT FACTS.
 *
 *  1. A frame whose `pair` arm carries a row: the snapshot, returned.
 *  2. Frames whose `pair` arm is EMPTY (the 2-byte `{"pair":{}}` frame): the
 *     provider's own answer that it knows no such pool on that chain. It is
 *     returned as the unknown-pair failure IMMEDIATELY, on the first attempt,
 *     because it is a decided answer and not a slow one. Measured on
 *     2026-08-25: the empty arm lands at 0.47 s, exactly as fast as a real
 *     snapshot, on both an unknown EVM pool and an unknown chain slug. It is
 *     neither retried nor waited out; doing either turned a half-second "no
 *     such pool" into a ~33 s `TRANSPORT_TIMEOUT` that read as an outage.
 *  3. Frames that arrived but none of which was a `pair` arm at all (a block
 *     burst): ONE retry asking `PAIR_RETRY_FRAMES`, then a typed failure that
 *     names what DID arrive, so "the channel only sent block updates" can
 *     never be reported as "this pair does not exist".
 */
export async function fetchPairSnapshot(
  options: PairSnapshotOptions
): Promise<PairSnapshotResult> {
  const url =
    `${DEXSCREENER_SITE_WS_ORIGIN}/dex/screener/v7/pair/`
    + `${encodeURIComponent(options.chainId)}/`
    + `${encodeURIComponent(options.pairAddress.toLowerCase())}`;

  const seen: FrameCensus = { cases: [], byteSizes: [], undecodable: 0 };
  let framesReceived = 0;
  let emptyArmFrames = 0;

  for (const [attemptIndex, binaryFrames] of [
    PAIR_FIRST_ATTEMPT_FRAMES,
    PAIR_RETRY_FRAMES,
  ].entries()) {
    throwIfAborted(options.signal, url);
    const frames = await options.transport.wsExchange(url, {
      expect: { binaryFrames, maxTotalBytes: PAIR_MAX_TOTAL_BYTES },
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    framesReceived += frames.length;

    for (const bytes of frames) {
      if (bytes.byteLength === 0) {
        seen.cases.push("keepalive");
        seen.byteSizes.push(0);
        continue;
      }
      const decoded = decodeFrame(
        "dex_screener.PairChannelMessage",
        bytes,
        PAIR_MAX_TOTAL_BYTES,
        seen
      );
      if (decoded === null) continue;
      // `pair` is the oneof arm; the arm's own payload wraps the row in a
      // second `pair` key, which is the provider's spelling and not a typo.
      const arm = asObject(decoded["pair"]);
      if (arm === null) continue;
      const row = arm["pair"];
      if (row === undefined || row === null) {
        // THE EMPTY ARM IS THE ANSWER. A 2-byte frame decoding to
        // `{"pair":{}}` is the provider saying it has no such pool, and the
        // census renders it as another `pair` frame, so it must be counted
        // apart or the failure text claims a pair frame arrived and was not a
        // pair.
        emptyArmFrames += 1;
        seen.cases[seen.cases.length - 1] = "empty_pair_arm";
        continue;
      }
      return {
        row,
        url,
        framesReceived,
        attempts: attemptIndex + 1,
        fetchedAtMs: Date.now(),
      };
    }

    // Decided on the FIRST attempt, before the retry, because waiting changes
    // nothing: the provider re-sends this same empty arm every tick forever.
    if (emptyArmFrames > 0) {
      throw siteError(
        PAIR_UNKNOWN_CODE,
        `The DexScreener pair channel answered for ${options.chainId}:${options.pairAddress} with ${emptyArmFrames} empty pair ${emptyArmFrames === 1 ? "frame" : "frames"} and no pool, which is how this channel says it indexes no such pool on that chain`,
        "This is the provider's answer, not an outage and not a timeout: it will answer the same way on every retry, so do not repeat the call unchanged. Check the pair address and the chain slug (an address from another chain is the usual cause), or find the pool with dexscreener__pairs_search or dexscreener__token_pairs_list and call again with what those return."
      );
    }
  }

  throw siteError(
    DexScreenerSiteErrorCodes.PAIR_NO_SNAPSHOT_FRAME,
    `The DexScreener pair channel for ${options.chainId}:${options.pairAddress} sent ${framesReceived} binary frames across two attempts (asking for ${PAIR_FIRST_ATTEMPT_FRAMES} then ${PAIR_RETRY_FRAMES}) without a pair snapshot. Frame kinds in order: ${seen.cases.join(", ") || "none"}. Frame sizes in bytes: ${seen.byteSizes.join(", ") || "none"}. Frames that did not decode: ${seen.undecodable}`,
    "The channel answered with frames of other kinds and never an empty pair arm, so this is neither an outage nor the provider saying the pool is unknown: an unknown pool is reported separately and by name. Retry once; if it repeats, check the chain and pair address against dexscreener__chains_list and a search result."
  );
}

/* ------------------------------------------------------------------ */
/* Reactions                                                           */
/* ------------------------------------------------------------------ */

/** One reaction counter, as the provider names it. */
export interface PairReactions {
  /** Emoji key to total, exactly as the provider sent it. */
  readonly totals: Readonly<Record<string, number>>;
  readonly fetchedAtMs: number;
}

export interface PairReactionsOptions {
  readonly chainId: string;
  readonly pairAddress: string;
  readonly transport: DexScreenerTransport;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch the crowd reaction counters for one pair.
 *
 * Returns null when the endpoint answers anything other than a well-formed 200,
 * because this is decoration on a snapshot the caller already has: a missing
 * counter set must degrade the optional field, never the whole call. The caller
 * reports the absence; it is not invented as zeroes.
 */
export async function fetchPairReactions(
  options: PairReactionsOptions
): Promise<PairReactions | null> {
  const url =
    `${DEXSCREENER_SITE_HTTP_ORIGIN}/hype/reactions/dexPair/`
    + `${encodeURIComponent(options.chainId)}:${encodeURIComponent(options.pairAddress.toLowerCase())}`;
  let body: Uint8Array;
  try {
    const response = await options.transport.httpGet(url, {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      accept: "application/json",
      maxBytes: REACTIONS_MAX_BYTES,
    });
    if (response.status !== 200) return null;
    body = response.body;
  } catch (error) {
    // A cancelled call is the caller's own decision and must surface; a
    // reactions endpoint that is simply unreachable is a missing optional.
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED
    ) {
      throw error;
    }
    return null;
  }
  return parsePairReactions(body);
}

/**
 * Parse the reactions document.
 *
 * Exported so the shape has a testable owner. Anything that is not the
 * measured `{reactions: {<key>: {total: number}}}` shape returns null rather
 * than a partial set, because a half-read counter set reads as a real ratio.
 */
export function parsePairReactions(body: Uint8Array): PairReactions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
  const root = asObject(parsed);
  if (root === null) return null;
  const reactions = asObject(root["reactions"]);
  if (reactions === null) return null;
  const totals: Record<string, number> = {};
  for (const [key, value] of Object.entries(reactions)) {
    const entry = asObject(value);
    if (entry === null) continue;
    const total = entry["total"];
    if (typeof total === "number" && Number.isFinite(total)) totals[key] = total;
  }
  return { totals, fetchedAtMs: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Token insight                                                       */
/* ------------------------------------------------------------------ */

/**
 * The provider-generated blurb, or the measured reason there is none.
 *
 * Both text fields null with `code` set is the NORMAL outcome for a token the
 * provider has written nothing about (measured: `STATUS_NOT_FOUND` in a 6-byte
 * frame). It is reported, never converted into an error and never replaced
 * with prose of our own.
 */
export interface TokenInsight {
  /** `dex_feed.TokenInsight.title`, issuer-independent but model-generated. */
  readonly title: string | null;
  /** `dex_feed.TokenInsight.content`, the paragraph itself. */
  readonly content: string | null;
  /** When the provider says it wrote the blurb. */
  readonly createdAtMs: number | null;
  /**
   * The provider's own status for the request, verbatim: a
   * `util_envelope.Status` name (`STATUS_OK`, `STATUS_NOT_FOUND`,
   * `STATUS_INVALID_ARGUMENT`, ...). The retired protocol spelled these
   * `WS_COMMAND_CODE_*`; that vocabulary no longer arrives. Typed as a plain
   * string because it is the provider's spelling, not ours.
   */
  readonly code: string | null;
  /**
   * True when the provider answered with neither a blurb nor a real absence:
   * any status other than `STATUS_OK` and `STATUS_NOT_FOUND` (an invalid
   * argument, a timeout, an internal fault, an authorization refusal). Such an
   * answer says NOTHING about whether a blurb exists, and must not be read as
   * "none written".
   */
  readonly faulted: boolean;
  readonly fetchedAtMs: number;
}

export interface TokenInsightOptions {
  readonly chainId: string;
  readonly tokenAddress: string;
  readonly transport: DexScreenerTransport;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * The envelope id for the request. Defaults to a fresh process-wide id per
   * call; settable so a test can replay a capture under the id it was taken
   * with.
   */
  readonly correlationId?: number;
}

/**
 * Ask the feed socket for one token's insight paragraph.
 *
 * Returns null only when the exchange itself could not be made (transport
 * down, no answer for this request, an OK answer whose payload does not
 * decode). A provider answer of "I have none" comes back as a `TokenInsight`
 * with null text and the code, which is a different fact and is reported as
 * one.
 */
export async function fetchTokenInsight(
  options: TokenInsightOptions
): Promise<TokenInsight | null> {
  const id = options.correlationId ?? nextFeedRequestId();
  const request = encodeFeedRequest(
    "GetTokenInsight",
    { chainId: options.chainId, tokenId: options.tokenAddress },
    id
  );

  let frames: Uint8Array[];
  try {
    frames = await options.transport.wsExchange(DEXSCREENER_FEED_WS_URL, {
      send: [request],
      expect: {
        binaryFrames: INSIGHT_FRAMES,
        maxTotalBytes: INSIGHT_MAX_TOTAL_BYTES,
      },
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED
    ) {
      throw error;
    }
    return null;
  }

  try {
    return readTokenInsightFrames(frames, id);
  } catch (error) {
    // The answer arrived and could not be read (over the cap, or an OK payload
    // that is not a `GetTokenInsightResponse`). The blurb is optional, so this
    // degrades to "no answer" rather than failing the pair snapshot it rides on.
    if (isDexScreenerSiteError(error)) return null;
    throw error;
  }
}

/**
 * Find this call's answer among the frames the feed socket sent.
 *
 * Exported because it, not the socket, is where the two contracts that matter
 * live, and both are provable from captured bytes alone:
 *
 *  - ENVELOPE ID, NOT FRAME POSITION. An answer carrying somebody else's id is
 *    not this call's answer and is skipped rather than returned.
 *  - NOT_FOUND IS AN ABSENT FIELD. A response whose status is
 *    `STATUS_NOT_FOUND` carries no payload and means "the provider has written
 *    nothing about this token". It comes back as a `TokenInsight` with null
 *    text and the status, never as an error and never as invented prose.
 *
 * Returns null when no frame answers this id at all.
 */
export function readTokenInsightFrames(
  frames: readonly Uint8Array[],
  id: number
): TokenInsight | null {
  const answer = readFeedResponse(
    frames,
    id,
    "GetTokenInsight",
    INSIGHT_MAX_TOTAL_BYTES
  );
  if (answer === null) return null;
  const payload =
    answer.payload === null ? null : asObject(asObject(answer.payload)?.["tokenInsight"]);
  const createdAt = payload === null ? null : payload["createdAt"];
  const parsedCreatedAt =
    typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  return {
    title: payload === null ? null : readString(payload["title"]),
    content: payload === null ? null : readString(payload["content"]),
    createdAtMs: Number.isNaN(parsedCreatedAt) ? null : parsedCreatedAt,
    code: answer.status,
    faulted:
      answer.status !== "STATUS_OK" && answer.status !== "STATUS_NOT_FOUND",
    fetchedAtMs: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Shared frame reading                                                */
/* ------------------------------------------------------------------ */

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
 * answer frame, and every failure is counted and named in the typed error if
 * the answer never comes. A cap rejection is different and is rethrown: that
 * is the caller's own bound being hit, not provider noise.
 */
function decodeFrame(
  message: DexScreenerMessageName,
  bytes: Uint8Array,
  maxBytes: number,
  seen: FrameCensus
): JsonObject | null {
  seen.byteSizes.push(bytes.byteLength);
  try {
    const json = decodeDexScreenerMessageToJson(message, bytes, { maxBytes });
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

function throwIfAborted(signal: AbortSignal | undefined, url: string): void {
  if (signal?.aborted !== true) return;
  throw siteError(
    DexScreenerSiteErrorCodes.TRANSPORT_CANCELLED,
    `The pair request to ${new URL(url).host} was cancelled by the caller before the next attempt`,
    "Nothing was read; issue a new request if the result is still wanted."
  );
}
