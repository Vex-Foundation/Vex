/**
 * Test-only builders for `feed/ws` SERVER frames (`util_envelope.ServerEnvelope`).
 *
 * Production never writes a server frame, so these live beside the tests rather
 * than in the codec. Every frame they build goes through the checked-in
 * descriptors, so a builder cannot produce a shape the provider's schema does
 * not declare; the captured `feed-envelope-*` fixtures remain the proof of what
 * the provider actually sends.
 */

import { fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import {
  FEED_WS_METHODS,
  type FeedStatus,
  type FeedWsMethod,
} from "@tools/dexscreener/codec/feed-envelope.js";
import {
  getDexScreenerMessageDescriptor,
  getDexScreenerProtoRegistry,
} from "@tools/dexscreener/codec/protobuf.js";

function encode(name: Parameters<typeof getDexScreenerMessageDescriptor>[0], value: JsonValue): Uint8Array {
  const descriptor = getDexScreenerMessageDescriptor(name);
  return toBinary(
    descriptor,
    fromJson(descriptor, value, { registry: getDexScreenerProtoRegistry() })
  );
}

/**
 * A `ServerEnvelope{id, response{status, payload}}` frame. `payload` is the
 * method's response message in protobuf JSON, or raw bytes to model a payload
 * that is NOT that message.
 */
export function feedResponseFrame(
  id: number,
  method: FeedWsMethod,
  payload: JsonValue | Uint8Array | null,
  status: FeedStatus = "STATUS_OK"
): Uint8Array {
  const payloadBytes =
    payload === null
      ? null
      : payload instanceof Uint8Array
        ? payload
        : encode(FEED_WS_METHODS[method].response, payload);
  return encode("util_envelope.ServerEnvelope", {
    id,
    response: {
      status,
      ...(payloadBytes === null
        ? {}
        : { payload: Buffer.from(payloadBytes).toString("base64") }),
    },
  });
}

/** A `ServerEnvelope{id, stream_message{payload}}` frame: a subscription's, never a request's answer. */
export function feedStreamFrame(id: number, payload: Uint8Array): Uint8Array {
  return encode("util_envelope.ServerEnvelope", {
    id,
    streamMessage: { payload: Buffer.from(payload).toString("base64") },
  });
}
