/**
 * A SCRIPTED FAKE FRONT: the other end of the internal wire, in this process.
 *
 * NOT A TEST SPEC. It is a helper module the front suites import, and it is
 * deliberately built the way VS Code builds `Ether` in
 * `src/vs/base/parts/ipc/test/node/ipc.net.test.ts`: both ends are scripted,
 * delivery is SYNCHRONOUS, and the ordering of every step is the test's to
 * choose. A `PassThrough` would have made every assertion wait on an event-loop
 * turn and turned "did main send `CREDIT` before `ADMIT`" into a race the test
 * could only sample.
 *
 * It speaks the REAL codec in both directions. Nothing here re-implements a
 * frame: the fake encodes with `encodePipeFrontFrame` and decodes main's planes
 * with `PipeFrontFrameDecoder`, so a suite that passes against this fake is a
 * suite that passed against the bytes the Go front will read.
 */

import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

import {
  PIPE_FRONT_PLANE,
  PipeFrontFrameDecoder,
  encodePipeFrontFrame,
  type PipeFrontBody,
  type PipeFrontFrame,
  type PipeFrontMalformed,
} from "@vex-agent/mcp/pipe-front-frames.js";

import type { FrontChild } from "../mcp-host/front-spawn.js";
import type { FrontPlaneStreams } from "../mcp-host/front-planes.js";

/**
 * One plane, delivered synchronously.
 *
 * `write` emits `data` on this same object, which is a `PassThrough`'s
 * semantics without its scheduling: whichever side is not writing is the side
 * listening.
 */
class SyncPlane extends EventEmitter {
  destroyed = false;
  /** Every chunk written, so a test can assert nothing was sent at all. */
  readonly writes: Buffer[] = [];

  write(chunk: Uint8Array): boolean {
    if (this.destroyed) return false;
    const buffer = Buffer.from(chunk);
    this.writes.push(buffer);
    this.emit("data", buffer);
    return true;
  }

  /** Readable EOF, as a closed pipe handle would deliver it. */
  finish(): void {
    this.emit("end");
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

export interface FakeFrontOptions {
  readonly pid?: number;
  /** The generation `HELLO_ACK` announces. */
  readonly generation?: number;
}

export class FakeFront implements FrontChild {
  readonly pid: number;
  readonly planes: FrontPlaneStreams;
  readonly stderr: Readable;

  /** Frames main wrote on plane 3, decoded with the real codec. */
  readonly controlDown: PipeFrontFrame[] = [];
  /** Frames main wrote on plane 5, decoded with the real codec. */
  readonly dataDown: PipeFrontFrame[] = [];
  /** Anything main wrote that the front's own decoder would reject. */
  readonly malformedFromMain: PipeFrontMalformed[] = [];

  killed = 0;

  private readonly controlDownPlane = new SyncPlane();
  private readonly controlUpPlane = new SyncPlane();
  private readonly dataDownPlane = new SyncPlane();
  private readonly dataUpPlane = new SyncPlane();
  private readonly stderrPlane = new SyncPlane();

  private readonly controlDownDecoder: PipeFrontFrameDecoder;
  private readonly dataDownDecoder: PipeFrontFrameDecoder;

  private generation: number;
  private controlUpSequence = 1n;
  private dataUpSequence = 1n;

  private exitListeners: ((code: number | null) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];

  constructor(options: FakeFrontOptions = {}) {
    this.pid = options.pid ?? 4242;
    this.generation = options.generation ?? 0x51ee_1234;
    this.controlDownDecoder = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.controlDown,
      generation: 0,
    });
    this.dataDownDecoder = new PipeFrontFrameDecoder({
      plane: PIPE_FRONT_PLANE.dataDown,
      generation: 0,
    });

    this.controlDownPlane.on("data", (chunk: Buffer) => {
      for (const event of this.controlDownDecoder.push(chunk)) {
        if (event.kind === "malformed") this.malformedFromMain.push(event.malformed);
        else this.controlDown.push(event.frame);
      }
    });
    this.dataDownPlane.on("data", (chunk: Buffer) => {
      for (const event of this.dataDownDecoder.push(chunk)) {
        if (event.kind === "malformed") this.malformedFromMain.push(event.malformed);
        else this.dataDown.push(event.frame);
      }
    });

    this.planes = {
      // The four planes are duplex pipe handles in production. The suite drives
      // each direction separately, so each side is typed as the half it uses.
      controlDown: this.controlDownPlane as unknown as Writable,
      controlUp: this.controlUpPlane as unknown as Readable,
      dataDown: this.dataDownPlane as unknown as Writable,
      dataUp: this.dataUpPlane as unknown as Readable,
    };
    this.stderr = this.stderrPlane as unknown as Readable;
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  kill(): void {
    this.killed += 1;
  }

  /* -------------------------------------------------------------- scripting */

  /** The `HELLO` main sent, or `undefined` when it has sent none. */
  hello(): Extract<PipeFrontFrame, { type: "HELLO" }> | undefined {
    return this.controlDown.find(
      (frame): frame is Extract<PipeFrontFrame, { type: "HELLO" }> =>
        frame.type === "HELLO",
    );
  }

  /** Every plane 3 frame of one type, in order. */
  controlOfType<T extends PipeFrontFrame["type"]>(
    type: T,
  ): Extract<PipeFrontFrame, { type: T }>[] {
    return this.controlDown.filter(
      (frame): frame is Extract<PipeFrontFrame, { type: T }> => frame.type === type,
    );
  }

  /** Every plane 5 frame of one type, in order. */
  dataOfType<T extends PipeFrontFrame["type"]>(
    type: T,
  ): Extract<PipeFrontFrame, { type: T }>[] {
    return this.dataDown.filter(
      (frame): frame is Extract<PipeFrontFrame, { type: T }> => frame.type === type,
    );
  }

  /**
   * Complete the bootstrap: `HELLO_ACK` then `BOUND` with every required flag.
   *
   * Two frames in ONE push by default, which is the case protocol 6.1 is about:
   * the codec adopts the generation while decoding, so a supervisor that acted
   * on `BOUND` before validating the ack would be acting on an unvalidated
   * child. Suites that want them apart call the two methods themselves.
   */
  completeHandshake(
    over: {
      readonly generation?: number;
      readonly pid?: number;
      readonly protocolVersion?: number;
      readonly flagsApplied?: number;
      readonly pipeName?: string;
      readonly batched?: boolean;
    } = {},
  ): void {
    const pipeName = over.pipeName ?? this.hello()?.pipeName ?? "";
    if (over.batched === false) {
      this.sendHelloAck(over);
      this.sendBound({ flagsApplied: over.flagsApplied, pipeName });
      return;
    }
    this.sendControlBatch([
      this.helloAckBody(over),
      {
        type: "BOUND",
        flagsApplied: over.flagsApplied ?? 0x07,
        pipeName,
      },
    ]);
  }

  sendHelloAck(
    over: {
      readonly generation?: number;
      readonly pid?: number;
      readonly protocolVersion?: number;
    } = {},
  ): void {
    this.sendControlBatch([this.helloAckBody(over)]);
  }

  sendBound(
    over: { readonly flagsApplied?: number; readonly pipeName?: string } = {},
  ): void {
    this.sendControl({
      type: "BOUND",
      flagsApplied: over.flagsApplied ?? 0x07,
      pipeName: over.pipeName ?? this.hello()?.pipeName ?? "",
    });
  }

  sendOpen(connection: number): void {
    this.sendControl({ type: "OPEN" }, connection);
  }

  sendWriteDone(connection: number, ackThroughSequence: bigint): void {
    this.sendControl({ type: "WRITE_DONE", ackThroughSequence }, connection);
  }

  sendPeerClosed(
    connection: number,
    reason: "peer_eof" | "io_error" | "commanded_close",
    throughDataSequence: bigint,
  ): void {
    this.sendControl({ type: "PEER_CLOSED", reason, throughDataSequence }, connection);
  }

  sendLockAck(admissionEpoch: number, closedCount: number): void {
    this.sendControl({ type: "LOCK_ACK", admissionEpoch, closedCount });
  }

  sendQuitAck(): void {
    this.sendControl({ type: "QUIT_ACK" });
  }

  sendError(code: number, count: number): void {
    this.sendControl({ type: "ERROR", code, count });
  }

  sendData(connection: number, payload: Uint8Array): void {
    this.sendData_(connection, { type: "DATA", payload });
  }

  sendPeerEnd(connection: number): void {
    this.sendData_(connection, { type: "END" });
  }

  /** Bytes that are not a legal frame, for the malformed path. */
  sendRawControl(bytes: Uint8Array): void {
    this.controlUpPlane.write(bytes);
  }

  /** One structural stderr chunk, as the front's logger writes them. */
  sendStderr(text: string): void {
    this.stderrPlane.emit("data", Buffer.from(text, "utf8"));
  }

  /** Plane 4 reaches EOF. */
  endControlUp(): void {
    this.controlUpPlane.finish();
  }

  /** Plane 6 raises an I/O error. */
  failDataUp(): void {
    this.dataUpPlane.fail(new Error("plane 6 failed"));
  }

  /** The child process exits. */
  exit(code: number | null): void {
    for (const listener of [...this.exitListeners]) listener(code);
  }

  /** `spawn` raised `error` after returning a child. */
  raiseError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  /* --------------------------------------------------------------- private */

  private helloAckBody(over: {
    readonly generation?: number;
    readonly pid?: number;
    readonly protocolVersion?: number;
  }): PipeFrontBody {
    const generation = over.generation ?? this.generation;
    this.generation = generation;
    // The front's plane 3 and plane 5 decoders are TOLD the generation by their
    // owner (protocol 4); only the plane 4 reader learns it from the ack. The
    // fake owns these two, so the fake tells them - and gets the real codec's
    // one-shot guard for free.
    if (generation !== 0) {
      this.controlDownDecoder.adoptGeneration(generation);
      this.dataDownDecoder.adoptGeneration(generation);
    }
    return {
      type: "HELLO_ACK",
      protocolVersion: over.protocolVersion ?? 1,
      announcedGeneration: generation,
      pid: over.pid ?? this.pid,
      frontVersion: "test",
      buildHash: "test",
    };
  }

  private sendControl(body: PipeFrontBody, connection = 0): void {
    this.sendControlBatch([body], connection);
  }

  /**
   * Several plane 4 frames in ONE chunk.
   *
   * That is what an OS read of a shared plane looks like, and it is the shape
   * the tail-discard rule of protocol 6.1 exists for.
   */
  private sendControlBatch(bodies: readonly PipeFrontBody[], connection = 0): void {
    const parts: Uint8Array[] = [];
    for (const body of bodies) {
      const bootstrap = body.type === "HELLO_ACK";
      parts.push(
        encodePipeFrontFrame({
          plane: PIPE_FRONT_PLANE.controlUp,
          generation: bootstrap ? 0 : this.generation,
          connection: bodyNamesConnection(body) ? connection : 0,
          sequence: this.controlUpSequence,
          ...body,
        }),
      );
      this.controlUpSequence += 1n;
    }
    this.controlUpPlane.write(Buffer.concat(parts));
  }

  private sendData_(connection: number, body: PipeFrontBody): void {
    this.dataUpPlane.write(
      encodePipeFrontFrame({
        plane: PIPE_FRONT_PLANE.dataUp,
        generation: this.generation,
        connection,
        sequence: this.dataUpSequence,
        ...body,
      }),
    );
    this.dataUpSequence += 1n;
  }
}

/** Protocol 2.1's table, as the fake needs it for the frames it sends. */
function bodyNamesConnection(body: PipeFrontBody): boolean {
  switch (body.type) {
    case "OPEN":
    case "WRITE_DONE":
    case "PEER_CLOSED":
    case "DATA":
    case "END":
      return true;
    default:
      return false;
  }
}
