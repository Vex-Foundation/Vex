/**
 * Engine -> renderer error bridge.
 *
 * Subscribes to the in-process `engineErrorBus`
 * (`src/vex-agent/engine/runtime/error-bus.ts`) and broadcasts a validated,
 * bounded failure signal to every BrowserWindow on `EV.engine.error`.
 *
 * Like `stream-bridge` (and unlike the pass-through `transcript-bridge`), this
 * bridge MAPS before validating, because the boundary adds something the
 * engine deliberately does not compute: the user-facing `category`. There is
 * exactly ONE classifier (`shared/engine-error-classification.ts`), fed by the
 * raw bounded signals, so the renderer, the chat IPC error mapper and this
 * bridge can never disagree about what a 429 means.
 *
 * The mapper is fail-closed + non-throwing: anything it cannot safely map
 * becomes `null` and is dropped + logged, never forwarded. After mapping, the
 * strict shared schema re-validates (the preload subscriber re-validates a
 * third time). In particular the schema's CLOSED `errorClass` enum means an
 * SDK upgrade that introduces a new class drops the event rather than
 * smuggling an unknown token into the renderer.
 *
 * NO PROSE CROSSES HERE. There is no message field to forward — by
 * construction, at every layer. The human-readable provider message stays in
 * the logs and in `mission_runs` evidence, server-side.
 *
 * Import discipline: the bus is imported DIRECTLY from `error-bus.js`, not the
 * engine barrel, which would pull the DB client into the main-process graph at
 * bridge-setup time.
 */

import { EV } from "@shared/ipc/channels.js";
import { classifyEngineFailure } from "@shared/engine-error-classification.js";
import {
  ENGINE_ERROR_EVENT_TYPE,
  engineErrorClassSchema,
  engineErrorEventSchema,
  type EngineErrorEvent as RendererEngineErrorEvent,
} from "@shared/schemas/engine-error.js";
import {
  engineErrorBus,
  type EngineErrorEvent as EngineSideErrorEvent,
} from "@vex-agent/engine/runtime/error-bus.js";
import { broadcastToAllWindows } from "../lifecycle/broadcast.js";
import { log } from "../logger/index.js";

/** Narrow an engine-supplied class name through the CLOSED boundary enum. */
function boundedErrorClass(
  value: string | null,
): RendererEngineErrorEvent["errorClass"] {
  if (value === null) return null;
  const parsed = engineErrorClassSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Map a raw engine error event to the renderer shape, stamping the category.
 * Pure + defensive — treats the input as untrusted. Returns `null` for a
 * null/missing event so the caller drops it.
 */
export function toRendererEngineError(
  event: EngineSideErrorEvent,
): RendererEngineErrorEvent | null {
  // Defensive: the bus is typed, but this bridge is the trust boundary.
  if (event === null || typeof event !== "object") return null;

  const category = classifyEngineFailure({
    errorType: event.errorType,
    errorClass: event.errorClass,
    statusCode: event.statusCode,
    causeCode: event.causeCode,
  });

  return {
    type: ENGINE_ERROR_EVENT_TYPE,
    sessionId: event.sessionId,
    missionRunId: event.missionRunId,
    scope: event.scope,
    category,
    errorType: event.errorType,
    // Narrowed through the closed enum rather than cast. An `errorClass`
    // outside the dictionary means the SDK changed under us; dropping just
    // that field is right, because dropping the whole event would lose a real
    // failure the user still needs to see — and `category` already fell
    // through to the status branch for exactly this case.
    errorClass: boundedErrorClass(event.errorClass),
    statusCode: event.statusCode,
    causeCode: event.causeCode,
    retryAfterSeconds: event.retryAfterSeconds,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
  };
}

/**
 * Subscribe the error bus to the IPC broadcaster. Returns the teardown —
 * the caller pushes it into `globalCleanup` so app quit / reload removes the
 * listener cleanly.
 */
export function setupErrorBridge(): () => void {
  const off = engineErrorBus.subscribe((event) => {
    let mapped: RendererEngineErrorEvent | null;
    try {
      mapped = toRendererEngineError(event);
    } catch (err) {
      // Fail-closed: a malformed engine event must never crash the bridge —
      // least of all the bridge whose whole job is reporting failures.
      log.warn("[agent:error-bridge] mapper threw on engine.runtime.error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (mapped === null) {
      log.warn("[agent:error-bridge] dropped unmappable engine.runtime.error");
      return;
    }

    const parsed = engineErrorEventSchema.safeParse(mapped);
    if (!parsed.success) {
      // Structured + payload-free log (no error content leak).
      log.warn("[agent:error-bridge] dropped invalid engine.error payload", {
        issues: parsed.error.issues,
      });
      return;
    }

    broadcastToAllWindows(EV.engine.error, parsed.data);
  });

  return () => {
    off();
  };
}
