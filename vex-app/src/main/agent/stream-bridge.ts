/**
 * Engine -> renderer stream-delta bridge (Stage 9-2).
 *
 * Subscribes to the in-process `streamDeltaBus` (canonical engine spine in
 * `src/vex-agent/engine/events/stream-bus.ts`, added in 9-1) and broadcasts an
 * EPHEMERAL, SANITIZED preview to every BrowserWindow on
 * `EV.engine.streamDelta`.
 *
 * Unlike `transcript-bridge` (a pass-through validate), this bridge MAPS the
 * engine event into the renderer-facing shape BEFORE validating, because the
 * boundary must sanitize:
 *  - `tool_call` deltas: the raw incremental-args fragment (`argsDelta`) is
 *    DROPPED. Mid-stream JSON fragments cannot be safely redacted; the
 *    canonical redacted args arrive later via the persisted `tool_call` DTO.
 *    The `toolCallName` is normalized from the injected wire name to its dotted
 *    `toolId` (`tool-name-canonical.ts`), the same form the persisted DTO and
 *    the Markdown export carry.
 *  - `error` deltas: the raw provider message is replaced with a safe generic
 *    (`"Stream error"`); the numeric `code` and the bounded `errorType` enum
 *    label are preserved. The label is an enum member from the provider's own
 *    taxonomy — bounded upstream, re-validated by the strict schema below —
 *    and carrying it is what turns an opaque preview failure into "the
 *    provider rate-limited us".
 *
 * The mapper is fail-closed + non-throwing: malformed engine input maps to
 * `null` (or, if it throws, is caught) and is dropped + logged — it never
 * reaches preload. After mapping, the strict shared schema re-validates
 * (defense-in-depth; the preload subscriber re-validates again as a third
 * layer). The DB transcript stays the source of truth; deltas are preview only.
 *
 * Import discipline: the bus + engine type are imported DIRECTLY from
 * `stream-bus.js`, NOT the `engine/events/index.js` barrel (which would pull
 * the DB client into the main-process graph at bridge-setup time).
 */

import { EV } from "@shared/ipc/channels.js";
import {
  STREAM_DELTA_EVENT_TYPE,
  streamDeltaEventSchema,
  type StreamDeltaEvent as RendererStreamDeltaEvent,
} from "@shared/schemas/stream.js";
import {
  streamDeltaBus,
  type StreamDeltaEvent as EngineStreamDeltaEvent,
} from "@vex-agent/engine/events/stream-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";
import { canonicalToolName } from "./tool-name-canonical.js";

/** Renderer-facing replacement for any provider-supplied error text. */
const SAFE_STREAM_ERROR_MESSAGE = "Stream error";

/**
 * Map a raw engine stream delta to the sanitized renderer shape. Returns
 * `null` for anything it cannot safely map (null/missing/unknown delta) so the
 * caller drops it. Pure + defensive — treats the input as untrusted, never
 * forwards `argsDelta`, and never forwards raw provider error text.
 */
export function toRendererStreamDelta(
  event: EngineStreamDeltaEvent,
): RendererStreamDeltaEvent | null {
  // Defensive: the bus is typed, but this bridge is the trust boundary.
  // A missing/null delta maps to null (dropped); a null `event` throws on
  // this read and is caught by the caller's try/catch.
  const delta = event.delta as EngineStreamDeltaEvent["delta"] | null | undefined;
  if (delta == null) {
    return null;
  }

  let payload: RendererStreamDeltaEvent["delta"];
  switch (delta.kind) {
    case "text":
      payload = { kind: "text", text: delta.text };
      break;
    case "reasoning":
      payload = { kind: "reasoning", text: delta.text };
      break;
    case "tool_call":
      // argsDelta intentionally dropped (sanitization-by-omission).
      //
      // The NAME is canonicalized: the model calls a discovered protocol
      // manifest under its OpenAI-legal wire name (`kyberswap__swap__quote`),
      // and the live island is one of the three surfaces a human reads it on.
      // An unresolvable name stays verbatim (`tool-name-canonical.ts`).
      payload = {
        kind: "tool_call",
        toolCallIndex: delta.toolCallIndex,
        toolCallId: delta.toolCallId,
        toolCallName:
          delta.toolCallName === null ? null : canonicalToolName(delta.toolCallName),
      };
      break;
    case "usage":
      // Explicitly pick the renderer-known token fields. Engine `usage` is the
      // full `InferenceUsage`, which now also carries the authoritative
      // `usage.cost`; the renderer stream schema is `.strict()` and the preview
      // never needs cost, so it is dropped by construction here (along with any
      // future provider-only field). Cost still reaches the persisted usage row.
      payload = {
        kind: "usage",
        usage: {
          promptTokens: delta.usage.promptTokens,
          completionTokens: delta.usage.completionTokens,
          totalTokens: delta.usage.totalTokens,
          cachedTokens: delta.usage.cachedTokens,
          reasoningTokens: delta.usage.reasoningTokens,
        },
      };
      break;
    case "done":
      payload = { kind: "done" };
      break;
    case "aborted":
      // Discriminant only — nothing to sanitize, and nothing to add. The
      // renderer needs to know THIS stream ended, not why.
      payload = { kind: "aborted" };
      break;
    case "error":
      // Raw provider text is NOT trusted at the boundary — replace it. The
      // bounded `errorType` enum label DOES cross: it is a closed-vocabulary
      // classification, not prose, and it is the only thing that lets the
      // preview say why the stream died instead of just "Stream error".
      payload = {
        kind: "error",
        message: SAFE_STREAM_ERROR_MESSAGE,
        code: delta.code ?? null,
        errorType: delta.errorType ?? null,
      };
      break;
    default:
      return null;
  }

  return {
    type: STREAM_DELTA_EVENT_TYPE,
    sessionId: event.sessionId,
    streamId: event.streamId,
    sequence: event.sequence,
    deltaType: payload.kind,
    delta: payload,
    createdAt: event.createdAt,
    correlationId: event.correlationId,
  };
}

/**
 * Subscribe the stream bus to the IPC broadcaster. Returns the teardown
 * callback — caller pushes it into `globalCleanup` so app quit / reload
 * removes the listener cleanly.
 */
export function setupStreamBridge(): () => void {
  const off = streamDeltaBus.subscribe((event) => {
    let mapped: RendererStreamDeltaEvent | null;
    try {
      mapped = toRendererStreamDelta(event);
    } catch (err) {
      // Fail-closed: a malformed engine event must never crash the bridge.
      log.warn("[agent:stream-bridge] mapper threw on engine.stream.delta", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (mapped === null) {
      log.warn("[agent:stream-bridge] dropped unmappable engine.stream.delta");
      return;
    }

    const parsed = streamDeltaEventSchema.safeParse(mapped);
    if (!parsed.success) {
      // Structured + payload-free log (no delta content leak).
      log.warn("[agent:stream-bridge] dropped invalid engine.streamDelta payload", {
        issues: parsed.error.issues,
      });
      return;
    }

    broadcastToAllWindows(EV.engine.streamDelta, parsed.data);
  });

  return () => {
    off();
  };
}
