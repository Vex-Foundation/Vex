/**
 * WHAT THE `first response` LINE AND THE OUTBOUND COUNTERS ARE ALLOWED TO CLAIM.
 *
 * The milestone exists to answer one question from the 2026-09-04 incident log:
 * did main's answer leave main. The transport publishes it when its writer
 * reports acceptance - and in production the writer is `StudioOutboundQueue`,
 * which RESOLVES for five different reasons on purpose (a closed queue, a
 * coalesced progress frame, a frame refused at the pending bound, a wire that
 * went away, and a completed write), so that an ordinary disconnect is not an
 * unhandled rejection in the SDK's write path. Reading that resolution as
 * acceptance made four of those five a false witness.
 *
 * So this suite is deliberately PRODUCTION-CONNECTED: a real `StudioConnection`
 * builds the real outbound queue, and the injected serve step builds a real
 * `StudioSocketTransport` over the SAME wire with the connection's own
 * `writeLine`, exactly as `serve.ts` does. Only the MCP SDK is absent, which is
 * the one piece that decides nothing here. `mcp-connection-lifecycle-log.test.ts`
 * remains the suite for the log's wording; this one is about which frames may
 * reach it at all.
 */

import { describe, expect, it, vi } from "vitest";

import { FakeDuplexTransport } from "@vex-agent/mcp/duplex-transport-fake.js";
import type { StudioConnectionHandle } from "@vex-agent/mcp/server.js";
import {
  StudioSocketTransport,
  type SocketTransportLifecycleEvent,
} from "@vex-agent/mcp/socket-transport.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { StudioConnection } = await import("../mcp-host/connection.js");
const { STUDIO_MAX_PENDING_OUTBOUND } = await import("../mcp-host/outbound-queue.js");

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/**
 * The transport's shutdown deadline, shortened for the double.
 *
 * The real one is five seconds of flush time for a peer that is still reading.
 * This wire never raises `close` from `end()` (nothing is listening on the
 * other side of a fake), so the deadline is the edge that finishes every
 * teardown here and it may not be the thing the suite spends its time on.
 */
const TEST_SHUTDOWN_MS = 20;

/**
 * The shared fake, with the block edge these cases need MID-CONNECTION.
 *
 * The handshake ack goes through the same outbound queue, so a wire that
 * refuses from birth never reaches `serving` at all. These scenarios all start
 * from an established connection and block the wire afterwards, exactly as a
 * peer that stops reading does, so the block is a state this double can enter
 * rather than one it is constructed in. `hold` semantics are the base fake's:
 * `write` answers `false` and the completion callback is kept until a release.
 */
class BlockableWire extends FakeDuplexTransport {
  private blocked = false;
  private readonly held: ((error?: Error | null) => void)[] = [];

  /** From here on the wire buffers and nothing completes until `release`. */
  block(): void {
    this.blocked = true;
  }

  override write(line: string, callback?: (error?: Error | null) => void): boolean {
    if (!this.blocked) return super.write(line, callback);
    this.written.push(line);
    this.refusedWrites += 1;
    if (callback !== undefined) this.held.push(callback);
    return false;
  }

  /** Complete every held write, announce `drain`, and accept again. */
  override unblock(): void {
    this.blocked = false;
    const callbacks = this.held.splice(0, this.held.length);
    for (const callback of callbacks) callback();
    this.emit("drain");
  }
}

interface Harness {
  readonly connection: InstanceType<typeof StudioConnection>;
  readonly wire: BlockableWire;
  /** The REAL transport the serve step built, once the handshake is through. */
  readonly transport: () => StudioSocketTransport;
  readonly events: readonly SocketTransportLifecycleEvent[];
  /** Let a held entry close finish. Only meaningful with `holdEntryClose`. */
  readonly releaseEntryClose: () => void;
}

/**
 * A connection whose serve step is the real transport over the real queue.
 *
 * `holdEntryClose` parks the served entry's `close()`, which is the window a
 * teardown actually has: `dispose` closes the outbound queue BEFORE it awaits
 * that close, so a response produced inside the window meets a closed queue
 * with the wire still alive. That is the reviewer's scenario, reproduced rather
 * than simulated.
 */
function harness(options: { readonly holdEntryClose?: boolean } = {}): Harness {
  const wire = new BlockableWire("accept_deferred");
  const events: SocketTransportLifecycleEvent[] = [];
  let transport: StudioSocketTransport | null = null;
  let releaseEntryClose: (() => void) | null = null;
  const connection = new StudioConnection("c-outbound", wire, {
    runCall: async () => ({ kind: "completed", result: { success: true, output: "ok" } }),
    acquireCallSlot: () => ({ ok: true, release: (): void => undefined }),
    reserveConnectionSlot: () => ({ ok: true, release: (): void => undefined }),
    isStale: (): boolean => false,
    checkProject: async () => null,
    serveConnection: (input): StudioConnectionHandle => {
      const built = new StudioSocketTransport(input.wire, {
        remainder: input.remainder,
        shutdownDeadlineMs: TEST_SHUTDOWN_MS,
        writeLine: input.writeLine,
        onLifecycle: (event) => {
          events.push(event);
          input.onWireLifecycle(event);
        },
      });
      transport = built;
      void built.start();
      if (options.holdEntryClose !== true) {
        return { close: (): Promise<void> => built.close() };
      }
      return {
        close: (): Promise<void> =>
          new Promise<void>((resolve) => {
            releaseEntryClose = (): void => {
              void built.close().then(resolve);
            };
          }),
      };
    },
    onClosed: (): void => undefined,
    transportKind: "socket",
    droppedFrames: null,
  });
  return {
    connection,
    wire,
    transport: () => {
      if (transport === null) throw new Error("the connection never served");
      return transport;
    },
    events,
    releaseEntryClose: () => {
      if (releaseEntryClose === null) throw new Error("no entry close is held");
      releaseEntryClose();
    },
  };
}

function handshakeLine(): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);
}

/** One event-loop turn, so the queue's own writer can run. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Let `establish` finish, ack and all.
 *
 * The handshake ack goes through the outbound queue and its write completes on
 * a macrotask, so microtask turns alone never reach `serving`.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await tick();
    await Promise.resolve();
  }
}

function response(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { ok: true } };
}

function progress(token: string, value: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: token, progress: value },
  };
}

function firstResponses(test: Harness): readonly SocketTransportLifecycleEvent[] {
  return test.events.filter((event) => event.kind === "first_response");
}

/** The transport's own final counters, from the `closed` event it reports. */
function closedCounters(test: Harness): {
  readonly responses: number;
  readonly notifications: number;
} {
  const closed = test.events.find((event) => event.kind === "closed");
  if (closed === undefined || closed.kind !== "closed") {
    throw new Error("the transport never reported its close");
  }
  return { responses: closed.responses, notifications: closed.notifications };
}

describe("a response handed to an outbound queue that is already closed", () => {
  it("is neither the first response nor a counted answer", async () => {
    const test = harness({ holdEntryClose: true });
    test.wire.deliver(handshakeLine());
    await settle();
    test.wire.block();

    // The teardown is UNDER WAY and parked exactly where production parks it:
    // the queue is closed, the wire is not destroyed yet.
    const disposed = test.connection.dispose("disconnect");
    await settle();
    expect(test.wire.destroyed).toBe(false);

    // The SDK answers a call that was already in flight. The frame never
    // reaches the peer - the queue that owns the wire is not admitting - and
    // the queue resolves anyway, which is what used to look like acceptance.
    await test.transport().send(response(0));

    expect(firstResponses(test)).toHaveLength(0);
    test.releaseEntryClose();
    await disposed;
    expect(closedCounters(test).responses).toBe(0);
  });
});

describe("frames the outbound queue refuses at its pending bound", () => {
  it("are not counted and do not publish the milestone", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();
    test.wire.block();

    // The wire is blocked, so the writer parks on the first frame and the rest
    // queue behind it. Past the bound the queue refuses - and RESOLVES.
    const overflow = STUDIO_MAX_PENDING_OUTBOUND + 3;
    const sends: Promise<void>[] = [];
    for (let index = 0; index < overflow; index += 1) {
      sends.push(test.transport().send(response(index)));
    }
    await tick();
    await tick();

    // The premise, asserted rather than assumed: the wire refused, and the
    // frames past the bound have already settled while NOTHING was accepted.
    expect(test.wire.refusedWrites).toBe(1);
    await Promise.all(sends.slice(STUDIO_MAX_PENDING_OUTBOUND + 1));
    expect(firstResponses(test)).toHaveLength(0);

    await test.connection.dispose("disconnect");
    expect(closedCounters(test).responses).toBe(0);
  });
});

describe("a progress frame that coalesced into a queued one", () => {
  it("is not a second accepted notification", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();
    test.wire.block();

    // One frame is taken by the blocked writer, one queues behind it, and the
    // third REPLACES the queued one: two lines will ever reach the wire.
    void test.transport().send(progress("PT1", 1));
    await tick();
    void test.transport().send(progress("PT1", 2));
    await test.transport().send(progress("PT1", 3));

    // The coalesced frame settled at once, with nothing on the wire yet.
    expect(firstResponses(test)).toHaveLength(0);

    test.wire.unblock();
    await tick();
    await tick();
    await test.connection.dispose("disconnect");

    const wrote = test.wire.written.filter((line) => line.includes("notifications/progress"));
    expect(wrote).toHaveLength(2);
    expect(wrote[1]).toContain("\"progress\":3");
    // Two lines left main, so two notifications are counted - not the three
    // frames the SDK handed over.
    expect(closedCounters(test).notifications).toBe(2);
    expect(firstResponses(test)).toHaveLength(1);
  });
});

describe("a frame still in flight when the wire goes away", () => {
  it("is never reported as an answer that left main", async () => {
    const test = harness();
    test.wire.deliver(handshakeLine());
    await settle();
    test.wire.block();

    // Blocked in the queue's own `writeLine`, parked on a `drain` that will
    // never come, which is where a response sits when a peer stops reading.
    const sent = test.transport().send(response(0));
    await tick();
    expect(test.wire.refusedWrites).toBe(1);

    // The wire is gone. The write settles - it must, or the SDK's write path
    // and the teardown behind it would hang - but the bytes are still in main.
    test.wire.destroy();
    await sent;

    expect(firstResponses(test)).toHaveLength(0);
    await test.connection.dispose("disconnect");
    expect(closedCounters(test).responses).toBe(0);
  });
});
