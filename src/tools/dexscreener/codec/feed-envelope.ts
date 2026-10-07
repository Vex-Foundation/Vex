/**
 * The `feed/ws` ENVELOPE protocol (`util_envelope`), the site's replacement for
 * the retired `dex_feed.WSCommand` / `dex_feed.WSMessage` pair.
 *
 * REVERSED FROM THE SITE BUNDLE captured 2026-10-07
 * (`assets/entries/pages_catch-all.DvxFsOuQ.js`, the `Oht` envelope client and
 * the `spt` dex-feed client that drives it) and measured live the same day.
 * What the site does, and therefore what this module does:
 *
 *  - SOCKET. `new WebSocket(new URL(`${DS_DEX_FEED_PUBLIC_URL}/feed/ws`))` with
 *    `DS_DEX_FEED_PUBLIC_URL = https://io.dexscreener.com`, i.e.
 *    `wss://io.dexscreener.com/feed/ws`, `binaryType = "arraybuffer"`. The
 *    `?encoding=json` variant exists behind `DS_DEX_FEED_WS_ENCODE_JSON`, which
 *    the served config sets to `false`, so frames are binary protobuf.
 *  - REQUEST. One BINARY frame: `util_envelope.ClientEnvelope{ id, request: {
 *    method, payload, trace } }`. `method` is the RPC path
 *    `/${service.typeName}/${method.name}`, e.g.
 *    `/dex_feed.PublicWSService/GetHistoricalBars`; `payload` is the
 *    request message (`dex_feed.GetHistoricalBarsRequest` ...) serialized to
 *    protobuf bytes; `trace` is OpenTelemetry propagation and is optional (this
 *    module sends none). `id` is a per-socket counter starting at 1.
 *  - ANSWER. One BINARY frame: `util_envelope.ServerEnvelope{ id, response: {
 *    status, payload } }` carrying the SAME `id`. `status` is
 *    `util_envelope.Status`; only `STATUS_OK` carries a payload, which is the
 *    response message (`dex_feed.GetHistoricalBarsResponse` ...) as bytes.
 *    Every other status is the site client's own rejection
 *    (`tC(status)`), and `GetTokenInsight` alone turns `STATUS_NOT_FOUND` into
 *    "no insight" rather than an error.
 *  - STREAMS. `subscribe{method,payload}` opens a server stream answered by
 *    `stream_message` (a full payload), `stream_delta` (a fossil-delta patch
 *    against the previous payload, with a checksum) and `stream_end{status}`;
 *    `unsubscribe{}` and `cancel{}` close one by `id`. No tool here subscribes,
 *    so none of the stream arms is decoded beyond being recognised and skipped.
 *  - KEEPALIVE. The client sends NOTHING to keep the socket up (no ping on this
 *    socket; the `"ping"`/`"pong"` text pair belongs to the screener channels).
 *    It watches inactivity instead: a 5 s timer reconnects when no frame has
 *    arrived for 60 s. The server's zero-length binary frames are what keep a
 *    quiet socket inside that window; the transport contract already drops
 *    them (`WsExpectation.binaryFrames`).
 *
 * The method names are not typed by hand: `feedMethodPath` reads them out of
 * the checked-in `dex_feed.PublicWSService` descriptor and checks that the
 * method's input and output types are the ones this module encodes and decodes,
 * so a renamed or retyped RPC fails here by name instead of on the wire.
 */

import type { DescService, JsonValue } from "@bufbuild/protobuf";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import { encodeDexScreenerCommand } from "./encode.js";
import {
  decodeDexScreenerMessageToJson,
  getDexScreenerProtoRegistry,
  type DexScreenerMessageName,
} from "./protobuf.js";

/** The feed socket every envelope request is sent on. */
export const DEXSCREENER_FEED_WS_URL = "wss://io.dexscreener.com/feed/ws";

/** The service the feed socket's RPC paths name. */
export const FEED_WS_SERVICE = "dex_feed.PublicWSService";

/**
 * The unary feed RPCs this build calls, with the messages each one carries.
 *
 * A NAMED SUBSET of the service. The streaming methods (`SubscribeTransactions`,
 * `SubscribeTokenInsights`, `SubscribeTokenInsightsByToken`,
 * `SubscribeLatestBlock`, `SubscribePairs`, `SubscribeAggregatedPairs`) are
 * declared omissions in `DexScreener.md`: a tool answers one question and
 * leaves, and every one of those questions has a request-response channel.
 */
export const FEED_WS_METHODS = {
  GetHistoricalBars: {
    request: "dex_feed.GetHistoricalBarsRequest",
    response: "dex_feed.GetHistoricalBarsResponse",
  },
  GetHistoricalTransactions: {
    request: "dex_feed.GetHistoricalTransactionsRequest",
    response: "dex_feed.GetHistoricalTransactionsResponse",
  },
  GetTokenInsight: {
    request: "dex_feed.GetTokenInsightRequest",
    response: "dex_feed.GetTokenInsightResponse",
  },
} as const satisfies Record<
  string,
  { readonly request: DexScreenerMessageName; readonly response: DexScreenerMessageName }
>;

export type FeedWsMethod = keyof typeof FEED_WS_METHODS;

/**
 * `util_envelope.Status`, by name, as protobuf JSON renders it.
 *
 * Only `STATUS_OK` carries a payload. The others are the provider's verdict on
 * the request and are handed to the caller verbatim.
 */
export type FeedStatus =
  | "STATUS_UNSPECIFIED"
  | "STATUS_OK"
  | "STATUS_NOT_FOUND"
  | "STATUS_UNAUTHORIZED"
  | "STATUS_TIMEOUT"
  | "STATUS_INTERNAL"
  | "STATUS_INVALID_ARGUMENT";

const FEED_STATUSES: ReadonlySet<string> = new Set<FeedStatus>([
  "STATUS_UNSPECIFIED",
  "STATUS_OK",
  "STATUS_NOT_FOUND",
  "STATUS_UNAUTHORIZED",
  "STATUS_TIMEOUT",
  "STATUS_INTERNAL",
  "STATUS_INVALID_ARGUMENT",
]);

/**
 * The provider-side statuses a later identical request may not repeat.
 *
 * `STATUS_TIMEOUT` and `STATUS_INTERNAL` are the provider failing on a request
 * it accepted; the site's own client records exactly these two as span errors
 * and treats the rest as answers. Everything else is deterministic for the
 * same bytes.
 */
export function isTransientFeedStatus(status: FeedStatus): boolean {
  return status === "STATUS_TIMEOUT" || status === "STATUS_INTERNAL";
}

let pathMemo: Map<FeedWsMethod, string> | null = null;

/**
 * The RPC path the envelope's `method` carries, read from the descriptor.
 *
 * Throws a typed decode failure when the checked-in descriptor set no longer
 * declares the method with the request and response this module uses: that is
 * a schema drift and must stop the call before anything is sent.
 */
export function feedMethodPath(method: FeedWsMethod): string {
  if (pathMemo === null) pathMemo = buildPaths();
  const path = pathMemo.get(method);
  if (path === undefined) {
    throw siteError(
      DexScreenerSiteErrorCodes.DECODE_FAILED,
      `${FEED_WS_SERVICE}/${method} is not declared in the checked-in descriptor set`,
      "Regenerate the descriptors from the current site bundle and re-run the drift test."
    );
  }
  return path;
}

function buildPaths(): Map<FeedWsMethod, string> {
  const out = new Map<FeedWsMethod, string>();
  const service: DescService | undefined =
    getDexScreenerProtoRegistry().getService(FEED_WS_SERVICE);
  if (service === undefined) return out;
  for (const [name, spec] of Object.entries(FEED_WS_METHODS) as [
    FeedWsMethod,
    (typeof FEED_WS_METHODS)[FeedWsMethod],
  ][]) {
    const declared = service.methods.find((method) => method.name === name);
    if (declared === undefined) continue;
    if (declared.methodKind !== "unary") continue;
    if (declared.input.typeName !== spec.request) continue;
    if (declared.output.typeName !== spec.response) continue;
    out.set(name, `/${service.typeName}/${declared.name}`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Request ids                                                         */
/* ------------------------------------------------------------------ */

/** uint32 ceiling of `ClientEnvelope.id`, kept inside the safe positive int32 range. */
const FEED_ID_MAX = 2_147_483_647;

let feedIdCounter = 0;

/**
 * A fresh envelope id, in 1..2^31-1, shared by every feed caller in the process.
 *
 * ONE counter for bars, trades and insight, on purpose: an answer belongs to a
 * request only by `id`, so two modules each counting from 1 could read each
 * other's answer if a transport ever shared one socket. Zero is never issued
 * because it is what an OMITTED id decodes to, which would make "this call's
 * answer" and "an answer to nobody" the same match.
 */
export function nextFeedRequestId(): number {
  feedIdCounter = (feedIdCounter % FEED_ID_MAX) + 1;
  return feedIdCounter;
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

/**
 * The bytes of one `ClientEnvelope{id, request{method, payload}}` frame.
 *
 * The inner request goes through the same allowlisted, schema-checked encoder
 * as every other command, so a misspelled filter is refused before it is
 * wrapped, never silently dropped.
 */
export function encodeFeedRequest(
  method: FeedWsMethod,
  request: JsonValue,
  id: number
): Uint8Array {
  if (!Number.isInteger(id) || id < 1 || id > FEED_ID_MAX) {
    throw siteError(
      DexScreenerSiteErrorCodes.ENCODE_FAILED,
      `A feed envelope id must be an integer in 1..${FEED_ID_MAX}, got ${String(id)}`,
      "This is a defect in how the request was assembled, not a provider failure. Nothing was sent."
    );
  }
  const payload = encodeDexScreenerCommand(FEED_WS_METHODS[method].request, request);
  return encodeDexScreenerCommand("util_envelope.ClientEnvelope", {
    id,
    request: {
      method: feedMethodPath(method),
      payload: Buffer.from(payload).toString("base64"),
    },
  });
}

/** A request frame read back into its parts. */
export interface FeedRequestFrame {
  readonly id: number;
  /** The RPC path exactly as the frame carries it. */
  readonly method: string;
  /** The unary method this build knows the path as, or null for any other path. */
  readonly knownMethod: FeedWsMethod | null;
  /** The decoded request message for a known method, in protobuf JSON. */
  readonly request: JsonValue | null;
}

/**
 * Read a `ClientEnvelope{request}` frame back into its parts.
 *
 * The inverse of `encodeFeedRequest`, for frames this build wrote or captured:
 * tests use it to assert what actually went on the wire, and diagnostics use it
 * to label a captured request. Returns null for a frame that is not a request
 * envelope (a subscribe, a cancel, or bytes that do not decode).
 */
export function readFeedRequest(
  frame: Uint8Array,
  maxBytes: number
): FeedRequestFrame | null {
  let envelope: Record<string, unknown> | null;
  try {
    envelope = asObject(
      decodeDexScreenerMessageToJson("util_envelope.ClientEnvelope", frame, {
        maxBytes,
      })
    );
  } catch {
    return null;
  }
  const request = asObject(envelope?.["request"]);
  if (request === null) return null;
  const method = typeof request["method"] === "string" ? request["method"] : "";
  const knownMethod =
    (Object.keys(FEED_WS_METHODS) as FeedWsMethod[]).find(
      (name) => feedMethodPath(name) === method
    ) ?? null;
  const rawPayload = request["payload"];
  const payloadBytes = new Uint8Array(
    Buffer.from(typeof rawPayload === "string" ? rawPayload : "", "base64")
  );
  return {
    id: readUint(envelope?.["id"]) ?? 0,
    method,
    knownMethod,
    request:
      knownMethod === null
        ? null
        : decodeDexScreenerMessageToJson(
            FEED_WS_METHODS[knownMethod].request,
            payloadBytes,
            { maxBytes }
          ),
  };
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

/** One envelope response, matched to its request by id. */
export interface FeedResponse {
  readonly status: FeedStatus;
  /**
   * The decoded response message in protobuf JSON when `status` is
   * `STATUS_OK`, and null otherwise. An OK answer with no payload bytes decodes
   * to the empty message (`{}`), which is a real, empty answer.
   */
  readonly payload: JsonValue | null;
}

/** What arrived on the socket, for a failure message when no answer matched. */
export interface FeedFrameCensus {
  /** Server envelope arms in arrival order (`response#7`, `streamMessage#3`, `undecodable`). */
  readonly arms: string[];
  readonly byteSizes: number[];
}

/**
 * Find the response to request `id` among the frames the socket sent.
 *
 * Dispatch is on the envelope ID and the `response` ARM, never on frame
 * position. A frame that does not decode as `util_envelope.ServerEnvelope` is
 * recorded in `census` and skipped, because the goal is the answer frame; a cap
 * rejection is rethrown, because that is the caller's own bound. An OK payload
 * that does not decode as the method's response message throws a typed
 * `DECODE_FAILED`: that frame IS the answer and it is not the shape the
 * descriptor promises.
 *
 * Returns null when no frame answers `id`.
 */
export function readFeedResponse(
  frames: readonly Uint8Array[],
  id: number,
  method: FeedWsMethod,
  maxBytes: number,
  census: FeedFrameCensus = { arms: [], byteSizes: [] }
): FeedResponse | null {
  for (const bytes of frames) {
    if (bytes.byteLength === 0) continue;
    census.byteSizes.push(bytes.byteLength);
    let envelope: Record<string, unknown> | null;
    try {
      envelope = asObject(
        decodeDexScreenerMessageToJson("util_envelope.ServerEnvelope", bytes, {
          maxBytes,
        })
      );
    } catch (error) {
      if (
        isDexScreenerSiteError(error) &&
        error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
      ) {
        throw error;
      }
      census.arms.push("undecodable");
      continue;
    }
    const envelopeId = readUint(envelope?.["id"]) ?? 0;
    const arm = ENVELOPE_ARMS.find((name) => envelope?.[name] !== undefined);
    census.arms.push(`${arm ?? "empty"}#${envelopeId}`);
    if (arm !== "response" || envelopeId !== id) continue;

    const response = asObject(envelope?.["response"]) ?? {};
    const rawStatus = response["status"];
    const status: FeedStatus =
      typeof rawStatus === "string" && FEED_STATUSES.has(rawStatus)
        ? (rawStatus as FeedStatus)
        : "STATUS_UNSPECIFIED";
    if (status !== "STATUS_OK") return { status, payload: null };

    const rawPayload = response["payload"];
    const payloadBytes = new Uint8Array(
      Buffer.from(typeof rawPayload === "string" ? rawPayload : "", "base64")
    );
    return {
      status,
      payload: decodeDexScreenerMessageToJson(
        FEED_WS_METHODS[method].response,
        payloadBytes,
        { maxBytes }
      ),
    };
  }
  return null;
}

/** `ServerEnvelope.payload` arms, by their protobuf JSON names. */
const ENVELOPE_ARMS = [
  "response",
  "streamMessage",
  "streamDelta",
  "streamEnd",
] as const;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** uint32 renders as a JSON number; a string form is parsed exactly. */
function readUint(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
