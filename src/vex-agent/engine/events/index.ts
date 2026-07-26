/**
 * Engine event spine — barrel.
 *
 * Producers (turn loop, runner, tool overflow, wake executor, …) import
 * from this barrel. The `vex-app` main-process bridge intentionally
 * imports the bus directly from `./transcript-bus.js` to avoid pulling
 * in the `addMessageReturningId` storage dependency through this index.
 */

export {
  TRANSCRIPT_APPEND_EVENT_TYPE,
  TranscriptEventBus,
  transcriptEventBus,
  type TranscriptAppendEvent,
  type TranscriptAppendListener,
  type TranscriptAppendRole,
} from "./transcript-bus.js";

export {
  appendMessage,
  appendEngineMessage,
  emitTranscriptAppend,
  type AppendOptions,
} from "./append-transcript.js";

export {
  STREAM_DELTA_EVENT_TYPE,
  StreamDeltaBus,
  streamDeltaBus,
  toStreamDeltaEvent,
  type StreamDeltaEvent,
  type StreamDeltaListener,
  type StreamDeltaType,
  type StreamDeltaPayload,
} from "./stream-bus.js";
