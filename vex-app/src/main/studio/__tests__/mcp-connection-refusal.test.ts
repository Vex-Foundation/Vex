/**
 * THE REFUSAL LATCH: a refused connection stops being a handshake candidate in
 * the SAME TICK the refusal is decided.
 *
 * The defect this pins. `refuse()` writes an ack and then tears down, and both
 * are awaits. Before the latch, the phase was still `handshaking` across them,
 * the `data` listener was still attached and the socket was still flowing - so
 * a handshake line that arrived while the refusal ack was in flight was parsed
 * normally, CLAIMED an established-connection reservation, and enqueued a
 * SUCCESS ack behind the refusal. The peer was told both no and yes, and a
 * connection the host had refused was holding one of the sixteen slots.
 *
 * Two arrival windows, both real:
 *
 *   (a) while the CAP refusal's write is in flight - the host refuses at accept
 *       time, and the peer's handshake is already on its way;
 *   (b) after the handshake DEADLINE fired - the peer was slow, then wrote.
 *
 * The socket here is a fake whose writable side is held open deliberately, so
 * the window is genuinely open rather than closed by a fast test double.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDuplexTransport } from "@vex-agent/mcp/duplex-transport-fake.js";
import type { StudioConnectionHandle } from "@vex-agent/mcp/server.js";

import {
  StudioConnection,
  type ConnectionSlotOutcome,
  type StudioConnectionDeps,
} from "../mcp-host/connection.js";
import {
  atCapacityRefusal,
  STUDIO_HANDSHAKE_DEADLINE_MS,
} from "../mcp-host/handshake.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/**
 * A wire whose writes are accepted and never completed, until released.
 *
 * The shared fake in its `hold` policy. `flushWrites()` lets every held write
 * complete in order; `acceptDeferred()` flips it to an ordinary well-behaved
 * wire, for the cases where the held writable side is not the subject.
 */
function heldWire(): FakeDuplexTransport {
  return new FakeDuplexTransport("hold");
}

interface Harness {
  readonly connection: StudioConnection;
  readonly socket: FakeDuplexTransport;
  readonly reservations: () => number;
  readonly served: () => number;
  readonly acks: () => readonly string[];
}

interface HarnessOptions {
  /** The handle `serveConnection` returns. Injected to hold the instance close. */
  readonly serveHandle?: StudioConnectionHandle;
}

function harness(options: HarnessOptions = {}): Harness {
  const socket = heldWire();
  let reservations = 0;
  let served = 0;
  const deps: StudioConnectionDeps = {
    runCall: async () => ({ kind: "completed", result: { success: true, output: "ok" } }),
    acquireCallSlot: () => ({ ok: true, release: (): void => undefined }),
    reserveConnectionSlot: (): ConnectionSlotOutcome => {
      reservations += 1;
      return { ok: true, release: (): void => undefined };
    },
    isStale: () => false,
    checkProject: async () => null,
    serveConnection: (): StudioConnectionHandle => {
      served += 1;
      return options.serveHandle ?? { close: async (): Promise<void> => undefined };
    },
    onClosed: (): void => undefined,
  };
  const connection = new StudioConnection("c-test", socket, deps);
  return {
    connection,
    socket,
    reservations: () => reservations,
    served: () => served,
    acks: () => socket.written,
  };
}

function handshakeLine(): Buffer {
  return Buffer.from(`${JSON.stringify({ v: 1, projectId: PROJECT_ID })}\n`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a handshake that arrives while a cap refusal is in flight", () => {
  it("reserves NO slot and enqueues NO success ack", async () => {
    const test = harness();

    // The host refuses at accept time. The write is held, so the refusal is
    // genuinely mid-flight for the rest of this test.
    const refusing = test.connection.refuse(
      atCapacityRefusal(4, "connections waiting to handshake"),
    );

    // THE SYNCHRONOUS HALF, asserted in the tick the refusal was decided.
    expect(test.connection.isHandshaking()).toBe(false);
    expect(test.socket.hasDataListener()).toBe(false);
    expect(test.socket.paused).toBe(true);

    // The peer's handshake was already on the wire. Even if something re-emits
    // it, nothing may parse it into a reservation.
    test.socket.deliver(handshakeLine());
    await Promise.resolve();

    expect(test.reservations()).toBe(0);
    expect(test.served()).toBe(0);

    test.socket.flushWrites();
    await refusing;

    // EXACTLY ONE ack, and it is the refusal. A success ack behind it would be
    // the connection being told both no and yes.
    const acks = test.acks();
    expect(acks).toHaveLength(1);
    const decoded = JSON.parse(acks[0] ?? "{}") as Record<string, unknown>;
    expect(decoded["ok"]).toBe(false);
    expect(decoded["code"]).toBe("at_capacity");
    expect(test.socket.destroyed).toBe(true);
  });

  it("ignores a second refusal rather than writing a second ack", async () => {
    const test = harness();
    const first = test.connection.refuse(atCapacityRefusal(16, "MCP connections"));
    await test.connection.refuse(atCapacityRefusal(4, "connections waiting to handshake"));
    test.socket.flushWrites();
    await first;
    expect(test.acks()).toHaveLength(1);
  });
});

describe("a handshake that arrives after the deadline fired", () => {
  it("reserves NO slot and never reaches serving", async () => {
    vi.useFakeTimers();
    const test = harness();

    // The peer said nothing for the whole deadline. The timer refuses.
    vi.advanceTimersByTime(STUDIO_HANDSHAKE_DEADLINE_MS + 1);

    expect(test.connection.isHandshaking()).toBe(false);
    expect(test.socket.hasDataListener()).toBe(false);
    expect(test.socket.paused).toBe(true);

    // ... and then it wrote. Late is late.
    test.socket.deliver(handshakeLine());
    await Promise.resolve();

    expect(test.reservations()).toBe(0);
    expect(test.served()).toBe(0);
    expect(test.connection.isServing()).toBe(false);

    const acks = test.acks();
    expect(acks).toHaveLength(1);
    const decoded = JSON.parse(acks[0] ?? "{}") as Record<string, unknown>;
    expect(decoded["ok"]).toBe(false);
    expect(decoded["code"]).toBe("malformed");
  });
});

describe("dispose", () => {
  it("hands every concurrent caller the SAME teardown, not an early resolve", async () => {
    // The asynchronous half of a teardown is the pinned instance's close. A
    // second caller used to get its own resolved promise while that close was
    // still in flight, so "await dispose" did not mean "the connection is torn
    // down" for anybody but the first caller.
    let closeCalls = 0;
    let finished = false;
    let releaseClose: () => void = () => undefined;
    const heldClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const test = harness({
      serveHandle: {
        close: async (): Promise<void> => {
          closeCalls += 1;
          await heldClose;
        },
      },
    });

    test.socket.acceptDeferred();
    test.socket.deliver(handshakeLine());
    await waitFor(() => test.connection.isServing());

    const first = test.connection.dispose("lock");
    const second = test.connection.dispose("vex_quit");
    expect(second).toBe(first);
    void first.then(() => {
      finished = true;
    });

    // Both callers are still waiting: the instance close has not returned.
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(closeCalls).toBe(1);

    releaseClose();
    await Promise.all([first, second]);
    expect(finished).toBe(true);
    // ONE teardown, not two: the second caller joined rather than re-running it.
    expect(closeCalls).toBe(1);
    expect(test.socket.destroyed).toBe(true);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5);
      timer.unref?.();
    });
  }
}
