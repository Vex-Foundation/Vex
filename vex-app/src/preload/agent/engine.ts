/**
 * Preload-side engine events bridge.
 *
 * Re-validates every emit through the shared Zod schema before delivering
 * it to the renderer callback (third validation layer after the engine
 * type-check and the main-side bridge). A misbehaving main never injects
 * unexpected shapes into renderer state.
 */

import { EV } from "../../shared/ipc/channels.js";
import { engineErrorEventSchema } from "../../shared/schemas/engine-error.js";
import { transcriptAppendEventSchema } from "../../shared/schemas/messages.js";
import { missionUpdateEventSchema } from "../../shared/schemas/mission-update.js";
import { controlStateEventSchema } from "../../shared/schemas/runtime.js";
import { streamDeltaEventSchema } from "../../shared/schemas/stream.js";
import type { EngineEventsBridge } from "../../shared/types/bridge/agent/engine.js";
import { subscribe } from "../_dispatch.js";

export const engine = {
  onTranscriptAppend: (cb) =>
    subscribe(EV.engine.transcriptAppend, transcriptAppendEventSchema, cb),
  onStreamDelta: (cb) =>
    subscribe(EV.engine.streamDelta, streamDeltaEventSchema, cb),
  onControlState: (cb) =>
    subscribe(EV.engine.controlState, controlStateEventSchema, cb),
  onEngineError: (cb) => subscribe(EV.engine.error, engineErrorEventSchema, cb),
  onMissionUpdate: (cb) =>
    subscribe(EV.engine.missionUpdate, missionUpdateEventSchema, cb),
} satisfies EngineEventsBridge;
