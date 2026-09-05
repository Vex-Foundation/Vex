/**
 * THE PIPE FRONT'S LIFECYCLE, driven against a scripted front.
 *
 * Every case here is a row of the stage's design tables, and they share one
 * property: they are all bounds on a FAILURE, so they are invisible until the
 * failure happens and they all fail in the direction of "the app looks fine and
 * nothing works". The restart budget in particular must NOT reset on a
 * successful start - the same invariant `pty-host-starter.test.ts` pins for the
 * pty host, and the same one VS Code's `PtyHostService` carries.
 *
 * The `spawnFront` seam is what makes this deterministic. Everything else - the
 * state machine, the generation memory, the batch ordering, the timers, the
 * frame routing - is the real implementation, and both directions of the wire
 * are the REAL codec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";
import { PIPE_FRONT_BOUND_FLAGS, PIPE_FRONT_ERROR_CODES } from "@vex-agent/mcp/pipe-front-frames.js";

/**
 * The structural log is CAPTURED, not silenced: one case asserts that main
 * names an unobserved exit as the reason a later bind failed, and the log line
 * is where that fact is published.
 */
const logged = vi.hoisted(() => ({ errors: [] as string[], warns: [] as string[] }));
vi.mock("../../logger/index.js", () => ({
  log: {
    info: () => {},
    warn: (line: string) => logged.warns.push(line),
    error: (line: string) => logged.errors.push(line),
  },
}));

const {
  FRONT_BRINGUP_DEADLINE_MS,
  FRONT_EXIT_WAIT_MS,
  FRONT_MAX_RESTARTS,
  FRONT_STDERR_RING_LINES,
  FrontSupervisor,
} = await import("../mcp-host/front-supervisor.js");
const { FRONT_STDIO } = await import("../mcp-host/front-spawn.js");
const {
  FRONT_CHUNK_BYTES,
  FRONT_CREDIT_BYTES,
  FRONT_HANDSHAKE_DEADLINE_MS,
  FRONT_LOCK_ACK_DEADLINE_MS,
  FRONT_MAX_RAW,
} = await import("../mcp-host/front-handshake.js");
const { FakeFront } = await import("./fake-front.js");

const PIPE_NAME = "\\\\.\\pipe\\vex-studio-test";
const REFUSAL = '{"ok":false,"code":"malformed","message":"no handshake"}\n';

let fronts: InstanceType<typeof FakeFront>[];
let transitions: number;
let admitted: StudioDuplexTransport[];
let epoch: number;
let refusal: string | null;
/** Every supervisor this file built, so `afterEach` can release its timers. */
let built: InstanceType<typeof FrontSupervisor>[];

interface Harness {
  readonly supervisor: InstanceType<typeof FrontSupervisor>;
  readonly start: Promise<unknown>;
}

function build(
  over: {
    readonly generation?: number;
    readonly exitOnKill?: "async" | "never";
  } = {},
): Harness {
  const supervisor = new FrontSupervisor({
    pipeName: PIPE_NAME,
    command: "C:\\Program Files\\Vex\\resources\\bridge\\vex-pipe-front.exe",
    admissionEpoch: () => epoch,
    timeoutRefusalBytes: REFUSAL,
    refuseBeforeRead: () => refusal,
    onConnection: (wire) => admitted.push(wire),
    onTransition: () => (transitions += 1),
    spawnFront: () => {
      const front = new FakeFront({
        generation: over.generation ?? 0x1000 + fronts.length,
        ...(over.exitOnKill === undefined ? {} : { exitOnKill: over.exitOnKill }),
      });
      fronts.push(front);
      return front;
    },
  });
  built.push(supervisor);
  return { supervisor, start: supervisor.start() };
}

/** Drain the microtask queue. The relay raises `close` on one, as a socket does. */
async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * WAIT FOR THE RESTART, because main now waits for the corpse.
 *
 * A restart is no longer same-tick: main kills the failed front and spawns the
 * replacement only once it has seen the `exit` event, because on Windows the
 * pipe name belongs to the PROCESS and is released when the process is gone,
 * not when `kill()` returns. The fake models that with a macrotask, so a test
 * that wants to see the next front waits for one, then for the supervisor's
 * own `then`.
 */
async function restartSettles(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await microtasks();
}

/**
 * The same wait under FAKE timers: the exit macrotask has to be advanced past
 * rather than waited for.
 */
async function restartSettlesFake(): Promise<void> {
  vi.advanceTimersByTime(1);
  await microtasks();
}

function latest(): InstanceType<typeof FakeFront> {
  const front = fronts[fronts.length - 1];
  if (front === undefined) throw new Error("no front was spawned");
  return front;
}

beforeEach(() => {
  fronts = [];
  transitions = 0;
  admitted = [];
  built = [];
  epoch = 7;
  refusal = null;
  logged.errors.length = 0;
  logged.warns.length = 0;
});

/**
 * EVERY SUPERVISOR IS DISPOSED, on success and on failure alike.
 *
 * A supervisor that never reached `BOUND` still holds its bring-up timer, and a
 * timer that outlives its test does not merely leak: it fires into a spawn
 * seam whose closure still points at this file's arrays, so a later case would
 * see a front it did not ask for. Owning the handle is the fix, not a longer
 * deadline.
 */
afterEach(() => {
  for (const supervisor of built) supervisor.dispose();
  built = [];
});

describe("the HELLO main writes", () => {
  it("carries the six FROZEN numbers, the derived name and main's current epoch", () => {
    build();
    const hello = latest().hello();
    expect(hello).toBeDefined();
    expect({
      protocolVersion: hello?.protocolVersion,
      sddlKind: hello?.sddlKind,
      maxRaw: hello?.maxRaw,
      creditBytes: hello?.creditBytes,
      chunkBytes: hello?.chunkBytes,
      handshakeDeadlineMs: hello?.handshakeDeadlineMs,
      // THE ONE DYNAMIC FIELD (protocol 5.2). The front holds no compiled-in
      // expectation for it and takes it rather than checking it.
      initialAdmissionEpoch: hello?.initialAdmissionEpoch,
      pipeName: hello?.pipeName,
      // MAIN AUTHORS EVERY LINE THE PEER SEES. The front owns the deadline
      // TIMER because it owns `Accept`; it does not own the words.
      timeoutRefusalBytes: hello?.timeoutRefusalBytes,
    }).toEqual({
      protocolVersion: 1,
      sddlKind: 1,
      maxRaw: FRONT_MAX_RAW,
      creditBytes: FRONT_CREDIT_BYTES,
      chunkBytes: FRONT_CHUNK_BYTES,
      handshakeDeadlineMs: FRONT_HANDSHAKE_DEADLINE_MS,
      initialAdmissionEpoch: 7,
      pipeName: PIPE_NAME,
      timeoutRefusalBytes: REFUSAL,
    });
  });

  it("asks for the seven stdio slots the protocol needs, with 0 held and 1 ignored", () => {
    // Slot 0's EOF is the front's parent-death signal, so main must HOLD it
    // rather than ignore it; slot 1 carries nothing, which is the whole reason
    // no framed stream lives on stdout.
    expect([...FRONT_STDIO]).toEqual([
      "pipe",
      "ignore",
      "pipe",
      "overlapped",
      "overlapped",
      "overlapped",
      "overlapped",
    ]);
  });
});

describe("the bootstrap", () => {
  it("does not serve until BOUND, and then serves", async () => {
    const harness = build();
    latest().sendHelloAck();
    // HELLO_ACK alone publishes NOTHING: a front that answered the ack and
    // then failed its flag readback has never served a byte.
    expect(harness.supervisor.currentState()).toBe("starting");

    latest().sendBound();
    expect(harness.supervisor.currentState()).toBe("serving");
    await expect(harness.start).resolves.toEqual({ started: true });
  });

  it("DISCARDS the rest of a batch when HELLO_ACK fails", async () => {
    // Protocol 6.1: the codec adopts the announced generation while decoding,
    // so a front can attach a BOUND and an OPEN behind an ack main is about to
    // reject. Acting on them would announce a listener for a process main has
    // already decided is not its child.
    const harness = build();
    const front = latest();
    front.sendHelloAck({ pid: front.pid + 1 });
    front.sendBound();
    front.sendOpen(1);

    expect(admitted).toHaveLength(0);
    expect(front.killed).toBe(1);
    // A pid mismatch is restartable: a second spawn may well be main's child -
    // once the first one has actually let go of the pipe name.
    expect(fronts).toHaveLength(1);
    await restartSettles();
    expect(fronts).toHaveLength(2);
    expect(harness.supervisor.currentState()).toBe("starting");
  });

  it("rejects a generation this main has already served", async () => {
    const harness = build({ generation: 0x2222 });
    latest().completeHandshake();
    expect(harness.supervisor.currentState()).toBe("serving");

    // Kill it, and let the replacement announce the SAME generation. Only main
    // survives a restart, so only main can catch this (protocol 4).
    latest().exit(1);
    await restartSettles();
    expect(fronts).toHaveLength(2);
    latest().sendHelloAck({ generation: 0x2222 });
    expect(fronts[1]?.killed).toBe(1);
    await restartSettles();
    expect(fronts).toHaveLength(3);

    // A FRESH generation on the same epoch is accepted, and the epoch is the
    // one the dead front was serving - never a fresh count (protocol 5.2).
    latest().completeHandshake({ generation: 0x3333 });
    expect(harness.supervisor.currentState()).toBe("serving");
    expect(latest().hello()?.initialAdmissionEpoch).toBe(7);
  });

  it("FAILS CLOSED, without restarting, when a required BOUND flag is unconfirmed", async () => {
    const harness = build();
    latest().sendHelloAck();
    // The front asked for rejectRemote and could not read it back, so it
    // reports 0. Main will not publish a listener with a security property
    // Windows would not confirm, and a restart would read back the same thing.
    latest().sendBound({
      flagsApplied: PIPE_FRONT_BOUND_FLAGS.firstInstance | PIPE_FRONT_BOUND_FLAGS.messageMode,
    });

    await expect(harness.start).resolves.toMatchObject({
      started: false,
      failure: "bound_flags_unconfirmed",
    });
    expect({ state: harness.supervisor.currentState(), spawns: fronts.length }).toEqual({
      state: "failed",
      spawns: 1,
    });
  });

  it("refuses a BOUND that echoes a pipe name main did not ask for", async () => {
    const harness = build();
    latest().sendHelloAck();
    latest().sendBound({ pipeName: "\\\\.\\pipe\\somebody-else" });
    await expect(harness.start).resolves.toMatchObject({
      started: false,
      failure: "bound_pipe_name",
    });
  });
});

describe("failure settles every connection before it decides anything", () => {
  it("raises close on every logical connection when a frame is malformed", async () => {
    build();
    latest().completeHandshake();
    latest().sendOpen(1);
    latest().sendOpen(2);
    expect(admitted).toHaveLength(2);
    const closed: number[] = [];
    admitted.forEach((wire, index) => {
      wire.on("close", () => closed.push(index));
    });

    // A framing fault is TERMINAL: after it the position in the stream is
    // unknown and every byte is a guess (protocol 10).
    latest().sendRawControl(Buffer.alloc(28, 0xff));
    await microtasks();

    expect(closed.sort()).toEqual([0, 1]);
    expect(admitted[0]?.destroyed).toBe(true);
    // Killed, and restarted LOCKED under a new generation - AFTER its exit.
    await restartSettles();
    expect(fronts).toHaveLength(2);
  });

  it("settles a plane EOF and a child exit ONCE, in either order", async () => {
    build();
    latest().completeHandshake();
    const first = latest();
    first.endControlUp();
    first.exit(1);
    // Two signals, ONE accounted failure: the second finds the child already
    // settled and is ignored, so one death cannot spend two restarts.
    await restartSettles();
    expect(fronts).toHaveLength(2);

    latest().completeHandshake();
    const second = latest();
    second.exit(1);
    second.endControlUp();
    await restartSettles();
    expect(fronts).toHaveLength(3);
  });
});

describe("the restart budget", () => {
  it("permits SIX restarts, never resets, and then reports a durable cause", async () => {
    const harness = build();
    for (let crash = 0; crash < FRONT_MAX_RESTARTS + 2; crash += 1) {
      // Serve, then die. A counter that reset on a successful start would make
      // a front dying every thirty seconds restart forever.
      latest().completeHandshake();
      latest().exit(1);
      await restartSettles();
    }
    expect(fronts).toHaveLength(FRONT_MAX_RESTARTS + 2);
    expect({
      state: harness.supervisor.currentState(),
      failure: harness.supervisor.failure(),
      used: harness.supervisor.restartsUsed(),
    }).toEqual({
      state: "failed",
      failure: "restart_budget_exhausted",
      used: FRONT_MAX_RESTARTS + 1,
    });
  });
});

describe("the front's ERROR codes", () => {
  it("stops for good on a readback mismatch, which a restart cannot fix", async () => {
    const harness = build();
    latest().completeHandshake();
    latest().sendError(PIPE_FRONT_ERROR_CODES.sddl_readback_mismatch, 1);
    expect({
      state: harness.supervisor.currentState(),
      failure: harness.supervisor.failure(),
      spawns: fronts.length,
    }).toEqual({ state: "failed", failure: "sddl_readback_mismatch", spawns: 1 });
  });

  it("stops for good on a spent admission epoch, whose remedy is an APP restart", async () => {
    const harness = build();
    latest().completeHandshake();
    latest().sendError(PIPE_FRONT_ERROR_CODES.admission_epoch_exhausted, 1);
    expect(harness.supervisor.failure()).toBe("admission_epoch_exhausted");
    // A front restart is NOT the remedy: the new front would be handed the same
    // exhausted epoch (protocol 5.2).
    expect(fronts).toHaveLength(1);
  });

  it("logs a plane read failure and keeps serving", async () => {
    const harness = build();
    latest().completeHandshake();
    latest().sendError(PIPE_FRONT_ERROR_CODES.plane_read_failed, 3);
    // The codes are a LOG vocabulary and never a teardown cause (protocol 6.5).
    expect(harness.supervisor.currentState()).toBe("serving");
  });
});

describe("LOCK and QUIT", () => {
  it("sends LOCK with the NEW epoch and destroys every connection in the same tick", () => {
    const harness = build();
    latest().completeHandshake();
    latest().sendOpen(1);
    const wire = admitted[0];

    // The caller has already closed admission and advanced the epoch, so the
    // frame carries the new one and every ADMIT queued behind it is purged.
    epoch = 8;
    harness.supervisor.lock();

    const locks = latest().controlOfType("LOCK");
    expect(locks.map((frame) => frame.admissionEpoch)).toEqual([8]);
    expect(wire?.destroyed).toBe(true);
  });

  it("kills and restarts the front when LOCK_ACK misses its deadline", async () => {
    vi.useFakeTimers();
    try {
      const harness = build();
      latest().completeHandshake();
      harness.supervisor.lock();
      vi.advanceTimersByTime(FRONT_LOCK_ACK_DEADLINE_MS - 1);
      expect(fronts).toHaveLength(1);

      // "A front that cannot be commanded is never left holding live handles."
      vi.advanceTimersByTime(2);
      expect(fronts[0]?.killed).toBe(1);
      // The replacement waits for the corpse: the name is the process's.
      expect(fronts).toHaveLength(1);
      await restartSettlesFake();
      expect(fronts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline when LOCK_ACK arrives", () => {
    vi.useFakeTimers();
    try {
      const harness = build();
      latest().completeHandshake();
      harness.supervisor.lock();
      expect(harness.supervisor.currentState()).toBe("locking");
      latest().sendLockAck(8, 3);
      vi.advanceTimersByTime(FRONT_LOCK_ACK_DEADLINE_MS * 4);
      expect(fronts).toHaveLength(1);
      // A LOCKED front is still a SERVING front: the accept loop stays armed
      // and the next ADMIT after an unlock carries the epoch the LOCK set, so
      // reading resumes with no unlock frame and no rebind.
      expect(harness.supervisor.currentState()).toBe("serving");
    } finally {
      vi.useRealTimers();
    }
  });

  it("QUITs with what REMAINS of main's one absolute budget, then kills", async () => {
    const harness = build();
    latest().completeHandshake();
    const front = latest();

    const quit = harness.supervisor.quit(2_500, new Promise<void>(() => undefined));
    expect(front.controlOfType("QUIT").map((frame) => frame.deadlineMs)).toEqual([2_500]);
    front.sendQuitAck();
    await quit;
    expect(front.killed).toBe(1);
    expect(harness.supervisor.currentState()).toBe("stopped");
  });

  it("stops at the caller's deadline when QUIT_ACK never comes", async () => {
    const harness = build();
    latest().completeHandshake();
    let release = (): void => undefined;
    const deadline = new Promise<void>((resolve) => {
      release = resolve;
    });
    const quit = harness.supervisor.quit(2_500, deadline);
    release();
    await quit;
    expect(latest().killed).toBe(1);
  });
});

describe("the bring-up deadline and the child's stderr", () => {
  it("kills a front that never reaches BOUND", async () => {
    vi.useFakeTimers();
    try {
      build();
      latest().sendHelloAck();
      vi.advanceTimersByTime(FRONT_BRINGUP_DEADLINE_MS + 1);
      expect(fronts[0]?.killed).toBe(1);
      await restartSettlesFake();
      expect(fronts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a BOUNDED ring of structural lines and COUNTS what it dropped", () => {
    const harness = build();
    const front = latest();
    for (let line = 0; line < FRONT_STDERR_RING_LINES + 5; line += 1) {
      front.sendStderr(`vex-pipe-front accepted connection=${String(line)}\n`);
    }
    const tail = harness.supervisor.stderrTail();
    expect({ retained: tail.lines.length, dropped: tail.dropped }).toEqual({
      retained: FRONT_STDERR_RING_LINES,
      dropped: 5,
    });
    // The ring keeps the LATEST lines, which is what a support bundle needs.
    expect(tail.lines[tail.lines.length - 1]).toContain(
      `connection=${String(FRONT_STDERR_RING_LINES + 4)}`,
    );
  });
});

describe("dispose", () => {
  it("is idempotent and leaves nothing armed", () => {
    const harness = build();
    latest().completeHandshake();
    latest().sendOpen(1);
    harness.supervisor.dispose();
    harness.supervisor.dispose();
    expect({ killed: latest().killed, state: harness.supervisor.currentState() }).toEqual({
      killed: 1,
      state: "stopped",
    });
    expect(transitions).toBeGreaterThan(0);
  });
});

/**
 * THE PIPE NAME BELONGS TO THE PROCESS, NOT TO `kill()`.
 *
 * These are the cases CI run 33751109754 turned red on the Windows lane, and
 * every one of them is invisible on a transport whose endpoint is a file the
 * kernel unlinks. The front binds its name with first-instance protection and
 * the name is DERIVED from the config directory, so it is the same name every
 * launch and on every restart: a replacement that binds while the corpse is
 * still running gets `listener_bind_failed`, and six of those spend the whole
 * restart budget in under a second on a machine where nothing is broken.
 *
 * go-winio's `pipe_test.go` is the reference for the shape - `TestListenConnectRace`
 * and `TestAcceptAfterCloseFails` both close the listener and only then rebind,
 * because the handle is what the name belongs to. VS Code's `PtyHostService`
 * restarts in one tick and gets away with it only because
 * `createRandomIPCHandle()` hands every pty host a NEW name; main cannot.
 */
describe("the pipe name is released by the EXIT, not by the kill", () => {
  it("holds the replacement until the killed front has actually exited", async () => {
    const harness = build();
    latest().completeHandshake();
    const first = latest();

    // A restartable failure: the front's control plane went away.
    first.endControlUp();
    expect(first.killed).toBe(1);
    // NOTHING IS SPAWNED YET. This is the whole fix: the previous binding is
    // still held by a live process, and a spawn here is a bind that fails.
    expect(fronts).toHaveLength(1);
    expect(harness.supervisor.currentState()).toBe("starting");

    await restartSettles();
    expect(fronts).toHaveLength(2);
    latest().completeHandshake();
    expect(harness.supervisor.currentState()).toBe("serving");
  });

  it("gives up on an unobserved exit at its bound, and NAMES it in the next failure", async () => {
    vi.useFakeTimers();
    try {
      // A front that ignores the signal. Main cannot wait forever for it, and
      // it must not pretend the wait succeeded either.
      const harness = build({ exitOnKill: "never" });
      latest().completeHandshake();
      const stubborn = latest();
      stubborn.endControlUp();
      expect(stubborn.killed).toBe(1);

      vi.advanceTimersByTime(FRONT_EXIT_WAIT_MS - 1);
      await microtasks();
      expect(fronts).toHaveLength(1);

      vi.advanceTimersByTime(2);
      await microtasks();
      expect(fronts).toHaveLength(2);

      // The next front fails to bind, exactly as it would on Windows against a
      // name the corpse still owns, and main's report says WHY rather than
      // blaming a machine that is fine.
      latest().endControlUp();
      await microtasks();
      expect(harness.supervisor.currentState()).toBe("starting");
      expect(logged.errors.some((line) => line.includes("was never seen to exit"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("QUIT resolves only once the front is GONE, so the next bind is free", async () => {
    const harness = build();
    latest().completeHandshake();
    const front = latest();

    const quit = harness.supervisor.quit(2_500, new Promise<void>(() => undefined));
    front.sendQuitAck();
    await quit;
    // The acknowledgement is not the exit. `shutdownStudioMcpHost` resolves
    // through here, so "the host has shut down" has to mean the pipe name is
    // free - which is what a quit-and-relaunch depends on.
    expect({ killed: front.killed, exited: front.hasExited() }).toEqual({
      killed: 1,
      exited: true,
    });
    expect(harness.supervisor.currentState()).toBe("stopped");
  });

  it("LOCK to a front still in bring-up KILLS it instead of encoding a frame it cannot answer", () => {
    const harness = build();
    // No HELLO_ACK: a LOCK at generation 0 is refused by the encoder, and the
    // throw would escape `lock` into `lockStudioMcpHost` with the child left
    // alive and never locked. The same rule as QUIT: kill it, come back locked.
    const front = latest();
    epoch = 8;
    harness.supervisor.lock();

    expect(front.controlOfType("LOCK")).toHaveLength(0);
    expect(front.malformedFromMain).toHaveLength(0);
    expect(front.killed).toBe(1);
  });

  it("QUIT to a front still in bring-up KILLS it instead of encoding a frame it cannot answer", async () => {
    const harness = build();
    // No HELLO_ACK: the planes still carry the bootstrap generation 0, and the
    // encoder refuses every non-bootstrap frame at generation 0 by name. The
    // throw used to escape `quit` and skip the teardown entirely, leaving the
    // child alive on the pipe name - `quit failed: PipeFrontEncodeError` in the
    // Windows log, followed by six bind failures.
    const front = latest();
    await harness.supervisor.quit(2_500, new Promise<void>(() => undefined));

    expect(front.controlOfType("QUIT")).toHaveLength(0);
    expect(front.malformedFromMain).toHaveLength(0);
    expect({ killed: front.killed, exited: front.hasExited() }).toEqual({
      killed: 1,
      exited: true,
    });
    expect(harness.supervisor.currentState()).toBe("stopped");
  });

  it("a quit during a pending restart cancels it rather than spawning into a teardown", async () => {
    const harness = build();
    latest().completeHandshake();
    latest().endControlUp();
    expect(fronts).toHaveLength(1);

    await harness.supervisor.quit(2_500, new Promise<void>(() => undefined));
    await restartSettles();
    // No seventh handle, no front left running after the host reported stopped.
    expect(fronts).toHaveLength(1);
    expect(harness.supervisor.currentState()).toBe("stopped");
  });
});
