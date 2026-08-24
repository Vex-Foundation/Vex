/**
 * THE BLOCKED WRITER, PROVEN rather than assumed.
 *
 * The socket contract test drives a real peer that stops reading and then
 * asserts the OUTCOME (few progress frames arrive). That is the right test for
 * the assembly, but it cannot prove the mechanism: it never establishes that
 * `socket.write()` actually returned `false`, so a kernel buffer large enough
 * to swallow the whole burst would make it pass with no backpressure exercised
 * at all.
 *
 * This one is deterministic. The socket is a fake whose `write` returns `false`
 * until the test says otherwise, and the assertions read `pendingCount()`
 * directly: the queue is blocked, it stays bounded, progress coalesces to one
 * entry per request while blocked, and everything settles on close.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import type { Socket } from "node:net";

import {
  StudioOutboundQueue,
  STUDIO_MAX_PENDING_OUTBOUND,
} from "../mcp-host/outbound-queue.js";

/**
 * A socket whose writable side is BLOCKED on demand.
 *
 * `write` returns `false` and does NOT invoke its callback while blocked, which
 * is exactly what Node does when the high-water mark is exceeded: the caller is
 * told it is now buffering, and `drain` is the only thing that unblocks it.
 */
class BlockedSocket extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  blocked = true;
  readonly written: string[] = [];
  /** Callbacks Node has not called yet because the write is still buffered. */
  private readonly pendingCallbacks: (() => void)[] = [];
  /** How many times `write` reported "I am buffering". */
  acceptedFalseCount = 0;

  write(line: string, callback?: () => void): boolean {
    this.written.push(line);
    if (this.blocked) {
      this.acceptedFalseCount += 1;
      if (callback !== undefined) this.pendingCallbacks.push(callback);
      return false;
    }
    callback?.();
    return true;
  }

  /** Flush: run the deferred callbacks and announce `drain`. */
  unblock(): void {
    this.blocked = false;
    const callbacks = this.pendingCallbacks.splice(0, this.pendingCallbacks.length);
    for (const callback of callbacks) callback();
    this.emit("drain");
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function makeQueue(socket: BlockedSocket, options: {
  readonly maxPending?: number;
  readonly onOverflow?: (reason: string, pending: number) => void;
} = {}): StudioOutboundQueue {
  return new StudioOutboundQueue(socket as unknown as Socket, {
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    ...(options.onOverflow === undefined
      ? {}
      : { onOverflow: (reason, pending) => {
          options.onOverflow?.(reason, pending);
        } }),
  });
}

/** One event-loop turn, so the queue's own writer can run. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("the outbound queue behind a writer that returned false", () => {
  it("PROVES the write was refused and holds the rest pending", async () => {
    const socket = new BlockedSocket();
    const queue = makeQueue(socket);

    const first = queue.enqueue('{"id":1}\n');
    const second = queue.enqueue('{"id":2}\n');
    await tick();

    // THE MECHANISM: Node said "I am buffering" for the frame in flight.
    expect(socket.acceptedFalseCount).toBe(1);
    expect(socket.written).toHaveLength(1);
    // The writer is parked on `drain`, so frame two is still queued and no
    // second `write` has been issued behind the first one's bytes.
    expect(queue.pendingCount()).toBe(1);

    socket.unblock();
    await first;
    await second;
    expect(socket.written).toHaveLength(2);
    expect(queue.pendingCount()).toBe(0);
  });

  it("keeps progress for one request at ONE queued entry while blocked", async () => {
    const socket = new BlockedSocket();
    const queue = makeQueue(socket);

    // The first frame is taken by the writer immediately and blocks there.
    void queue.enqueue('{"id":1}\n');
    await tick();
    expect(queue.pendingCount()).toBe(0);

    for (let index = 0; index < 500; index += 1) {
      void queue.enqueue(`{"progress":${String(index)}}\n`, "progress:PT1");
    }
    await tick();

    // CONSTANT under a stalled peer: 500 ticks, one queued entry, and the entry
    // carries the NEWEST value rather than the oldest.
    expect(queue.pendingCount()).toBe(1);
    expect(socket.acceptedFalseCount).toBe(1);

    socket.unblock();
    await tick();
    await tick();
    expect(socket.written).toHaveLength(2);
    expect(socket.written[1]).toBe('{"progress":499}\n');
  });

  it("fails the connection when RESPONSES alone reach the pending bound", async () => {
    const socket = new BlockedSocket();
    const overflows: { reason: string; pending: number }[] = [];
    const queue = makeQueue(socket, {
      onOverflow: (reason, pending) => {
        overflows.push({ reason, pending });
      },
    });

    // One is taken by the blocked writer; the bound applies to the rest.
    for (let index = 0; index < STUDIO_MAX_PENDING_OUTBOUND + 8; index += 1) {
      void queue.enqueue(`{"id":${String(index)}}\n`);
    }
    await tick();

    expect(queue.pendingCount()).toBe(STUDIO_MAX_PENDING_OUTBOUND);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]?.reason).toBe("pending_limit");
  });

  it("drops progress at the bound but never a response", async () => {
    const socket = new BlockedSocket();
    let overflowCount = 0;
    const queue = makeQueue(socket, {
      maxPending: 4,
      onOverflow: () => {
        overflowCount += 1;
      },
    });

    void queue.enqueue('{"id":0}\n');
    await tick();
    for (let index = 1; index <= 4; index += 1) {
      void queue.enqueue(`{"id":${String(index)}}\n`);
    }
    expect(queue.pendingCount()).toBe(4);

    // At the bound, a DIFFERENT progress key cannot join the queue - and that
    // costs the connection nothing, because progress is expendable.
    void queue.enqueue('{"progress":1}\n', "progress:PT9");
    expect(queue.pendingCount()).toBe(4);
    expect(overflowCount).toBe(0);
  });

  it("settles every outstanding frame on close rather than rejecting", async () => {
    const socket = new BlockedSocket();
    const queue = makeQueue(socket);

    const inFlight = queue.enqueue('{"id":1}\n');
    const queued = queue.enqueue('{"id":2}\n');
    await tick();
    expect(queue.pendingCount()).toBe(1);

    queue.close();
    // The queued one settles at once; the in-flight one settles when the socket
    // announces its close, which is the connection teardown it is waiting on.
    await queued;
    socket.destroy();
    await inFlight;
    expect(queue.pendingCount()).toBe(0);

    // Admission is closed: a frame produced by a teardown handler resolves and
    // never joins a queue nobody will drain.
    await queue.enqueue('{"id":3}\n');
    expect(queue.pendingCount()).toBe(0);
  });
});
