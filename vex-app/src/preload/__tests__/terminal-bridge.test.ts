/**
 * THE PRELOAD BOUNDARY for terminals.
 *
 * Four properties, all of which fail silently if they break:
 *
 *  - SUBSCRIPTION IDENTITY. At most one callback per (terminal, event type),
 *    and a stale cleanup must not remove the subscription that replaced it -
 *    the React strict-mode double-effect bug, which manifests as a terminal
 *    that renders once and then goes quiet.
 *  - ACK ACCOUNTING. Preload is what un-pauses a flow-controlled pty. If it
 *    stops acking, a busy terminal simply freezes.
 *  - OFF-CONTRACT PACKETS ARE DROPPED. This is the last gate before renderer
 *    state.
 *  - CHUNKING, NOT TRUNCATION. A large paste is sent whole, in packets that
 *    fit the bound, and stops at the first refusal rather than half-delivering.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcListeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>();
const invocations: Array<{ channel: string; payload: unknown }> = [];
let invokeReply: (channel: string) => unknown = () => ({ ok: true, data: { ok: true, value: null } });

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      const existing = ipcListeners.get(channel) ?? [];
      existing.push(handler);
      ipcListeners.set(channel, existing);
    },
    removeListener: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      ipcListeners.set(
        channel,
        (ipcListeners.get(channel) ?? []).filter((item) => item !== handler),
      );
    },
    invoke: (channel: string, envelope: unknown) => {
      invocations.push({
        channel,
        payload: (envelope as { payload: unknown }).payload,
      });
      return Promise.resolve(invokeReply(channel));
    },
  },
}));

const { EV } = await import("../../shared/ipc/channels.js");
const {
  TERMINAL_ACK_CHARS,
  TERMINAL_WRITE_MAX_BYTES,
} = await import("../../shared/schemas/terminal.js");
const { terminal, __resetTerminalBridgeForTests } = await import("../shell/terminal.js");

/** A `MessagePort` stand-in: records outbound packets, injects inbound ones. */
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];
  started = false;
  closed = false;

  postMessage(value: unknown): void {
    this.sent.push(value);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const NONCE = "n".repeat(32);

/**
 * Let the acquisition's own promise chain settle before main posts the port.
 *
 * The bridge awaits an `invoke` and only THEN registers the nonce it is waiting
 * for, so a port delivered in the same microtask would find no waiter and be
 * closed as a stray. Draining the queue is deterministic; a timeout would not be.
 */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
}

function postPort(port: FakePort, nonce = NONCE): void {
  for (const handler of ipcListeners.get(EV.terminal.port) ?? []) {
    handler({ ports: [port] }, { nonce });
  }
}

/** Drive the acquisition handshake the way main does. */
async function acquire(): Promise<FakePort> {
  const port = new FakePort();
  invokeReply = (channel) =>
    channel.endsWith("acquirePort")
      ? { ok: true, data: { ok: true, value: { nonce: NONCE } } }
      : { ok: true, data: { ok: true, value: null } };

  const attaching = terminal.attach({ terminalId: "t1" });
  await flushMicrotasks();
  postPort(port);
  await attaching;
  return port;
}

beforeEach(() => {
  // `ipcListeners` is deliberately NOT cleared: the bridge installs its port
  // transfer listener at MODULE LOAD, before any acquisition can be requested,
  // and clearing the map here would delete the very listener under test.
  invocations.length = 0;
  __resetTerminalBridgeForTests();
  invokeReply = () => ({ ok: true, data: { ok: true, value: null } });
});

describe("port acquisition", () => {
  it("claims the port, starts it, and CONFIRMS the nonce", async () => {
    const port = await acquire();

    expect(port.started).toBe(true);
    expect(port.sent).toEqual([{ kind: "attach", terminalId: "t1" }]);
    // The confirmation is what stops main's expiry timer; without it the port
    // it just handed over would be torn down ten seconds later.
    expect(
      invocations.some(
        (call) =>
          call.channel.endsWith("confirmPort")
          && (call.payload as { nonce: string }).nonce === NONCE,
      ),
    ).toBe(true);
  });

  it("CLOSES a port that arrives with a nonce nobody is waiting for", () => {
    // Module load installed the listener, so this runs with no acquisition in
    // flight. An unclaimed port is a live conduit into the pty host.
    const stray = new FakePort();
    postPort(stray, "unexpected".padEnd(32, "x"));
    expect(stray.closed).toBe(true);
  });

  it("acquires ONE port for concurrent attaches", async () => {
    const port = new FakePort();
    invokeReply = (channel) =>
      channel.endsWith("acquirePort")
        ? { ok: true, data: { ok: true, value: { nonce: NONCE } } }
        : { ok: true, data: { ok: true, value: null } };

    const both = Promise.all([
      terminal.attach({ terminalId: "t1" }),
      terminal.attach({ terminalId: "t2" }),
    ]);
    await flushMicrotasks();
    postPort(port);
    await both;

    // Eight terminals mounting in one tick must not produce eight ports.
    expect(
      invocations.filter((call) => call.channel.endsWith("acquirePort")),
    ).toHaveLength(1);
  });

  it("reports port_unavailable rather than throwing when main refuses", async () => {
    invokeReply = () => ({ ok: true, data: { ok: false, code: "host_unavailable" } });
    const outcome = await terminal.attach({ terminalId: "t1" });
    expect(outcome).toEqual({ ok: true, data: { ok: false, code: "port_unavailable" } });
  });
});

describe("subscriptions", () => {
  it("REPLACES a duplicate subscription and returns a cleanup that only removes ITS OWN", async () => {
    const port = await acquire();
    const first = vi.fn();
    const second = vi.fn();

    const offFirst = terminal.onData("t1", first);
    const offSecond = terminal.onData("t1", second);

    // The stale cleanup runs AFTER the replacement, exactly as React's
    // double-effect does. It must not remove the live subscription.
    offFirst();

    port.receive({ kind: "data", terminalId: "t1", data: "hello" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("hello");

    offSecond();
    port.receive({ kind: "data", terminalId: "t1", data: "again" });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("returns an IDEMPOTENT cleanup", async () => {
    const port = await acquire();
    const cb = vi.fn();
    const off = terminal.onData("t1", cb);
    off();
    off();

    port.receive({ kind: "data", terminalId: "t1", data: "x" });
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps subscriptions for different terminals and kinds independent", async () => {
    const port = await acquire();
    const dataOne = vi.fn();
    const dataTwo = vi.fn();
    const exitOne = vi.fn();
    terminal.onData("t1", dataOne);
    terminal.onData("t2", dataTwo);
    terminal.onExit("t1", exitOne);

    port.receive({ kind: "data", terminalId: "t1", data: "a" });
    port.receive({ kind: "exit", terminalId: "t1", exitCode: 0, signal: null });

    expect(dataOne).toHaveBeenCalledWith("a");
    expect(dataTwo).not.toHaveBeenCalled();
    expect(exitOne).toHaveBeenCalledWith({ exitCode: 0, signal: null });
  });

  it("delivers a replay as a RESYNC followed by data, carrying the dropped-row count", async () => {
    const port = await acquire();
    const resync = vi.fn();
    const data = vi.fn();
    terminal.onResync("t1", resync);
    terminal.onData("t1", data);

    port.receive({
      kind: "replay",
      terminalId: "t1",
      data: "restored screen",
      last: true,
      droppedRows: 1204,
    });

    expect(resync).toHaveBeenCalledWith({ reason: "replay", droppedRows: 1204 });
    expect(data).toHaveBeenCalledWith("restored screen");
  });
});

describe("validation", () => {
  it.each([
    ["an unknown kind", { kind: "exec", terminalId: "t1", command: "rm -rf /" }],
    ["an extra key", { kind: "data", terminalId: "t1", data: "x", cwd: "/etc" }],
    ["a missing field", { kind: "data", terminalId: "t1" }],
    ["a non-object", "data"],
    ["null", null],
  ])("DROPS %s before it reaches a renderer callback", async (_label, payload) => {
    const port = await acquire();
    const cb = vi.fn();
    terminal.onData("t1", cb);

    port.receive(payload);

    expect(cb).not.toHaveBeenCalled();
  });
});

describe("flow-control acknowledgements", () => {
  it("sends ONE ack per TERMINAL_ACK_CHARS consumed, and none before", async () => {
    const port = await acquire();
    terminal.onData("t1", () => {});
    port.sent.length = 0;

    port.receive({
      kind: "data",
      terminalId: "t1",
      data: "x".repeat(TERMINAL_ACK_CHARS - 1),
    });
    expect(port.sent).toEqual([]);

    port.receive({ kind: "data", terminalId: "t1", data: "x" });

    // Without this the pty pauses at the high watermark and never resumes.
    expect(port.sent).toEqual([
      { kind: "ack", terminalId: "t1", charCount: TERMINAL_ACK_CHARS },
    ]);
  });

  it("acknowledges even when the renderer never subscribed", async () => {
    const port = await acquire();
    port.sent.length = 0;

    port.receive({ kind: "data", terminalId: "t1", data: "y".repeat(TERMINAL_ACK_CHARS) });

    // A component that forgot to subscribe must not be able to wedge a shell.
    expect(port.sent).toHaveLength(1);
  });
});

describe("write chunking", () => {
  it("splits a large paste into bounded packets and sends every byte", async () => {
    const sizes: number[] = [];
    invokeReply = () => ({ ok: true, data: { ok: true, value: null } });
    const payload = "a".repeat(TERMINAL_WRITE_MAX_BYTES * 2 + 17);

    await terminal.write({ terminalId: "t1", data: payload });

    for (const call of invocations.filter((item) => item.channel.endsWith(":write"))) {
      sizes.push((call.payload as { data: string }).data.length);
    }
    expect(sizes).toEqual([
      TERMINAL_WRITE_MAX_BYTES,
      TERMINAL_WRITE_MAX_BYTES,
      17,
    ]);
    // Chunking, not truncation: the total is exactly what was asked for.
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(payload.length);
  });

  it("STOPS at the first refusal rather than half-delivering a paste", async () => {
    let seen = 0;
    invokeReply = (channel) => {
      if (!channel.endsWith(":write")) return { ok: true, data: { ok: true, value: null } };
      seen += 1;
      return seen === 1
        ? { ok: true, data: { ok: false, code: "unknown_terminal" } }
        : { ok: true, data: { ok: true, value: null } };
    };

    const outcome = await terminal.write({
      terminalId: "t1",
      data: "b".repeat(TERMINAL_WRITE_MAX_BYTES * 3),
    });

    expect(outcome).toEqual({ ok: true, data: { ok: false, code: "unknown_terminal" } });
    expect(seen).toBe(1);
  });
});
