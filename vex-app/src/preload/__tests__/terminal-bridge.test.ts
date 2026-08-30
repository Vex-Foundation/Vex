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
  TERMINAL_REPLAY_CHUNK_MAX_BYTES,
  TERMINAL_WRITE_MAX_BYTES,
} = await import("../../shared/schemas/terminal.js");
const { terminal, __resetTerminalBridgeForTests, __lastPortDropReasonForTests } =
  await import("../shell/terminal.js");

/** A `MessagePort` stand-in: records outbound packets, injects inbound ones. */
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];
  started = false;
  closed = false;
  /** Listeners the bridge registered. A real `MessagePort` fires `close`. */
  readonly listeners = new Map<string, Array<() => void>>();
  /** Set to make `postMessage` throw, as posting into a dead port does. */
  dead = false;

  postMessage(value: unknown): void {
    if (this.dead) throw new Error("port is closed");
    this.sent.push(value);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  /** Fire the `close` the browser fires when the other end's process dies. */
  emitClose(): void {
    for (const listener of [...(this.listeners.get("close") ?? [])]) listener();
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const NONCE = "n".repeat(32);

/** Drain the microtask queue. Deterministic, where a timeout would not be. */
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
  // SAME MICROTASK, DELIBERATELY. This helper used to drain the queue first,
  // which hid the race it was papering over: main transfers the port from
  // INSIDE the acquire handler, so in production the port can arrive before the
  // invoke reply does. With the waiter registered only after the reply, such a
  // port found nobody waiting and was closed as a stray - and the acquisition
  // then sat until its own timeout. Posting here with no delay is what proves
  // the waiter is registered before the invoke.
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
    expect(second).toHaveBeenCalledWith("hello", expect.any(Function));

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

    expect(dataOne).toHaveBeenCalledWith("a", expect.any(Function));
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
    expect(data).toHaveBeenCalledWith("restored screen", expect.any(Function));
  });

  /**
   * RED ON REVERT. Restore a mirror larger than one replay chunk.
   *
   * The defect this pins: signalling a resync per CHUNK instead of per REPLAY.
   * The consumer's handler clears its screen on every resync, so a per-chunk
   * signal throws away every chunk but the last, and reports the dropped-row
   * count once per chunk. Both are silent - the terminal simply comes back with
   * a fraction of its history and an inflated counter.
   */
  it("signals ONE resync for a multi-chunk replay and keeps every chunk", async () => {
    const port = await acquire();
    const resync = vi.fn();
    // A consumer that behaves the way the terminal does: clear on resync,
    // append on data. What survives at the end is what the user would see.
    let screen = "";
    terminal.onResync("t1", () => {
      resync();
      screen = "";
    });
    terminal.onData("t1", (chunk: string) => {
      screen += chunk;
    });

    // Three chunks at the wire bound, which is what a mirror above 256 KiB
    // produces. The host stamps the SAME droppedRows on every chunk of one
    // replay, because they all come from one serialization.
    const chunks = ["a".repeat(TERMINAL_REPLAY_CHUNK_MAX_BYTES), "b".repeat(TERMINAL_REPLAY_CHUNK_MAX_BYTES), "c".repeat(4096)];
    chunks.forEach((chunk, index) => {
      port.receive({
        kind: "replay",
        terminalId: "t1",
        data: chunk,
        last: index === chunks.length - 1,
        droppedRows: 37,
      });
    });

    expect(resync).toHaveBeenCalledTimes(1);
    expect(screen).toBe(chunks.join(""));
    expect(screen.length).toBeGreaterThan(TERMINAL_REPLAY_CHUNK_MAX_BYTES);
  });

  it("reports droppedRows ONCE per replay rather than once per chunk", async () => {
    const port = await acquire();
    const reported: number[] = [];
    terminal.onResync("t1", (payload: { reason: string; droppedRows: number }) => {
      reported.push(payload.droppedRows);
    });
    terminal.onData("t1", () => {});

    for (const last of [false, false, true]) {
      port.receive({
        kind: "replay",
        terminalId: "t1",
        data: "x".repeat(1024),
        last,
        droppedRows: 37,
      });
    }

    expect(reported).toEqual([37]);
  });

  it("opens a NEW resync for the replay that follows a completed one", async () => {
    const port = await acquire();
    const resync = vi.fn();
    terminal.onResync("t1", resync);
    terminal.onData("t1", () => {});

    port.receive({ kind: "replay", terminalId: "t1", data: "one", last: true, droppedRows: 0 });
    port.receive({ kind: "replay", terminalId: "t1", data: "two", last: true, droppedRows: 5 });

    expect(resync).toHaveBeenCalledTimes(2);
  });

  it("does not let a replay abandoned mid-sequence suppress the next attach's clear", async () => {
    const port = await acquire();
    const resync = vi.fn();
    terminal.onResync("t1", resync);
    terminal.onData("t1", () => {});

    // A replay that never gets its `last` chunk, because the consumer detached.
    port.receive({ kind: "replay", terminalId: "t1", data: "partial", last: false, droppedRows: 0 });
    expect(resync).toHaveBeenCalledTimes(1);

    await terminal.detach({ terminalId: "t1" });
    await terminal.attach({ terminalId: "t1" });

    port.receive({ kind: "replay", terminalId: "t1", data: "fresh", last: true, droppedRows: 0 });
    expect(resync).toHaveBeenCalledTimes(2);
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
  /**
   * THE ACK FOLLOWS THE CONSUMER, NOT THE PACKET (F2).
   *
   * `Terminal.write` is asynchronous - it enqueues bytes and parses them on a
   * later turn - so acking on arrival proves only that the bytes reached this
   * process. Preload used to do exactly that, and a fast producer therefore
   * looked fully consumed while an unbounded parser queue grew in front of a
   * renderer that had rendered none of it.
   *
   * These two tests are the property, in both directions. Restoring an
   * arrival-time ack turns the second one red.
   */
  it("sends ONE ack per TERMINAL_ACK_CHARS the consumer COMPLETED, and none before", async () => {
    const port = await acquire();
    const completions: Array<() => void> = [];
    terminal.onData("t1", (_data, done) => completions.push(done));
    port.sent.length = 0;

    port.receive({
      kind: "data",
      terminalId: "t1",
      data: "x".repeat(TERMINAL_ACK_CHARS - 1),
    });
    port.receive({ kind: "data", terminalId: "t1", data: "x" });

    // Delivered in full, and NOT YET ACKNOWLEDGED: the consumer has not
    // reported finishing with any of it.
    expect(port.sent).toEqual([]);

    for (const settle of completions.splice(0)) settle();

    // Now it has. Without this ack the pty pauses at the high watermark and
    // never resumes.
    expect(port.sent).toEqual([
      { kind: "ack", terminalId: "t1", charCount: TERMINAL_ACK_CHARS },
    ]);
  });

  it("does NOT acknowledge while the consumer never reports completion", async () => {
    const port = await acquire();
    // A consumer that takes the bytes and never finishes with them - the slow
    // renderer this whole mechanism exists for.
    terminal.onData("t1", () => undefined);
    port.sent.length = 0;

    for (let burst = 0; burst < 5; burst += 1) {
      port.receive({
        kind: "data",
        terminalId: "t1",
        data: "x".repeat(TERMINAL_ACK_CHARS),
      });
    }

    // Five times the ack unit delivered and not one ack sent, so the host's
    // unacknowledged count climbs and the pty is paused at the source. Acking
    // on arrival would have sent five here.
    expect(port.sent).toEqual([]);
  });

  it("counts each completion ONCE, however many times the consumer calls it", async () => {
    const port = await acquire();
    const completions: Array<() => void> = [];
    terminal.onData("t1", (_data, done) => completions.push(done));
    port.sent.length = 0;

    port.receive({
      kind: "data",
      terminalId: "t1",
      data: "x".repeat(TERMINAL_ACK_CHARS),
    });
    const settle = completions[0];
    settle?.();
    settle?.();
    settle?.();

    // A double-settling consumer must not credit the host for characters it
    // was never sent - that is an un-pausable pty, from the other direction.
    expect(port.sent).toEqual([
      { kind: "ack", terminalId: "t1", charCount: TERMINAL_ACK_CHARS },
    ]);
  });

  /**
   * REPLAY CHUNKS ARE NEVER ACKNOWLEDGED (F2).
   *
   * The host clears every outstanding count when a replay completes - the
   * consumer's screen then equals the mirror by construction - so an ack for a
   * replay chunk landing after that clear is charged against live debt the
   * consumer never incurred.
   */
  it("never acknowledges a REPLAY chunk, even one the consumer completes", async () => {
    const port = await acquire();
    const completions: Array<() => void> = [];
    terminal.onData("t1", (_data, done) => completions.push(done));
    port.sent.length = 0;

    port.receive({
      kind: "replay",
      terminalId: "t1",
      data: "x".repeat(TERMINAL_ACK_CHARS * 2),
      last: true,
      droppedRows: 0,
    });
    for (const settle of completions.splice(0)) settle();

    expect(port.sent).toEqual([]);
  });
});

describe("resync recovery", () => {
  /**
   * THE EMERGENCY CEILING NEEDS BOTH HALVES (F3).
   *
   * The host detaches a consumer that hit the pending ceiling and tells it to
   * resync - then WAITS TO BE ASKED. Nothing in the system sent that request,
   * so the path ended in a terminal that had cleared its screen and would never
   * be sent another byte. Preload owns the request because preload owns the
   * port and the ack accounting the replay resets.
   */
  it("SENDS a resync request when the host demands one", async () => {
    const port = await acquire();
    const resyncs: Array<{ reason: string; droppedRows: number }> = [];
    terminal.onResync("t1", (info) => resyncs.push(info));
    port.sent.length = 0;

    port.receive({
      kind: "resyncRequired",
      terminalId: "t1",
      reason: "pending_ceiling",
    });

    // The consumer is told to throw its screen away...
    expect(resyncs).toEqual([{ reason: "pending_ceiling", droppedRows: 0 }]);
    // ...AND the replay that refills it is actually requested.
    expect(port.sent).toEqual([{ kind: "resync", terminalId: "t1" }]);
  });
});

describe("port recovery", () => {
  /**
   * A DEAD PORT IS DROPPED AND RE-ACQUIRED (F8).
   *
   * A `MessagePort` dies with the process on its other end, and it dies
   * silently: posting into a closed port delivers nothing and throws nothing.
   * The bridge held that corpse forever, so every attach, ack and detach after
   * a pty-host crash went nowhere with no error anywhere.
   */
  it("re-acquires after the port closes under it", async () => {
    const first = await acquire();
    expect(first.started).toBe(true);

    // The pty host died; the browser fires `close` on the entangled port.
    first.emitClose();

    const second = new FakePort();
    invokeReply = (channel) =>
      channel.endsWith("acquirePort")
        ? { ok: true, data: { ok: true, value: { nonce: NONCE } } }
        : { ok: true, data: { ok: true, value: null } };
    const attaching = terminal.attach({ terminalId: "t1" });
    postPort(second);
    await attaching;

    // A FRESH port, not the dead one, and the attach went to it.
    expect(second).not.toBe(first);
    expect(second.started).toBe(true);
    expect(second.sent).toEqual([{ kind: "attach", terminalId: "t1" }]);
  });

  it("drops a port whose post throws, rather than posting into a corpse", async () => {
    const port = await acquire();
    port.sent.length = 0;
    port.dead = true;

    const detached = await terminal.detach({ terminalId: "t1" });

    // Reported by name rather than resolving as if it had been delivered.
    // Narrowed rather than asserted through: `Result` carries `data` only on
    // the success arm, and reading it past a bare `.ok` check is the kind of
    // unchecked access the type ratchet exists to keep out of this suite.
    if (!detached.ok) throw new Error("the bridge failed rather than answering");
    expect(detached.data).toEqual({ ok: false, code: "port_unavailable" });
    expect(__lastPortDropReasonForTests()).toBe("post_failed");
  });

  /**
   * CONFIRMATION FAILURE IS AN OUTCOME (F8).
   *
   * An unconfirmed nonce expires in main, which tears the port down underneath
   * us. Ignoring the failed confirmation meant the bridge went on using a
   * conduit main was about to close, and every terminal on it stopped silently.
   */
  it("refuses the acquisition when main will not confirm the nonce", async () => {
    const port = new FakePort();
    invokeReply = (channel) =>
      channel.endsWith("acquirePort")
        ? { ok: true, data: { ok: true, value: { nonce: NONCE } } }
        : { ok: true, data: { ok: false, code: "port_unavailable" } };

    const attaching = terminal.attach({ terminalId: "t1" });
    postPort(port);
    const result = await attaching;

    if (!result.ok) throw new Error("the bridge failed rather than answering");
    expect(result.data).toEqual({ ok: false, code: "port_unavailable" });
    // The port is given up rather than retained as a conduit main has expired.
    expect(port.closed).toBe(true);
    expect(port.sent).toEqual([]);
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

  /**
   * THE GATE RUNS BEFORE THE CHUNKER, and it did not.
   *
   * `write` walked `input.data` for UTF-8 boundaries before anything had
   * checked it was a string, so a malformed call THREW at the preload boundary
   * instead of being refused by name - and a throw crossing the contextBridge
   * is not the typed refusal every other local failure on this surface answers
   * with. Validating first also means the chunker only ever sees a value the
   * shared schema accepts.
   */
  it("REFUSES a malformed write by name, without walking its bytes", async () => {
    invokeReply = () => ({ ok: true, data: { ok: true, value: null } });
    const before = invocations.length;

    // Through `JSON.parse`, which is what a hostile payload actually looks like
    // at this boundary: a value that never went through the typed path. No cast
    // is involved, so nothing here can be silencing a real type error.
    const nonString: { terminalId: string; data: string } = JSON.parse(
      '{"terminalId":"t1","data":42}',
    );
    const extraKey: { terminalId: string; data: string } = JSON.parse(
      '{"terminalId":"t1","data":"ls","extra":true}',
    );

    const outcomes = await Promise.all([
      terminal.write(nonString),
      terminal.write({ terminalId: "", data: "ls" }),
      terminal.write(extraKey),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: true, data: { ok: false, code: "invalid_packet" } });
    }
    // Nothing crossed the process line.
    expect(invocations.length).toBe(before);
  });
});

describe("every terminal input is VALIDATED AT THE PRELOAD GATE", () => {
  /**
   * Main revalidates all of this and main is the authority. That is not a
   * reason for the gate to be missing, and the boundary rule says so directly:
   * a narrow domain method parses what it is handed BEFORE it crosses the
   * process line. These methods did not, so whatever the renderer put in a
   * payload reached the privileged side unexamined, and the only thing between
   * it and a handler was the handler remembering.
   *
   * The schemas here are the SHARED ones main uses, so the two gates cannot
   * drift into disagreeing about what is acceptable.
   *
   * The observable property is the same for every row: nothing crosses. An
   * invalid input produces no invoke, and for the port methods no packet.
   */
  it("refuses an off-contract payload without invoking main", async () => {
    const rows: Array<{ what: string; call: () => Promise<unknown> }> = [
      {
        what: "create with a non-integer geometry",
        call: () => terminal.create({ projectId: "p1", cols: 80.5, rows: 24 }),
      },
      {
        what: "create with an empty projectId",
        call: () => terminal.create({ projectId: "", cols: 80, rows: 24 }),
      },
      {
        what: "resize past the column bound",
        call: () => terminal.resize({ terminalId: "t1", cols: 100_000, rows: 24 }),
      },
      {
        what: "kill with an empty terminalId",
        call: () => terminal.kill({ terminalId: "" }),
      },
      {
        what: "readWorkspace with an empty projectId",
        call: () => terminal.readWorkspace({ projectId: "" }),
      },
      {
        what: "persistWorkspace with a layout whose active index names nothing",
        call: () =>
          terminal.persistWorkspace({
            layout: { projectId: "p1", groups: [], activeGroupIndex: 3 },
          }),
      },
      {
        what: "persistWorkspace with one terminal in two panes",
        call: () =>
          terminal.persistWorkspace({
            layout: {
              projectId: "p1",
              activeGroupIndex: 0,
              groups: [
                {
                  groupId: "g1",
                  orientation: "horizontal",
                  activePaneIndex: 0,
                  panes: [
                    { terminalId: "t1", relativeSize: 0.5 },
                    { terminalId: "t1", relativeSize: 0.5 },
                  ],
                },
              ],
            },
          }),
      },
    ];

    for (const row of rows) {
      invocations.length = 0;
      await row.call();
      expect(invocations, row.what).toEqual([]);
    }
  });

  it("refuses an off-contract attach or detach without touching the port", async () => {
    const port = await acquire();
    const before = port.sent.length;

    const attached = await terminal.attach({ terminalId: "" });
    const detached = await terminal.detach({ terminalId: "" });

    expect(attached).toEqual({ ok: true, data: { ok: false, code: "invalid_packet" } });
    expect(detached).toEqual({ ok: true, data: { ok: false, code: "invalid_packet" } });
    // NOTHING WAS POSTED. The port is a live conduit into the process that
    // spawns shells; a packet the gate could not parse must not reach it.
    expect(port.sent.length).toBe(before);
  });
});
