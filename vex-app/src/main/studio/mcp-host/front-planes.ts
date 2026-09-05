/**
 * THE FOUR FRAMED PLANES of one front generation, and their only owner.
 *
 * Normative wire: `pipe-front-protocol.md` sections 1 (planes), 2 (header), 3
 * (per-plane sequence), 4 (generation adoption) and 10 (malformed is fatal and
 * terminal).
 *
 * ## What this module owns, and what it refuses to own
 *
 * It owns FOUR streams, TWO sequence counters (planes 3 and 5, where main is
 * the sender), TWO decoders (planes 4 and 6, where main is the reader) and the
 * generation those four agree on. It owns nothing about connections, credit,
 * admission or windows: those are relay state with a different lifetime
 * (protocol 11.3), and a plane owner that knew about them would be the relay.
 *
 * ## ONE DECODER SET PER CHILD, and the leak it prevents
 *
 * A restart is a NEW generation with every plane's sequence back at 1
 * (protocol 3), so a decoder cannot be reused across children: it holds the old
 * generation, the old expected sequence and possibly a latched malformed
 * failure. `dispose()` detaches every listener from the four streams and drops
 * the decoders, and the supervisor constructs a fresh `FrontPlanes` per spawn.
 * That is the leak class VS Code's `ptyHostService.test.ts` pins for its own
 * restart path ("listener counts should not grow across pty host restarts"),
 * reproduced here for four decoders, two writers and their listeners.
 *
 * ## Generation adoption is asymmetric, and the protocol says so
 *
 * The plane 4 decoder LEARNS the generation from `HELLO_ACK` itself, because
 * every frame behind the ack in the same OS read would otherwise be
 * `bad_generation`. Planes 3, 5 and 6 are TOLD by their owner
 * (`adoptGeneration`), which is this module acting on the supervisor's word
 * after the ack has been validated. The codec's adoption is one-shot and throws
 * on a second call, so a restarted front's frames can never re-point a live
 * reader.
 */

import type { Readable, Writable } from "node:stream";

import {
  PIPE_FRONT_PLANE,
  PipeFrontFrameDecoder,
  encodePipeFrontFrame,
  type PipeFrontBody,
  type PipeFrontDecodeEvent,
  type PipeFrontMalformed,
  type PipeFrontPlane,
} from "@vex-agent/mcp/pipe-front-frames.js";

/** The four streams main inherits from the child, slots 3 to 6. */
export interface FrontPlaneStreams {
  /** Slot 3, main -> front control. */
  readonly controlDown: Writable;
  /** Slot 4, front -> main control. */
  readonly controlUp: Readable;
  /** Slot 5, main -> front data. */
  readonly dataDown: Writable;
  /** Slot 6, front -> main data. */
  readonly dataUp: Readable;
}

export interface FrontPlaneHandlers {
  /**
   * One decoded batch from plane 4, IN ORDER.
   *
   * A batch rather than a frame because protocol 6.1 makes the ordering
   * normative: the supervisor must validate `HELLO_ACK` before acting on any
   * later frame of the SAME push, and discard the tail when it fails. A
   * per-frame callback would have handed those later frames out already.
   */
  readonly onControlUp: (batch: readonly PipeFrontDecodeEvent[]) => void;
  /** One decoded batch from plane 6, in order. */
  readonly onDataUp: (batch: readonly PipeFrontDecodeEvent[]) => void;
  /** A readable plane reached EOF. Terminal for the front (protocol 8). */
  readonly onPlaneEof: (plane: PipeFrontPlane) => void;
  /** A plane raised an I/O error. Terminal. */
  readonly onPlaneError: (plane: PipeFrontPlane, error: Error) => void;
}

/**
 * A frame body plus the connection it names. The plane, the generation and the
 * sequence are this module's to assign, and a caller that could set them would
 * be a second owner of the counter.
 */
export interface FrontOutboundFrame {
  readonly connection: number;
  readonly body: PipeFrontBody;
}

export class FrontPlanes {
  private readonly streams: FrontPlaneStreams;
  private readonly handlers: FrontPlaneHandlers;

  /** Plane 3 and plane 5 sequences. Per plane, from 1, exactly contiguous. */
  private controlDownSequence = 1n;
  private dataDownSequence = 1n;

  private readonly controlUpDecoder: PipeFrontFrameDecoder;
  private readonly dataUpDecoder: PipeFrontFrameDecoder;

  private generation = 0;
  private disposed = false;

  /** Every listener this module attached, for an idempotent detach. */
  private readonly detachers: (() => void)[] = [];

  constructor(streams: FrontPlaneStreams, handlers: FrontPlaneHandlers) {
    this.streams = streams;
    this.handlers = handlers;
    this.controlUpDecoder = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.controlUp,
      generation: 0,
    });
    this.dataUpDecoder = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.dataUp,
      generation: 0,
    });

    this.attachReadable(
      streams.controlUp,
      PIPE_FRONT_PLANE.controlUp,
      this.controlUpDecoder,
      handlers.onControlUp,
    );
    this.attachReadable(
      streams.dataUp,
      PIPE_FRONT_PLANE.dataUp,
      this.dataUpDecoder,
      handlers.onDataUp,
    );
    this.attachWritable(streams.controlDown, PIPE_FRONT_PLANE.controlDown);
    this.attachWritable(streams.dataDown, PIPE_FRONT_PLANE.dataDown);
  }

  /**
   * Adopt the generation `HELLO_ACK` announced, for the three planes that do
   * not learn it themselves.
   *
   * Called ONLY after the supervisor has validated the ack. The plane 4 decoder
   * has already adopted it inside its own `push` and must not be told again -
   * the codec throws on a second adoption, which is the guard against exactly
   * the re-pointing protocol section 4 forbids.
   */
  adoptGeneration(generation: number): void {
    this.generation = generation;
    this.dataUpDecoder.adoptGeneration(generation);
  }

  /** The malformed frame that ended a reader, or `null` while both are live. */
  failure(): PipeFrontMalformed | null {
    return this.controlUpDecoder.failure ?? this.dataUpDecoder.failure;
  }

  /** The greatest plane 6 sequence delivered so far. Protocol 6.3's close gate. */
  dataUpDelivered(): bigint {
    // The decoder's next expected sequence is one past the last it delivered,
    // and it starts at 1, so `expected - 1` is "delivered through", including
    // the `0` the protocol uses for a connection that received nothing.
    return this.dataUpDecoder.expectedSequence - 1n;
  }

  /**
   * Write one CONTROL frame to the front (plane 3).
   *
   * Returns whether the OS accepted it now. The caller does not park on that:
   * control frames are bounded by their own protocol (one `HELLO`, one `LOCK`,
   * one `CREDIT` per consumed window) and Node buffers what the pipe cannot
   * take, exactly as VS Code's `NodeSocket.write` documents. What bounds this
   * plane is the protocol, not a queue here.
   */
  writeControl(frame: FrontOutboundFrame): boolean {
    if (this.disposed || this.streams.controlDown.destroyed) return false;
    const sequence = this.controlDownSequence;
    const accepted = this.write(
      this.streams.controlDown,
      PIPE_FRONT_PLANE.controlDown,
      frame,
      sequence,
    );
    // ADVANCED ONLY AFTER THE BYTES ARE WRITTEN. `encodePipeFrontFrame` throws
    // on anything the protocol forbids, and a counter advanced before the throw
    // would put a `sequence_gap` on the next frame - turning a host bug the
    // encoder caught into a framing fault that kills the front.
    this.controlDownSequence += 1n;
    return accepted;
  }

  /**
   * Write one DATA-plane frame to the front (plane 5) and return the sequence
   * it was given, or `null` when the plane is already gone.
   *
   * The sequence is RETURNED because it is the relay's window accounting key:
   * `WRITE_DONE` acknowledges THROUGH a sequence (protocol 6.4), so the relay
   * must know which sequence carried which chunk and which sequence is a
   * logical write's last.
   */
  writeData(frame: FrontOutboundFrame): bigint | null {
    if (this.disposed || this.streams.dataDown.destroyed) return null;
    const sequence = this.dataDownSequence;
    this.write(this.streams.dataDown, PIPE_FRONT_PLANE.dataDown, frame, sequence);
    this.dataDownSequence += 1n;
    // The OS-level `false` is deliberately DISCARDED here. The relay's bound is
    // the protocol's per-connection window of 65536 unacknowledged bytes
    // (protocol 11.2), which is half the measured 131072-byte pipe buffer;
    // parking on the stream's own drain as well would add a second, unrelated
    // pacing signal to a plane whose fairness is already round-robin.
    return sequence;
  }

  /**
   * Detach every listener and drop the decoders. IDEMPOTENT, and safe after a
   * partial construction: the supervisor calls it from its own failure paths.
   *
   * It does NOT destroy the streams. They belong to the child process, and the
   * supervisor kills that child; destroying a stdio stream here would race the
   * kill and hide the exit code the supervisor maps to a cause.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const detach of this.detachers.splice(0, this.detachers.length)) {
      detach();
    }
  }

  private attachReadable(
    stream: Readable,
    plane: PipeFrontPlane,
    decoder: PipeFrontFrameDecoder,
    deliver: (batch: readonly PipeFrontDecodeEvent[]) => void,
  ): void {
    const onData = (chunk: Buffer): void => {
      if (this.disposed) return;
      const batch = decoder.push(chunk);
      if (batch.length > 0) deliver(batch);
    };
    const onEnd = (): void => {
      if (this.disposed) return;
      this.handlers.onPlaneEof(plane);
    };
    const onError = (error: Error): void => {
      if (this.disposed) return;
      this.handlers.onPlaneError(plane, error);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    this.detachers.push(() => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    });
  }

  private attachWritable(stream: Writable, plane: PipeFrontPlane): void {
    // A writable plane's failure is reported through the same seam as a
    // readable one: EPIPE on plane 3 while the child is dying is the ordinary
    // shape of "the front is gone", and the supervisor is the one owner that
    // decides what that costs.
    const onError = (error: Error): void => {
      if (this.disposed) return;
      this.handlers.onPlaneError(plane, error);
    };
    stream.on("error", onError);
    this.detachers.push(() => {
      stream.off("error", onError);
    });
  }

  private write(
    stream: Writable,
    plane: PipeFrontPlane,
    frame: FrontOutboundFrame,
    sequence: bigint,
  ): boolean {
    // The encoder REFUSES rather than truncates (protocol 9): a refusal line
    // that would not fit the control bound is a host bug, and it throws here so
    // the supervisor reports it instead of writing a short frame the front
    // would read as the next header.
    const bytes = encodePipeFrontFrame({
      plane,
      generation: this.generation,
      connection: frame.connection,
      sequence,
      ...frame.body,
    });
    return stream.write(bytes);
  }
}
