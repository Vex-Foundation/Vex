/**
 * The OUTBOUND SEND OWNER for one Vex Studio connection.
 *
 * `wire.write` returning `false` is not backpressure, it is a notification
 * that Node has started buffering for you - without a bound. A blocked reader
 * plus approval progress every two seconds is an hour of notifications in
 * memory, so this module owns a real queue instead: one serialized writer, a
 * finite pending count, and a coalescing rule that keeps the queue size
 * CONSTANT under a stalled peer.
 *
 * ## Two classes of frame, two policies
 *
 *   RESPONSE - a JSON-RPC result or error. NEVER dropped, never coalesced,
 *   never cut. It is the answer to a call somebody is blocked on, and it waits
 *   its turn. If the pending count is exceeded by responses alone the
 *   connection is failed, because a peer that will not read its own answers is
 *   not a peer any more.
 *
 *   PROGRESS - a `notifications/progress` frame keyed by its request. AT MOST
 *   ONE per request may be queued: a newer one REPLACES the queued one rather
 *   than joining it, because the value of progress is "still waiting", and the
 *   third copy of that says nothing the first did not. Replacement only ever
 *   touches an entry that is still in the queue; the entry the writer has
 *   already taken is never mutated, so a coalesce can never overlap a blocked
 *   send.
 *
 * ## Everything settles on close, and SAYS SO
 *
 * Each enqueue returns a promise. On close every outstanding one RESOLVES
 * rather than rejecting: the frame did not reach the peer, and the caller
 * (which is the SDK's write path) has nothing useful to do about it, while a
 * rejection would surface as an unhandled error during a normal disconnect.
 * The connection's own teardown is the event that matters, and it has already
 * fired by then.
 *
 * But resolution is NOT acceptance, and this queue resolves on five different
 * edges: a closed queue, a coalesce, the pending bound, a wire that has gone
 * away, and a real completed write. The promise therefore carries a
 * `StudioWriteOutcome` naming which one it took. The transport above turns
 * `accepted` - and only `accepted` - into the `first_response` milestone and
 * the outbound counters, so a frame this queue swallowed can never be logged
 * as main's answer leaving main.
 */

import type {
  StudioDuplexTransport,
  StudioWriteOutcome,
} from "@vex-agent/mcp/duplex-transport.js";

/** The contract's pending-frame bound for one connection. */
export const STUDIO_MAX_PENDING_OUTBOUND = 64;

export type OutboundOverflowReason = "pending_limit";

export interface OutboundQueueOptions {
  readonly maxPending?: number;
  /**
   * Called ONCE when the pending bound is exceeded. The owner closes the
   * connection; this module does not decide that.
   */
  readonly onOverflow?: (reason: OutboundOverflowReason, pending: number) => void;
}

interface OutboundEntry {
  readonly kind: "response" | "progress";
  /** Present for progress only: the request this frame reports on. */
  readonly key: string | null;
  line: string;
  readonly settle: (outcome: StudioWriteOutcome) => void;
}

export class StudioOutboundQueue {
  private readonly wire: StudioDuplexTransport;
  private readonly maxPending: number;
  private readonly onOverflow: OutboundQueueOptions["onOverflow"];

  private readonly queue: OutboundEntry[] = [];
  /** Queued-and-not-yet-taken progress entries, by request key. */
  private readonly queuedProgress = new Map<string, OutboundEntry>();
  private writing = false;
  private closed = false;
  private overflowed = false;

  constructor(wire: StudioDuplexTransport, options: OutboundQueueOptions = {}) {
    this.wire = wire;
    this.maxPending = options.maxPending ?? STUDIO_MAX_PENDING_OUTBOUND;
    this.onOverflow = options.onOverflow;
  }

  /** Frames waiting for the writer. The stress test asserts this stays flat. */
  pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Queue one frame.
   *
   * `progressKey` marks the frame as coalescable progress for that request.
   * Anything without a key is a response and is queued unconditionally.
   */
  enqueue(line: string, progressKey?: string): Promise<StudioWriteOutcome> {
    if (this.closed) return Promise.resolve("closed");

    if (progressKey !== undefined) {
      const queued = this.queuedProgress.get(progressKey);
      if (queued !== undefined) {
        // COALESCE: replace the line of an entry the writer has not taken.
        queued.line = line;
        return Promise.resolve("coalesced");
      }
    }

    if (this.queue.length >= this.maxPending) {
      // Progress is expendable at the bound; a response is not, and a peer
      // that has stopped reading its own answers has failed.
      if (progressKey !== undefined) return Promise.resolve("dropped");
      if (!this.overflowed) {
        this.overflowed = true;
        this.onOverflow?.("pending_limit", this.queue.length);
      }
      return Promise.resolve("dropped");
    }

    return new Promise<StudioWriteOutcome>((resolve) => {
      const entry: OutboundEntry = {
        kind: progressKey === undefined ? "response" : "progress",
        key: progressKey ?? null,
        line,
        settle: resolve,
      };
      this.queue.push(entry);
      if (progressKey !== undefined) this.queuedProgress.set(progressKey, entry);
      void this.pump();
    });
  }

  /**
   * Stop admitting, settle everything outstanding.
   *
   * Admission closes FIRST so a frame produced by a teardown handler cannot
   * join a queue nobody will drain.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const outstanding = this.queue.splice(0, this.queue.length);
    this.queuedProgress.clear();
    for (const entry of outstanding) entry.settle("closed");
  }

  /** The ONE writer. Serialized by `writing`; re-entered only by itself. */
  private async pump(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      for (;;) {
        const entry = this.queue.shift();
        if (entry === undefined) return;
        // Taken from the queue: from here it is immutable, so a concurrent
        // coalesce cannot rewrite a frame that is already on the wire.
        if (entry.key !== null) this.queuedProgress.delete(entry.key);
        if (this.closed || this.wire.destroyed || this.wire.writableEnded) {
          entry.settle("closed");
          continue;
        }
        entry.settle(await this.writeLine(entry.line));
      }
    } finally {
      this.writing = false;
      // A frame enqueued while the last write was in flight would otherwise
      // sit until the next enqueue; re-arm rather than rely on the caller.
      if (!this.closed && this.queue.length > 0) void this.pump();
    }
  }

  /**
   * Write, and wait for `drain` when the wire says it is buffering.
   *
   * The write callback is handled for BOTH dispatch orders. Node always defers
   * it, but the accepted flag was previously a `const` closed over by that
   * callback, so a callback invoked synchronously reached it in its temporal
   * dead zone and threw a `ReferenceError` out of the one writer - leaving the
   * queue's `writing` latch stuck and the connection silently mute. It is now
   * a hoisted binding plus a post-write settle, so neither order can strand a
   * frame or throw.
   *
   * THE OUTCOME IS THE POINT. `close` and `error` settle this promise so a
   * teardown can never strand the one writer, and a `drain` after a refused
   * write means the buffer actually emptied - but only the completed write and
   * that drain are `accepted`. Everything else is `closed`: the frame is still
   * in this process, or gone with the wire.
   */
  private writeLine(line: string): Promise<StudioWriteOutcome> {
    return new Promise<StudioWriteOutcome>((resolve) => {
      let settled = false;
      let accepted = false;
      const done = (outcome: StudioWriteOutcome): void => {
        if (settled) return;
        settled = true;
        this.wire.off("close", gone);
        this.wire.off("error", gone);
        this.wire.off("drain", drained);
        resolve(outcome);
      };
      const gone = (): void => {
        done("closed");
      };
      const drained = (): void => {
        done("accepted");
      };
      this.wire.once("close", gone);
      this.wire.once("error", gone);
      let callbackFired = false;
      let writeFailed = false;
      let returned = false;
      const completed = (): void => {
        done(writeFailed ? "closed" : "accepted");
      };
      accepted = this.wire.write(line, (error) => {
        callbackFired = true;
        // `net.Socket` reports a failed write through this argument, and the
        // `error` event that follows it is not guaranteed to arrive first. A
        // frame the socket threw away is not the peer's, whether the write was
        // accepted or refused.
        if (error !== undefined && error !== null) writeFailed = true;
        // A callback invoked SYNCHRONOUSLY runs before `write` has returned, so
        // `accepted` is not known yet; the post-write branch settles that case.
        if (returned) completed();
      });
      returned = true;
      // The callback is the authoritative edge on both branches: Node runs it
      // when the chunk is actually flushed, which is the same fact `drain`
      // reports and arrives no later.
      if (callbackFired) {
        completed();
        return;
      }
      if (accepted) return;
      // Refused, with no callback yet. A wire that is already gone will never
      // raise `drain`, and the Windows relay refuses exactly that way without
      // ever running the callback, so the frame is named lost here rather than
      // parked for ever.
      if (this.wire.destroyed || this.wire.writableEnded) {
        done("closed");
        return;
      }
      // `drain` is the edge that says the buffer emptied without the callback.
      this.wire.once("drain", drained);
    });
  }
}
