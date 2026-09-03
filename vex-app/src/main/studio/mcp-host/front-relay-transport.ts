/**
 * THE SECOND IMPLEMENTATION of the Studio byte wire: one logical connection
 * relayed through the Windows pipe-front child process.
 *
 * `node-socket-transport.ts` is the first one and it is a passthrough, because
 * a `net.Socket` already has every semantic the contract promises. This one has
 * to BUILD them - the half-open latches, the backpressure, the write-completion
 * meaning - out of frames on a plane shared by up to twenty-one connections.
 * The contract it satisfies is unchanged (`@vex-agent/mcp/duplex-transport.js`),
 * which is the entire point: nothing in `StudioConnection`, the outbound queue,
 * the MCP framing or the engine knows which of the two it is holding.
 *
 * Normative wire: `pipe-front-protocol.md` sections 6.3 (`PEER_CLOSED` and the
 * delayed close edge), 6.4 (cumulative `WRITE_DONE`), 7 (`DATA` and `END`),
 * 11.1 (credit, front -> main), 11.2 (the main -> front window) and 12.2/12.3
 * (main's per-connection machine and its named failures).
 *
 * ## The write callback means THE PIPE WRITE RETURNED, and nothing sooner
 *
 * `duplex-transport.ts` states it as law: "An implementation that relays
 * through another process (the Windows pipe-front) may only run it once that
 * process has reported the pipe write complete; running it on hand-off to the
 * relay would make the outbound queue believe a frame is delivered while it
 * sits in somebody else's buffer, and the queue's bound would stop bounding
 * anything real." So a logical write's callback fires on the FIRST
 * `WRITE_DONE` whose `ackThroughSequence` covers that write's LAST plane 5
 * sequence - never on the first ack, never on hand-off.
 *
 * `WRITE_DONE` is CUMULATIVE, in the shape VS Code's `PersistentProtocol` uses
 * for `_incomingAckId`: one number acknowledges everything up to itself, the
 * peer may send it as often or as rarely as it likes, and the receiver pops its
 * unacknowledged queue while the head is covered. That is why a 4 MiB response
 * cannot pin the 65536-byte window: it is paced by acknowledgements INSIDE the
 * one logical write.
 *
 * ## THE TEARDOWN CAUSE IS NOT OURS
 *
 * This module raises the `close` edge and authors no cause at all. The trusted
 * typed cause is `StudioConnection.cause`, latched by `destroyNow(cause)` in
 * the tick main decides, and a `PEER_CLOSED` that arrives after a latched
 * `lock` or `vex_quit` cannot rewrite it - not by policy, but because there is
 * no code path here that could. The front cannot author `lock` and does not
 * know the word (protocol 6.3 and 13).
 *
 * ## Independent latches, never one `ended`
 *
 * `readableEnded` is set by `END` on plane 6 (the peer's FIN) and
 * `writableEnded` by `end()` (our `END` on plane 5). They are separate fields
 * and neither implies the other, because half-open is the contract: "a peer
 * that half-closes is saying 'no more requests', not 'no more answers'".
 */

import { EventEmitter } from "node:events";

import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";
import type { PipeFrontFrame } from "@vex-agent/mcp/pipe-front-frames.js";

import { log } from "../../logger/index.js";
import {
  FRONT_CHUNK_BYTES,
  FRONT_CREDIT_BYTES,
  type FrontFailureName,
} from "./front-handshake.js";
import type { FrontPlanes } from "./front-planes.js";

/**
 * Logical writes one connection may hold before main declares a defect.
 *
 * THE POLICY IS REJECT, NEVER UNBOUNDED, and the number is derived from the one
 * consumer: `StudioOutboundQueue` is a SERIALIZED writer that parks on `drain`
 * after a refused write, so the steady state is one. The headroom covers the
 * refusal path writing an ack beside a response already in flight. Crossing it
 * means a caller ignored `false`, which is a defect in this process rather than
 * a peer condition, so the connection fails closed instead of growing a queue
 * with a comforting name.
 */
export const FRONT_MAX_PENDING_WRITES = 8;

/** One logical `write()`, and where its chunks have got to. */
interface PendingWrite {
  readonly kind: "data";
  /** Views into the caller's encoded line. Each at most `FRONT_CHUNK_BYTES`. */
  readonly chunks: readonly Uint8Array[];
  /** How many chunks have been written to plane 5. */
  sent: number;
  /** The plane 5 sequence of the LAST chunk, once it has been written. */
  lastSequence: bigint | null;
  callback: (() => void) | undefined;
}

/** `end()`, queued on the data plane so it cannot overtake the last chunk. */
interface PendingEnd {
  readonly kind: "end";
}

type PendingItem = PendingWrite | PendingEnd;

/** One plane 5 chunk main has written and the front has not acknowledged. */
interface UnackedChunk {
  readonly sequence: bigint;
  readonly bytes: number;
}

interface RelayConnection {
  readonly id: number;
  readonly transport: FrontRelayTransport;

  /* ---- read side (plane 6, credit of protocol 11.1) ---- */
  /** Bytes the front may still send for this connection. Never above 65536. */
  grantedCredit: number;
  paused: boolean;
  /** Delivered under credit while the consumer was paused. Bounded by credit. */
  readonly held: Buffer[];
  heldBytes: number;
  readEnded: boolean;

  /* ---- write side (plane 5, window of protocol 11.2) ---- */
  writeEnded: boolean;
  readonly pending: PendingItem[];
  readonly unacked: UnackedChunk[];
  /** Written and not yet covered by an acknowledgement. Never above 65536. */
  outstanding: number;
  lastAck: bigint;
  /** Fully written, waiting for the ack that covers `lastSequence`. */
  readonly awaitingAck: PendingWrite[];
  /** The write whose `write()` returned `false`. `drain` waits on it. */
  blocking: PendingWrite | null;

  /* ---- lifecycle ---- */
  destroyed: boolean;
  closeRaised: boolean;
  /** `PEER_CLOSED` seen; the close edge waits for plane 6 to reach it (6.3). */
  pendingClose: { readonly through: bigint } | null;
}

export interface FrontRelayDeps {
  readonly planes: FrontPlanes;
  /** The admission epoch every `ADMIT` carries. Read per connection. */
  readonly admissionEpoch: () => number;
  /**
   * Main's own decision BEFORE a byte is read, as the exact line the peer will
   * see, or `null` to admit.
   *
   * This is the front architecture's form of "a locked host reads NOTHING":
   * `REFUSE` writes main's bytes and closes WITHOUT EVER READING (protocol 8),
   * so a locked Vex answers the connection without the front ever issuing a
   * read on the peer's handle. On the direct-socket path the same refusal is
   * written after the socket is registered, because there is no primitive there
   * that can answer without reading.
   */
  readonly refuseBeforeRead: () => string | null;
  /** An admitted connection, as the contract every consumer already speaks. */
  readonly onConnection: (wire: StudioDuplexTransport) => void;
  /** A protocol invariant broke. The supervisor kills and restarts the front. */
  readonly onFatal: (failure: FrontFailureName, detail: string) => void;
}

/**
 * THE DEMULTIPLEXER: one per front generation, owner of plane 5's writer and
 * plane 6's reader for EVERY logical connection.
 *
 * It exists because the two data planes are shared. A per-connection object
 * that owned its own writer would have no way to be fair, and fairness is a
 * protocol requirement in both directions (11.1 and 11.2): at most one 32768
 * byte chunk per connection per turn, round-robin, so one busy connection
 * cannot starve twenty others on a pipe they share.
 */
export class FrontRelay {
  private readonly deps: FrontRelayDeps;
  private readonly connections = new Map<number, RelayConnection>();
  /** Round-robin cursor over `connections`, in insertion order. */
  private rotation: number[] = [];
  private rotationCursor = 0;
  private closed = false;

  /** Frames naming a connection this relay no longer has. Counted, never dispatched. */
  private droppedFrames = 0;

  constructor(deps: FrontRelayDeps) {
    this.deps = deps;
  }

  /** Frames dropped for an unknown or closed connection. Exposed for the tests. */
  get droppedFrameCount(): number {
    return this.droppedFrames;
  }

  /** Logical connections the relay still holds. Exposed for the bound tests. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * One decoded plane 4 frame that names a connection.
   *
   * The supervisor routes `OPEN`, `WRITE_DONE` and `PEER_CLOSED` here and keeps
   * `HELLO_ACK`, `BOUND`, `LOCK_ACK`, `QUIT_ACK`, `PONG` and `ERROR` for
   * itself: those are lifecycle, and a relay that answered them would own two
   * state machines.
   */
  handleControlFrame(frame: PipeFrontFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      case "OPEN":
        this.handleOpen(frame.connection);
        return;
      case "WRITE_DONE":
        this.handleWriteDone(frame.connection, frame.ackThroughSequence);
        return;
      case "PEER_CLOSED":
        this.handlePeerClosed(frame.connection, frame.throughDataSequence);
        return;
      default:
        this.deps.onFatal(
          "unexpected_frame",
          `${frame.type} routed to the relay`,
        );
    }
  }

  /** One decoded plane 6 frame: `DATA` or `END`. */
  handleDataFrame(frame: PipeFrontFrame): void {
    if (this.closed) return;
    if (frame.type === "DATA") {
      this.handleData(frame.connection, frame.payload);
      return;
    }
    if (frame.type === "END") {
      this.handleEnd(frame.connection);
      return;
    }
    this.deps.onFatal("unexpected_frame", `${frame.type} on a data plane`);
  }

  /**
   * Plane 6 advanced. Any close edge waiting on a `throughDataSequence` that is
   * now delivered is released.
   *
   * Called after every plane 6 batch rather than after every frame: the gate is
   * "has the decoder delivered through that sequence", which is a property of
   * the batch's end, and checking per frame would raise the same edge twice.
   */
  afterDataBatch(): void {
    if (this.closed) return;
    const delivered = this.deps.planes.dataUpDelivered();
    for (const connection of [...this.connections.values()]) {
      const waiting = connection.pendingClose;
      if (waiting !== null && delivered >= waiting.through) {
        this.finishClose(connection);
      }
    }
  }

  /**
   * Every logical connection ends NOW, and every `close` edge is raised.
   *
   * Called when the front dies, is killed, or is locked: the handles are gone
   * whatever main believes, so holding a connection open would leave an MCP
   * handler awaiting a peer that cannot answer. In-flight write callbacks do
   * NOT fire - the writes did not complete, and claiming they did is the exact
   * lie the callback contract forbids - and the outbound queue settles on the
   * `close` edge instead, which is how it settles on a socket teardown too.
   */
  closeAll(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const open = [...this.connections.values()];
    this.connections.clear();
    this.rotation = [];
    this.rotationCursor = 0;
    for (const connection of open) {
      connection.destroyed = true;
      connection.pending.length = 0;
      connection.awaitingAck.length = 0;
      connection.unacked.length = 0;
      connection.blocking = null;
      this.raiseClose(connection, reason);
    }
  }

  /* ------------------------------------------------------------------ *
   * plane 4
   * ------------------------------------------------------------------ */

  private handleOpen(id: number): void {
    if (this.connections.has(id)) {
      // Connection ids are never reused within a generation (protocol 2.1), so
      // a repeat is a broken front, not a race.
      this.deps.onFatal("unexpected_frame", "OPEN repeated a connection id");
      return;
    }

    const refusal = this.deps.refuseBeforeRead();
    if (refusal !== null) {
      // REFUSE, and no transport at all: the front writes main's exact bytes
      // and closes without ever reading (protocol 8). Nothing is registered,
      // because there is no conversation to register.
      this.deps.planes.writeControl({
        connection: id,
        body: { type: "REFUSE", bytes: refusal },
      });
      return;
    }

    const transport = new FrontRelayTransport(this, id);
    const connection: RelayConnection = {
      id,
      transport,
      grantedCredit: 0,
      paused: false,
      held: [],
      heldBytes: 0,
      readEnded: false,
      writeEnded: false,
      pending: [],
      unacked: [],
      outstanding: 0,
      lastAck: 0n,
      awaitingAck: [],
      blocking: null,
      destroyed: false,
      closeRaised: false,
      pendingClose: null,
    };
    this.connections.set(id, connection);
    this.rotation.push(id);

    // ADMIT carries the epoch captured NOW. A `LOCK` that raises the epoch
    // between this line and the front reading it PURGES this order rather than
    // executing it (protocol 8), which is the fence working.
    this.deps.planes.writeControl({
      connection: id,
      body: { type: "ADMIT", admissionEpoch: this.deps.admissionEpoch() },
    });
    this.grantCredit(connection, FRONT_CREDIT_BYTES);
    this.deps.onConnection(transport);
  }

  private handleWriteDone(id: number, ack: bigint): void {
    const connection = this.live(id);
    if (connection === null) return;
    if (ack < connection.lastAck) {
      this.deps.onFatal("ack_regression", "WRITE_DONE went backwards");
      return;
    }
    const highest =
      connection.unacked.length === 0
        ? connection.lastAck
        : connection.unacked[connection.unacked.length - 1]!.sequence;
    if (ack > highest) {
      // An acknowledgement beyond the window main reserved. The front's own
      // violation set names it, and main mirrors it: a peer that acknowledges
      // bytes nobody sent has lost its place in the stream.
      this.deps.onFatal("ack_regression", "WRITE_DONE named an unsent sequence");
      return;
    }
    connection.lastAck = ack;

    // CUMULATIVE RELEASE, popping while the head is covered - VS Code's
    // `_outgoingUnackMsg` shape.
    while (connection.unacked.length > 0) {
      const head = connection.unacked[0]!;
      if (head.sequence > ack) break;
      connection.unacked.shift();
      connection.outstanding -= head.bytes;
    }

    // A logical write settles only when the acknowledgement covers its FINAL
    // sequence. An earlier ack releases window bytes and settles nothing.
    for (let i = connection.awaitingAck.length - 1; i >= 0; i -= 1) {
      const write = connection.awaitingAck[i]!;
      if (write.lastSequence !== null && write.lastSequence <= ack) {
        connection.awaitingAck.splice(i, 1);
        this.settle(connection, write);
      }
    }

    this.pump();
    this.maybeDrain(connection);
  }

  private handlePeerClosed(id: number, through: bigint): void {
    const connection = this.connections.get(id);
    if (connection === undefined) {
      this.droppedFrames += 1;
      return;
    }
    connection.pendingClose = { through };
    // THE CLOSE EDGE IS DELAYED until plane 6 has delivered through that
    // sequence (protocol 6.3). Control and data are different pipes with no
    // ordering between them, so without this the edge - which aborts every
    // in-flight handler - could overtake the peer's last response.
    if (this.deps.planes.dataUpDelivered() >= through) {
      this.finishClose(connection);
    }
  }

  /* ------------------------------------------------------------------ *
   * plane 6
   * ------------------------------------------------------------------ */

  private handleData(id: number, payload: Uint8Array): void {
    const connection = this.live(id);
    if (connection === null) return;
    if (connection.readEnded) {
      this.deps.onFatal("data_after_end", "DATA after END on plane 6");
      return;
    }
    if (payload.length > connection.grantedCredit) {
      this.deps.onFatal("credit_overrun", "DATA past the granted credit");
      return;
    }
    connection.grantedCredit -= payload.length;

    // THE BUFFER IS OURS NOW. The decoder allocated it at exactly the declared
    // length and dropped its own reference in the same statement, so wrapping
    // it costs no copy and nobody else can mutate it.
    const chunk = Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    if (connection.paused) {
      // MAIN DRAINS PLANE 6 CONTINUOUSLY, EVEN FOR A PAUSED CONNECTION
      // (protocol 11.1): the plane is shared, and a main that stopped reading
      // it would stall twenty others behind one paused consumer. What is
      // retained is bounded by the credit already granted, which is why
      // replenishment - not reading - is what `pause` stops.
      connection.held.push(chunk);
      connection.heldBytes += chunk.length;
      return;
    }
    connection.transport.emit("data", chunk);
    this.replenish(connection, chunk.length);
  }

  private handleEnd(id: number): void {
    const connection = this.live(id);
    if (connection === null) return;
    if (connection.readEnded) {
      this.deps.onFatal("data_after_end", "END repeated on plane 6");
      return;
    }
    connection.readEnded = true;
    connection.transport.readableEnded = true;
    // The WRITABLE side is preserved. A peer that half-closes is saying "no
    // more requests", not "no more answers" (protocol 7.1).
    connection.transport.emit("end");
  }

  /* ------------------------------------------------------------------ *
   * the transport's side
   * ------------------------------------------------------------------ */

  /** `write()` from one connection. Returns whether the wire accepted it now. */
  write(id: number, line: string, callback?: () => void): boolean {
    const connection = this.live(id);
    if (connection === null) return false;
    if (connection.writeEnded || connection.destroyed) {
      // The host guards every write on `destroyed` and `writableEnded`, so
      // this is a defensive branch. It is COUNTED rather than silent: a caller
      // that reaches it has a bug worth seeing in the structural log.
      this.droppedFrames += 1;
      return false;
    }

    const encoded = Buffer.from(line, "utf8");
    if (encoded.length === 0) {
      // A zero-byte `DATA` is malformed (protocol 7) and a zero-byte write
      // conveys nothing. It is accepted and settled rather than framed.
      if (callback !== undefined) queueMicrotask(callback);
      return true;
    }

    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < encoded.length; offset += FRONT_CHUNK_BYTES) {
      chunks.push(
        encoded.subarray(
          offset,
          Math.min(offset + FRONT_CHUNK_BYTES, encoded.length),
        ),
      );
    }
    const write: PendingWrite = {
      kind: "data",
      chunks,
      sent: 0,
      lastSequence: null,
      callback,
    };
    connection.pending.push(write);
    if (connection.pending.length > FRONT_MAX_PENDING_WRITES) {
      this.deps.onFatal(
        "unexpected_frame",
        `a connection queued more than ${String(FRONT_MAX_PENDING_WRITES)} logical writes`,
      );
      return false;
    }

    this.pump();

    const accepted = write.sent === chunks.length;
    if (!accepted) connection.blocking = write;
    return accepted;
  }

  /** `end()`: the half-close marker, ordered behind this connection's chunks. */
  end(id: number): void {
    const connection = this.live(id);
    if (connection === null) return;
    if (connection.writeEnded) return;
    connection.writeEnded = true;
    connection.transport.writableEnded = true;
    connection.pending.push({ kind: "end" });
    this.pump();
  }

  /** `destroy()`: `CLOSE` to the front, and the `close` edge here. */
  destroy(id: number): void {
    const connection = this.connections.get(id);
    if (connection === undefined || connection.destroyed) return;
    connection.destroyed = true;
    connection.pending.length = 0;
    connection.awaitingAck.length = 0;
    connection.unacked.length = 0;
    connection.outstanding = 0;
    connection.blocking = null;
    this.deps.planes.writeControl({
      connection: id,
      body: { type: "CLOSE" },
    });
    this.raiseClose(connection, "destroy");
    // The entry stays until `PEER_CLOSED` so a frame still in flight for it is
    // DROPPED AND COUNTED rather than dispatched - the same rule the front
    // applies to main's late frames (`dispatch.go` `live`).
  }

  /** `pause()`: the control frame AND the replenishment stop. Both, not either. */
  pause(id: number): void {
    const connection = this.live(id);
    if (connection === null || connection.paused) return;
    connection.paused = true;
    // Withholding credit alone would leave an already-granted 64 KiB window
    // arriving after main decided to pause; sending the frame alone would
    // leave a stale grant a `RESUME` cannot reason about (protocol 11.1).
    this.deps.planes.writeControl({ connection: id, body: { type: "PAUSE" } });
  }

  /** `resume()`: the frame, the held bytes, then replenishment. In that order. */
  resume(id: number): void {
    const connection = this.live(id);
    if (connection === null || !connection.paused) return;
    connection.paused = false;
    this.deps.planes.writeControl({ connection: id, body: { type: "RESUME" } });
    // Held bytes go out BEFORE new credit is granted, so the order the peer
    // sent them in is the order the consumer sees, and the consumer may pause
    // again in the middle of the flush without losing the remainder.
    while (!connection.paused && connection.held.length > 0) {
      const chunk = connection.held.shift()!;
      connection.heldBytes -= chunk.length;
      connection.transport.emit("data", chunk);
      this.replenish(connection, chunk.length);
    }
  }

  /* ------------------------------------------------------------------ *
   * internals
   * ------------------------------------------------------------------ */

  /**
   * THE ROUND-ROBIN PUMP for plane 5.
   *
   * One chunk per connection per turn, and never a chunk that would take a
   * connection past its 65536 unacknowledged bytes. The window alone does not
   * give fairness - twenty connections each inside their own window still queue
   * in whatever order main iterated - so both mechanisms are here, which is
   * what keeps `21 * 65536` a real aggregate (protocol 11.2).
   */
  private pump(): void {
    if (this.closed) return;
    for (;;) {
      let wrote = false;
      const round = [...this.rotation];
      for (let step = 0; step < round.length; step += 1) {
        const id = round[(this.rotationCursor + step) % round.length]!;
        const connection = this.connections.get(id);
        if (connection === undefined || connection.destroyed) continue;
        if (this.writeOneChunk(connection)) wrote = true;
      }
      this.rotationCursor = round.length === 0 ? 0 : (this.rotationCursor + 1) % round.length;
      if (!wrote) return;
    }
  }

  /** At most one plane 5 frame for this connection. `true` when one went out. */
  private writeOneChunk(connection: RelayConnection): boolean {
    const head = connection.pending[0];
    if (head === undefined) return false;

    if (head.kind === "end") {
      // `END` costs no window and is never acknowledged (protocol 6.4), but it
      // travels on the DATA plane so it cannot overtake the last chunk (7.1).
      connection.pending.shift();
      this.deps.planes.writeData({
        connection: connection.id,
        body: { type: "END" },
      });
      return true;
    }

    const chunk = head.chunks[head.sent];
    if (chunk === undefined) return false;
    if (connection.outstanding + chunk.length > FRONT_CREDIT_BYTES) return false;

    const sequence = this.deps.planes.writeData({
      connection: connection.id,
      body: { type: "DATA", payload: chunk },
    });
    if (sequence === null) return false;

    connection.unacked.push({ sequence, bytes: chunk.length });
    connection.outstanding += chunk.length;
    head.sent += 1;
    if (head.sent === head.chunks.length) {
      head.lastSequence = sequence;
      connection.pending.shift();
      connection.awaitingAck.push(head);
    }
    return true;
  }

  private settle(connection: RelayConnection, write: PendingWrite): void {
    const callback = write.callback;
    write.callback = undefined;
    if (connection.blocking === write) connection.blocking = null;
    if (callback !== undefined) callback();
  }

  /**
   * `drain`, and the two conditions that must BOTH hold.
   *
   * "AFTER `write` returns `false`, `drain` may not fire until that write has
   * settled AND capacity is available again. A `drain` raised early is worse
   * than none: it tells the one writer to send the next frame into a buffer
   * that is still full."
   */
  private maybeDrain(connection: RelayConnection): void {
    if (connection.blocking !== null) return;
    if (connection.destroyed || connection.closeRaised) return;
    if (connection.pending.length > 0) return;
    if (connection.outstanding >= FRONT_CREDIT_BYTES) return;
    connection.transport.emit("drain");
  }

  private grantCredit(connection: RelayConnection, bytes: number): void {
    const room = FRONT_CREDIT_BYTES - connection.grantedCredit;
    const grant = Math.min(bytes, room);
    if (grant <= 0) return;
    connection.grantedCredit += grant;
    this.deps.planes.writeControl({
      connection: connection.id,
      body: { type: "CREDIT", bytes: grant },
    });
  }

  private replenish(connection: RelayConnection, consumed: number): void {
    if (connection.paused || connection.destroyed) return;
    this.grantCredit(connection, consumed);
  }

  private finishClose(connection: RelayConnection): void {
    connection.pendingClose = null;
    this.connections.delete(connection.id);
    this.rotation = this.rotation.filter((id) => id !== connection.id);
    this.rotationCursor = 0;
    this.raiseClose(connection, "peer_closed");
  }

  private raiseClose(connection: RelayConnection, reason: string): void {
    if (connection.closeRaised) return;
    connection.closeRaised = true;
    connection.transport.destroyed = true;
    log.info(`[studio:front] connection closed reason=${reason}`);
    // ASYNCHRONOUS, as a socket's own `close` is. `StudioConnection.runDispose`
    // calls `destroy()` and then keeps working; raising the edge inside that
    // call would re-enter its teardown from the middle of itself.
    queueMicrotask(() => {
      connection.transport.emit("close");
    });
  }

  private live(id: number): RelayConnection | null {
    const connection = this.connections.get(id);
    if (connection === undefined || connection.destroyed) {
      // A frame naming a connection the relay has already closed is NOT a
      // fault: main and the front are two processes on two pipes, and the front
      // may well have written a `WRITE_DONE` a microsecond before main decided
      // to close. Dropped and counted, exactly as the front does with main's
      // late frames.
      this.droppedFrames += 1;
      return null;
    }
    return connection;
  }
}

/**
 * ONE logical connection, as the contract the host already speaks.
 *
 * The event registry is Node's own `EventEmitter`, which is the point rather
 * than a shortcut: the contract promises Node semantics by name - "`once`
 * detaches after the first delivery, `off` detaches by listener identity, and a
 * listener attached after an edge already fired is NOT replayed" - and
 * reimplementing them would be reimplementing the thing the consumers' latches
 * are built on.
 */
export class FrontRelayTransport
  extends EventEmitter
  implements StudioDuplexTransport
{
  private readonly relay: FrontRelay;
  private readonly id: number;

  /**
   * THE THREE LATCHES, independent by construction.
   *
   * Public fields rather than getters over private state, exactly as
   * `FakeDuplexTransport` has them: the relay is the one writer, `on`/`once`/
   * `off` come from `EventEmitter` unmodified, and a pair of accessors around a
   * boolean would add a seam with no invariant to hold.
   */
  destroyed = false;
  writableEnded = false;
  readableEnded = false;

  constructor(relay: FrontRelay, id: number) {
    super();
    this.relay = relay;
    this.id = id;
  }

  write(line: string, callback?: () => void): boolean {
    return this.relay.write(this.id, line, callback);
  }

  end(): void {
    this.relay.end(this.id);
  }

  destroy(): void {
    this.relay.destroy(this.id);
  }

  pause(): void {
    this.relay.pause(this.id);
  }

  resume(): void {
    this.relay.resume(this.id);
  }
}
