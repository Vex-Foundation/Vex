/**
 * THE HOST AGAINST A REAL PSEUDO-TERMINAL.
 *
 * Every other suite in this directory drives a `ScriptedPty`, and that is the
 * right tool for the properties it proves - you cannot make a real shell emit
 * trailing output at a chosen microsecond. But a scripted pty also cannot fail
 * the way a real one does, and four properties of this host are only true if a
 * real kernel pty behaves the way the code assumes:
 *
 *  (a) FLOW CONTROL REACHES THE OS. `pause()` on node-pty stops draining the
 *      pty's pipe, which blocks the WRITER. A scripted pty proves the host
 *      calls pause; only a real one proves that calling it actually stops a
 *      producer, that acknowledging restarts it, and that nothing is lost in
 *      between.
 *  (b) THE MIRROR ACCEPTS REAL VT. A curses program emits alternate-screen
 *      switches, cursor addressing and erase sequences that no hand-written
 *      fixture contains. The serialization has to survive them.
 *  (c) A DETACHED TERMINAL KEEPS RUNNING. Output produced while nobody is
 *      listening has to be in the replay, and that replay has to be VALID VT -
 *      proven by feeding it into a fresh headless terminal and reading the
 *      screen back, not by matching a string.
 *  (d) REVIVE CROSSES A PROCESS LIFETIME. A snapshot written by one service and
 *      read by a second one over the same directory must restore both the
 *      buffers and the layout.
 *
 * ## How this suite is built, and why
 *
 * `dist/pty-host/index.js` exits immediately without a `parentPort`, so there
 * is no child process to drive. The service is therefore constructed
 * IN-PROCESS with the two production seams injected - `createNodePtySpawner`
 * and `filesystemLaunchProbe` - which is the same `HostServiceDeps` shape
 * `host-service.test.ts` uses with its fakes. Everything between the message
 * surface and the pty is the real code.
 *
 * ## Cleanup is this suite's own responsibility
 *
 * `await shutdownAll()` does NOT mean the shells are dead: `dispose()` makes a
 * pending `kill()` return early, so the promise can resolve while a process is
 * still exiting. Every test therefore records the pids it spawned and REAPS
 * them - `process.kill(pid, 0)` until it throws ESRCH - rather than trusting
 * the service's own report. A leaked `yes` loop would otherwise outlive the
 * run and burn a core.
 *
 * EVERY SIGNAL GOES THROUGH `assertSignalablePid`, because "the pid the host
 * reported" and "a process this suite may signal" are not the same set: pid 0
 * addresses this very process on both platforms, and node-pty reports 0 on
 * Windows until ConPTY's deferred connect completes. That gate is what stopped
 * this file from killing its own vitest worker; its doc carries the evidence.
 *
 * Fake timers are off the table here: a real pty's data arrives on the event
 * loop from a real kernel, and freezing the clock would freeze the thing under
 * test. Grace periods are made short by INJECTION (`graceMs` / `shortGraceMs`)
 * instead.
 *
 * ## The Windows trace
 *
 * `traceWindowsPhase` writes a structural progress line to stderr on win32 and
 * nothing anywhere else. It exists because this suite's Windows failures have
 * been NATIVE deaths, which vitest cannot report; see `windows-trace.ts` for
 * the reasoning and its removal condition.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TERMINAL_ACK_CHARS,
  TERMINAL_FLOW_HIGH_WATERMARK_CHARS,
  TERMINAL_SCROLLBACK_ROWS,
  type TerminalHostMessage,
  type TerminalHostRequest,
  type TerminalOutcome,
  type TerminalWorkspaceLayout,
} from "@shared/schemas/terminal.js";
import { PtyHostService } from "../host-service.js";
import { filesystemLaunchProbe } from "../launch-probe.js";
import { createNodePtySpawner } from "../node-pty-spawner.js";
import { scrubEnvironment } from "../process-env.js";
import { TerminalSnapshotStore } from "../snapshot-store.js";
import type { PtyAdapter, PtySpawner } from "../types.js";
import { RecordingPort } from "./scripted-pty.js";
import { traceWindowsPhase } from "./windows-trace.js";

traceWindowsPhase("module loaded");

/**
 * Grace values small enough that a detach-then-expire is observable inside a
 * test, and large enough that a loaded WSL2 event loop does not expire a grace
 * the test still needs. Injected, never faked.
 */
const GRACE_MS = 1_500;
const SHORT_GRACE_MS = 400;

/**
 * How far past the high watermark ONE read from the pty may carry the host.
 *
 * `TerminalProcess.handlePtyData` counts and decides to pause inside the data
 * event that crosses the mark, so the overshoot is bounded by a single read -
 * 64 KiB, node's default for the tty stream node-pty reads through. MEASURED
 * on Linux over ten runs, idle and under eight spinning cores: 188 to 4 064
 * characters. The ceiling asserted is the STRUCTURAL bound rather than the
 * measurement, so it stays true on a platform whose reads are larger while
 * still failing a pause that was deferred to a later event-loop turn.
 */
const PTY_SINGLE_READ_CEILING_CHARS = 65_536;

/**
 * How long a live pty stream may make NO progress before a test calls it wedged
 * rather than slow.
 *
 * A total-duration budget cannot tell those apart: the only way to make one
 * survive a loaded box is to raise it until it no longer catches the defect
 * either, and it has to be raised again every time the volume grows. What the
 * defect actually looks like - a resume that never happens, an ack path that
 * stopped - is SILENCE, and silence is load-independent.
 *
 * MEASURED with a one-second sampler over the flood - 48 MB at the time, at the
 * 95-character marker this suite used before ConPTY's row width narrowed it to
 * 36 MB - while eight spinning cores competed with the suite: the longest
 * interval between two observed increases of the delivered character count was
 * 50 ms. Thirty seconds is that with three orders of magnitude of headroom.
 */
const FLOW_STALL_MS = 30_000;

/**
 * The geometry of the flood producer: the pty's width, and a marker that fits
 * inside one row of it.
 *
 * The relationship is the point, which is why they are one pair. A pty on Unix
 * hands the host the producer's bytes; ConPTY hands it conhost's RENDERING of a
 * console screen buffer this many columns wide, and a marker wider than the row
 * arrives there split across two rows. Keeping the marker under the width makes
 * "every line arrived" a claim about the host on both platforms rather than a
 * claim about the emulator's line wrapping. See the flood test for the Windows
 * measurement that forced this.
 *
 * The volume is unchanged in kind: 500 000 lines is 36 MB through the pause and
 * resume cycle, hundreds of times the high watermark.
 */
const FLOOD_COLS = 80;
const FLOOD_MARKER_CHARS = 70;

const WINDOW = "w1";
const PROJECT = "p1";

let snapshotDir: string;
let workDir: string;
let toMain: TerminalHostMessage[];
let services: PtyHostService[];
/** Every pid this test spawned. `afterEach` fails the run if any survives. */
let spawnedPids: number[];
/**
 * Every pty the production spawner handed the host, in spawn order.
 *
 * The suite needs a SIGNALABLE pid, and the create reply cannot be the source
 * of one: on Windows node-pty has no pid yet when that reply is written (see
 * `assertSignalablePid`), and the host deliberately does not block a create on
 * a value that arrives later. What it does instead is publish the pid as a
 * PROPERTY once it exists - a stream this suite would have to attach a consumer
 * port to observe, and attaching one changes which side paces the pty, which
 * would silently rewrite the flow-control tests below.
 *
 * So the pid is read from the ADAPTER'S OWN LIVE GETTER, which is the same
 * value by the same mechanism the host reads. This wrapper only records; the
 * spawner inside it is the production one, unchanged.
 */
let spawnedPtys: PtyAdapter[];
let requestCounter = 0;

function recordingSpawner(): PtySpawner {
  const spawn = createNodePtySpawner();
  return (executable, args, options) => {
    const adapter = spawn(executable, args, options);
    spawnedPtys.push(adapter);
    return adapter;
  };
}

function buildService(): PtyHostService {
  const service = new PtyHostService({
    // THE PRODUCTION SEAMS. Only these two differ from `host-service.test.ts`.
    spawn: recordingSpawner(),
    probe: filesystemLaunchProbe,
    baseEnv: scrubEnvironment(process.env),
    snapshotStore: new TerminalSnapshotStore(snapshotDir),
    scrollbackRows: TERMINAL_SCROLLBACK_ROWS,
    graceMs: GRACE_MS,
    shortGraceMs: SHORT_GRACE_MS,
    sendToMain: (message) => toMain.push(message),
    // `platform` is deliberately omitted so the real `process.platform` decides,
    // which is what production does.
  });
  services.push(service);
  return service;
}

async function send(
  service: PtyHostService,
  request: TerminalHostRequest,
  ports: RecordingPort[] = [],
): Promise<TerminalOutcome<unknown>> {
  requestCounter += 1;
  const requestId = `r${String(requestCounter)}`;
  await service.handleMainMessage({ requestId, request }, ports);
  const reply = toMain.find(
    (message) => message.kind === "reply" && message.requestId === requestId,
  );
  if (reply === undefined || reply.kind !== "reply") {
    throw new Error(`no reply for ${requestId}`);
  }
  return reply.outcome;
}

/** Spawn a real `/bin/sh` and record its pid for reaping. */
async function createTerminal(
  service: PtyHostService,
  terminalId: string,
  options: { args?: readonly string[]; cols?: number; rows?: number } = {},
): Promise<{ pid: number }> {
  const outcome = await send(service, {
    kind: "create",
    terminalId,
    windowId: WINDOW,
    projectId: PROJECT,
    launch: {
      executable: "sh",
      args: [...(options.args ?? [])],
      cwd: workDir,
      projectLabel: "proj",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      // No overlay: the scrubbed base environment is what production gives a
      // shell, and a test that widened it would prove something else.
      env: {},
    },
  });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.code}`);
  const value = outcome.value as { pid: number };
  const adapter = spawnedPtys[spawnedPtys.length - 1];
  if (adapter === undefined) {
    throw new Error(`create ${terminalId} replied ok but no pty was spawned`);
  }
  // WAIT FOR NODE-PTY TO HAVE A PID, rather than believing the reply's echo.
  // On Windows that happens when ConPTY's deferred connect() completes, which
  // needs no output from the shell - so this resolves for `sleep 600` as well
  // as for a shell that prints a prompt. On Unix it is already true.
  await until(
    () => adapter.pid > 0,
    `node-pty to report a pid for ${terminalId}`,
    10_000,
  );
  // GUARDED AT THE SOURCE, so an unusable pid fails inside the test that
  // created it - where the trace says which shell it was - rather than inside
  // `afterEach`, whose failure erases the result of that test as well.
  const pid = assertSignalablePid(adapter.pid, `create ${terminalId}`);
  // When the reply DID carry a pid, it must be this one. That is the whole
  // contract of the echo: best-effort, never wrong.
  if (value.pid !== 0 && value.pid !== pid) {
    throw new Error(
      `create ${terminalId} replied pid ${String(value.pid)} but the pty is ${String(pid)}`,
    );
  }
  spawnedPids.push(pid);
  traceWindowsPhase(`spawned ${terminalId} pid ${String(pid)}`);
  return { pid };
}

/**
 * THE ONE GATE EVERY SIGNAL IN THIS FILE PASSES THROUGH.
 *
 * `process.kill` does not mean "signal this shell" for every integer. Pid 0 in
 * particular addresses THIS PROCESS on both platforms this suite runs on, by
 * two different mechanisms:
 *
 *  - on POSIX, `kill(0, sig)` addresses the caller's whole process GROUP, which
 *    is the vitest worker and everything it spawned;
 *  - on Windows, libuv's `uv_kill` substitutes `GetCurrentProcess()` when the
 *    pid is 0 and then calls `TerminateProcess` for SIGKILL/SIGTERM/SIGINT, so
 *    `process.kill(0, "SIGKILL")` terminates the worker outright - with no
 *    exception to catch, no vitest output, and the results of every test whose
 *    hooks had not finished lost with it.
 *
 * That is not a hypothetical here. node-pty has DEFERRED `conptyNative.connect()`
 * since 1.2.0-beta.11 (microsoft/node-pty#885; this repo pins 1.2.0-beta.15),
 * so `IPty.pid` is 0 from `spawn()` until the connection completes on Windows -
 * `windowsTerminal.js` only assigns `_pid = _agent.innerPid` inside its
 * `ready_datapipe` handler. `TerminalProcess.start` used to read `pty.pid` on
 * the line after the spawn, so on Windows the create outcome carried 0, this
 * suite recorded 0, `isAlive(0)` answered "still running" forever, and the leak
 * detector spent its whole budget on it before signalling. Both halves are on
 * the record: run 33602264566 reported "Hook timed out in 10000ms" from that
 * spin, and once the hook budget was raised to 60 s the spin got to finish and
 * the SIGKILL landed on the worker (run 33623840152, thirty seconds of silence
 * and no case reported).
 *
 * The host now defers its pid-dependent work to the first data event, the way
 * VS Code's `TerminalProcess` does, and `createTerminal` above waits for
 * node-pty's own live getter rather than for the reply. This gate stays: it is
 * the thing that made the failure legible, and every signal in this file still
 * has to prove it addresses a shell rather than this worker.
 *
 * So a pid that cannot have come from a shell this suite spawned is a THROWN,
 * NAMED failure rather than a signal. The suite loses a shell it cannot prove
 * dead - which is a red test with a cause in its message - instead of losing
 * the worker.
 */
function assertSignalablePid(pid: number, what: string): number {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `${what}: refusing to signal pid ${String(pid)}, which does not identify`
      + ` a shell this suite spawned. On Windows node-pty reports IPty.pid as 0`
      + ` until ConPTY's deferred connect() completes (microsoft/node-pty#885),`
      + ` and process.kill(0, ...) addresses this process - the caller's group`
      + ` on POSIX, GetCurrentProcess() in libuv's uv_kill on Windows. Reaching`
      + ` this line means node-pty never reported a pid for a pty it spawned,`
      + ` so nothing here can prove anything about that shell.`,
    );
  }
  return pid;
}

/**
 * Whether the OS still has this process.
 *
 * `kill(pid, 0)` is accurate on both platforms once the pid is real: libuv's
 * Windows `uv_kill` answers signal 0 with `GetExitCodeProcess`, so an exited
 * process reads as gone even while node-pty still holds a handle to it.
 */
function isAlive(pid: number): boolean {
  assertSignalablePid(pid, "liveness check");
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE LEAK DETECTOR. Wait for every pid to be gone, and REPORT the ones that
 * are not.
 *
 * This used to be a REAPER: it sent SIGKILL to whatever was still alive, and
 * that was the suite compensating for a production defect rather than
 * observing it. `dispose` cancelled the kill timers a shutdown had scheduled
 * and nulled the pty without killing it, so `shutdownAll` genuinely orphaned
 * shells - and the harness quietly cleaned them up, which is exactly why no
 * test ever failed for it.
 *
 * Now that the host kills its own ptys (`TerminalProcess.dispose`) and its
 * shutdown awaits the real exits, the suite's job is to CHECK that, not to do
 * it. Survivors are killed only AFTER they have been recorded, so a leak does
 * not burn a core for the rest of the run - but the leak is returned, and the
 * caller fails the run over it.
 *
 * Returns the pids that were still alive when the deadline passed.
 */
async function detectSurvivors(
  pids: readonly number[],
  timeoutMs = 10_000,
): Promise<number[]> {
  // EVERY PID BEFORE THE FIRST SIGNAL. A single unusable pid must abort the
  // detector rather than have it reach `process.kill` at the bottom of the
  // loop; see `assertSignalablePid` for what that call does to this worker.
  for (const pid of pids) assertSignalablePid(pid, "leak detector");
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(isAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(25);
    remaining = remaining.filter(isAlive);
  }
  // Recorded first, then cleaned up: a leaked `yes` loop must not outlive the
  // run, but the fact that it leaked must not be lost either.
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the filter and here. That is the goal state.
    }
  }
  return remaining;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a condition on the real event loop.
 *
 * Real pty output arrives when the kernel delivers it, so the alternative to
 * polling is a fixed sleep long enough for the slowest machine - which is both
 * slower and flakier than asking the question repeatedly.
 */
async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * `until`, for a condition on a stream that must keep MOVING.
 *
 * The failure this reports is a STALL - `stallMs` with no observed progress -
 * not an elapsed total, because a real producer on a shared event loop is
 * throughput-bound and its total is a property of the machine's load, while
 * silence is a property of the code. `progress` returns any monotonic measure
 * of the stream (delivered characters here); `describeState` is evaluated only
 * on failure and puts the flow-control state in the message, so a stall says
 * which side stopped instead of only that something did.
 *
 * `hardCeilingMs` is a backstop against a stream that dribbles forever without
 * finishing, and against this loop outliving the test that started it.
 */
async function untilProgressing(
  predicate: () => boolean,
  progress: () => number,
  what: string,
  describeState: () => string,
  stallMs = FLOW_STALL_MS,
  hardCeilingMs = 240_000,
): Promise<void> {
  const deadline = Date.now() + hardCeilingMs;
  let seen = progress();
  let movedAt = Date.now();
  while (Date.now() < deadline) {
    if (predicate()) return;
    const now = progress();
    if (now !== seen) {
      seen = now;
      movedAt = Date.now();
    } else if (Date.now() - movedAt > stallMs) {
      throw new Error(
        `stalled for ${String(stallMs)} ms waiting for: ${what} (${describeState()})`,
      );
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for: ${what} (${describeState()})`);
}

/** `until`, for a predicate that has to await something (a serialization). */
async function untilAsync(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/**
 * An INCREMENTAL consumer of a port's `data` events.
 *
 * A flood produces hundreds of thousands of events, and re-joining the whole
 * array on every poll is quadratic - the first version of the flood test did
 * exactly that and timed out after 120 s while the raw pty needed 459 ms for
 * the same volume. This walks a cursor, so the whole flood costs one pass.
 *
 * It counts the marker across CHUNK BOUNDARIES by carrying the last
 * `marker.length - 1` characters forward: a line split across two 5 ms
 * coalescing windows must still be counted once, and missing those would look
 * exactly like the mid-stream loss this test exists to rule out. A full marker
 * cannot fit inside a carry that short, so nothing is counted twice. The
 * sentinel is deliberately shorter than the marker, so it may be seen twice -
 * harmless, because it only sets a boolean.
 */
class PortDrain {
  chars = 0;
  markerCount = 0;
  sawSentinel = false;
  private cursor = 0;
  private carry = "";

  constructor(
    private readonly port: RecordingPort,
    private readonly marker: string,
    private readonly sentinel: string,
  ) {}

  pump(): void {
    const events = this.port.sent;
    for (; this.cursor < events.length; this.cursor += 1) {
      const event = events[this.cursor];
      if (event === undefined || event.kind !== "data") continue;
      const chunk = event.data;
      this.chars += chunk.length;
      const window = this.carry + chunk;
      this.markerCount += window.split(this.marker).length - 1;
      if (window.includes(this.sentinel)) this.sawSentinel = true;
      const keep = this.marker.length - 1;
      this.carry = window.slice(Math.max(0, window.length - keep));
    }
  }
}

/**
 * A consumer that acknowledges FROM A REAL XTERM'S WRITE COMPLETION.
 *
 * ## Why the bytes go through a real parser
 *
 * This class used to count characters as they arrived and ack on the count,
 * which SIMULATED a renderer keeping up. That is exactly the defect the
 * production path had: preload acked on receipt, and `XtermHost` wrote without
 * the completion callback, so a fast producer built an unbounded xterm parser
 * queue while every counter in the system read as caught up. A test that acks
 * on arrival cannot fail against that code, because it is that code.
 *
 * So the data is WRITTEN INTO A HEADLESS XTERM and the ack is emitted from the
 * write callback - the same seam `XtermHost` now passes to preload. The
 * property under test becomes end to end: the pty is paced by a real parser
 * finishing with real bytes.
 *
 * REPLAY CHUNKS ARE NOT ACKNOWLEDGED, matching preload. The host clears its
 * counters when a replay completes, so an ack for a replay chunk would be
 * charged against live debt the consumer never incurred.
 *
 * No `queueMicrotask` is needed any more: xterm's write callback already fires
 * on a later turn, so the ack can never re-enter the host's accounting on the
 * stack that sent the data.
 */
class XtermConsumerPort extends RecordingPort {
  readonly terminal = new HeadlessTerminal({
    cols: 80,
    rows: 24,
    scrollback: TERMINAL_SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
  /** Characters PARSED and not yet acknowledged. */
  private pending = 0;
  private terminalId: string | null = null;
  /** Writes handed to xterm whose parse has not completed. */
  private inFlight = 0;
  /** Set to stall the consumer: completions are recorded and not acted on. */
  stalled = false;
  private readonly stalledCompletions: Array<() => void> = [];

  get outstandingWrites(): number {
    return this.inFlight;
  }

  ackFor(terminalId: string): void {
    this.terminalId = terminalId;
  }

  /** Release a stalled consumer, letting every owed ack go out. */
  resumeConsumer(): void {
    this.stalled = false;
    for (const settle of this.stalledCompletions.splice(0)) settle();
  }

  override postMessage(value: unknown): void {
    super.postMessage(value);
    const event = value as { kind?: string; data?: string };
    if (event.kind !== "data" && event.kind !== "replay") return;
    const chars = event.data?.length ?? 0;
    const isReplay = event.kind === "replay";
    this.inFlight += 1;

    this.terminal.write(event.data ?? "", () => {
      this.inFlight -= 1;
      const settle = (): void => {
        // A replay is never acknowledged; see the class doc.
        if (isReplay) return;
        const target = this.terminalId;
        if (target === null) return;
        this.pending += chars;
        if (this.pending < TERMINAL_ACK_CHARS) return;
        const charCount = this.pending;
        this.pending = 0;
        this.receive({ kind: "ack", terminalId: target, charCount });
      };
      if (this.stalled) {
        this.stalledCompletions.push(settle);
        return;
      }
      settle();
    });
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** Everything a port received as `data`, concatenated in arrival order. */
function dataOf(port: RecordingPort): string {
  return port.eventsOfKind("data").map((event) => event.data).join("");
}

function replayOf(port: RecordingPort): string {
  return port.eventsOfKind("replay").map((event) => event.data).join("");
}

/**
 * Feed VT into a FRESH headless terminal and read the screen back.
 *
 * This is what makes "the replay is valid" a real assertion rather than a
 * string match: an invalid or truncated escape sequence does not render, so a
 * mirror that serialized a broken byte stream produces a screen missing the
 * text that should be on it.
 */
async function renderToScreen(vt: string, cols = 80, rows = 24): Promise<string> {
  const term = new HeadlessTerminal({
    cols,
    rows,
    scrollback: TERMINAL_SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => {
      term.write(vt, resolve);
    });
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  } finally {
    term.dispose();
  }
}

beforeEach(async () => {
  snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-realpty-snap-"));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "vex-realpty-work-"));
  toMain = [];
  services = [];
  spawnedPids = [];
  spawnedPtys = [];
  traceWindowsPhase("beforeEach ready");
});

afterEach(async () => {
  traceWindowsPhase("afterEach start");
  for (const service of services) {
    try {
      await service.shutdownAll();
    } catch {
      // A service that already shut down in the test body is the normal case.
    }
  }
  traceWindowsPhase("afterEach shutdownAll returned");
  // THE SERVICE'S OWN REPORT IS NOT EVIDENCE, so the world is checked. Every
  // shell this test spawned must be gone because the HOST ended it, not
  // because the harness did.
  const survivors = await detectSurvivors(spawnedPids);
  traceWindowsPhase(`afterEach survivors ${String(survivors.length)}`);
  await fs.rm(snapshotDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
  expect(survivors).toEqual([]);
  // THE HOOK OUTLIVES ITS OWN DETECTOR, deliberately. `detectSurvivors` spends
  // up to 10 s waiting for the shells to go, which is exactly vitest's default
  // hook budget, so a leak used to be reported as "Hook timed out in 10000ms"
  // with no pid in it - the shape the Windows lane reported (run 33602264566).
  // The shutdown above spends real time of its own there too: killing a pty
  // while conhost is still flushing is a documented Windows hang risk
  // (microsoft/vscode#71966, mitigated in VS Code by delaying the kill after
  // the last data event). The budget below leaves both room to finish so the
  // failure that surfaces is the assertion above, naming the pids that leaked.
}, 60_000);

/* ------------------------------------------------------------------ *
 * (0) The Windows canary - WINDOWS ONLY, and it runs FIRST
 * ------------------------------------------------------------------ */

/**
 * CAN NODE-PTY SPAWN AT ALL INSIDE A VITEST FORK WORKER ON WINDOWS, AND WHEN
 * DOES IT KNOW THE PID?
 *
 * Everything below this block goes through the host and takes minutes. When the
 * worker dies, the lane cannot tell "ConPTY cannot run here" from "the suite
 * signalled the wrong pid" from "the flood overran something", because the
 * corpse reports nothing. This case answers the first two in under a second,
 * before any of them has spent a shell.
 *
 * It is deliberately NOT routed through `PtyHostService`: the question is about
 * node-pty and the fork worker, so the only Vex code in the path is the
 * production spawner. It also uses `cmd.exe` rather than the `sh` every other
 * case launches, so a missing Git Bash on the runner reads as an `sh`
 * resolution failure there instead of as ConPTY being broken here.
 *
 * `describe.runIf` rather than `skipIf` on the rest of the file: this is a
 * Windows-only diagnostic being ADDED, so a POSIX run's case count and
 * assertions are exactly what they were.
 *
 * ## The pid assertion is the load-bearing one
 *
 * node-pty defers `conptyNative.connect()` (microsoft/node-pty#885), so
 * `IPty.pid` is 0 until the first data event - `windowsTerminal.js` assigns the
 * real pid inside `ready_datapipe`, and VS Code carries the same wait in
 * `terminalProcess.ts`. This case pins BOTH halves of that contract, so when
 * `PtyHostService` is fixed to resolve the pid the way VS Code does, the
 * behaviour it must rely on is already proven here.
 */
describe.runIf(process.platform === "win32")("ConPTY under a vitest fork worker", () => {
  traceWindowsPhase("describe: ConPTY canary");

  it("spawns a real shell, reports a pid once it connects, and reads one line", async () => {
    traceWindowsPhase("canary: start");
    const spawn = createNodePtySpawner();
    const pty = spawn(process.env.COMSPEC ?? "cmd.exe", ["/c", "echo VEX_CANARY"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workDir,
      env: scrubEnvironment(process.env),
    });
    traceWindowsPhase(`canary: spawned, pid at spawn ${String(pty.pid)}`);

    let seen = "";
    const data = pty.onData((chunk) => {
      seen += chunk;
    });
    try {
      await until(() => seen.includes("VEX_CANARY"), "the canary shell to echo", 20_000);
      traceWindowsPhase(`canary: read output, pid now ${String(pty.pid)}`);

      // THE DEFERRED-CONNECT CONTRACT. By the first data event node-pty has
      // completed `connect()` and knows the shell's pid, which is the moment
      // the host has to read it.
      expect(pty.pid).toBeGreaterThan(0);
    } finally {
      data.dispose();
      try {
        pty.kill();
      } catch {
        // `echo` may already have exited; the assertion above is the subject.
      }
    }
    traceWindowsPhase("canary: done");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * (a) Flow control against a real producer
 * ------------------------------------------------------------------ */

describe("flow control against a real pty", () => {
  traceWindowsPhase("describe: flow control");
  /**
   * A consumer that acknowledges exactly as preload does, so the pty is driven
   * through pause and resume repeatedly over a large volume.
   *
   * ## Why the shell is HELD OPEN after the flood
   *
   * The producer used to end with `echo <sentinel>` and let the shell exit, and
   * that made this an intermittently failing test on a loaded machine - not
   * because flow control misbehaved, but because a Linux pty does not promise
   * to deliver its tail once the slave closes.
   *
   * MEASURED, with `TerminalProcess.handlePtyData` instrumented to total every
   * character the HOST was ever handed, eight spinning cores competing with the
   * suite: on 5 runs out of 12 node-pty reported `exit` with that total already
   * 11 095 to 12 836 characters SHORT of the 48 500 016 the shell wrote at the
   * 95-character marker of the time, and no further data event ever arrived.
   * The last lines, sentinel included, were gone before any Vex code could see
   * them. The same loss reproduced with the host's watermark pause disabled
   * outright (2 of 5 runs), which is what rules our flow control out as the
   * cause: it is the kernel discarding what is still buffered on the master
   * when the last slave fd closes, surfacing through node-pty's EIO close path
   * (`unixTerminal.js`, `_socket.on('error')` -> `close` -> `exit`).
   *
   * `read _hold` leaves the shell blocked on the pty after the flood, so the
   * stream under test never crosses that exit boundary and every assertion
   * below is about the host again. The exit path keeps its own coverage, where
   * it can be deterministic: the scripted-pty suites own trailing-output-before
   * -exit (`flow-control.test.ts`, `launch-and-exit.test.ts`), and `afterEach`
   * still proves this shell is reaped.
   */
  it(
    "PAUSES a real producer above the high watermark and resumes it on acks, losing nothing",
    async () => {
      traceWindowsPhase("flood: start");
      const service = buildService();
      const port = new XtermConsumerPort();
      await send(service, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
        port,
      ]);

      // A NATIVE, exactly-sized producer. `yes | head -n` emits a known number
      // of identical lines as fast as the kernel will take them, which is what
      // makes both halves assertable: "nothing was lost" needs an exact
      // expected count, and "the pty really paused" needs a producer fast
      // enough to overrun an unpaused consumer immediately. A shell `while`
      // loop is neither - measured at over 120 s for this volume, against
      // 459 ms for `yes`.
      //
      // ## Why the marker FITS INSIDE ONE ROW
      //
      // The marker used to be 95 characters against an 80-column pty, and that
      // is what made this test red on the Windows lane - for a reason that is
      // not loss. A Unix pty is a byte pipe: what the producer writes is what
      // the host reads, so a marker wider than the row survives the trip
      // intact. ConPTY is not a pipe. It is conhost RENDERING a console screen
      // buffer of exactly `FLOOD_COLS` columns back out as VT, so a
      // 95-character line occupies two rows there and reaches the host as runs
      // of 80 and 15 characters - the marker never appears whole, and counting
      // it as missing accuses the host of losing what the emulator only
      // reflowed. MEASURED on the Windows lane (run 33602264566, job
      // 100158395057): `markerCount` came back 12 of 500 000 while every other
      // claim in this test held - the host paused above the watermark within
      // one read, the producer stayed stopped across the 500 ms window, acks
      // resumed it, the sentinel arrived and no resync was demanded.
      //
      // A marker NARROWER than the row cannot be split by any emulator in the
      // middle, so the exact count below stays a claim about the host on every
      // platform instead of a claim about line wrapping. The columns are passed
      // explicitly rather than inherited from the helper's default, because the
      // marker's width is only meaningful against the width of the row.
      const lineCount = 500_000;
      const line = "x".repeat(FLOOD_MARKER_CHARS);
      const sentinel = "VEX_FLOOD_DONE";
      await createTerminal(service, "t1", {
        cols: FLOOD_COLS,
        args: [
          "-c",
          `yes '${line}' | head -n ${String(lineCount)}; echo ${sentinel}; read _hold`,
        ],
      });
      const drain = new PortDrain(port, line, sentinel);
      port.receive({ kind: "attach", terminalId: "t1" });

      const terminal = service.terminal("t1");
      if (terminal === undefined) throw new Error("terminal vanished");
      const flow = terminal.process;

      // THE ATTACH HANDOFF FIRST. Until its last replay chunk has gone out, the
      // producer is paced by the MIRROR and the handoff ends in
      // `clearUnacknowledgedChars`, so a pause observed before that point is a
      // different owner's pause and would be cancelled a moment later.
      await until(
        () => port.eventsOfKind("replay").some((event) => event.last),
        "the attach handoff to finish its replay",
      );
      traceWindowsPhase("flood: replay handoff done");

      // FIRST: do not acknowledge. The host must pause the REAL pty.
      //
      // The wait is on the host's OWN decision rather than on a byte count in
      // the consumer, because the consumer's count lags by a coalescing window
      // and a lagging observer cannot say when the decision was taken.
      await until(
        () => flow.isPaused,
        "the host to pause the pty above the high watermark",
      );
      // Nothing has been acknowledged yet, so this counter IS every character
      // the host has read from the pty since the handoff.
      const readAtPause = flow.unacknowledged;
      traceWindowsPhase(`flood: pause observed at ${String(readAtPause)} chars`);

      // THE OVERSHOOT IS BOUNDED BY ONE READ. The pause is decided inside the
      // data event that crosses the mark, so the host can be past it by at most
      // the size of a single read - never by a second event's worth. A
      // regression that deferred the decision to a later turn breaks this.
      expect(readAtPause).toBeGreaterThan(TERMINAL_FLOW_HIGH_WATERMARK_CHARS);
      expect(readAtPause).toBeLessThanOrEqual(
        TERMINAL_FLOW_HIGH_WATERMARK_CHARS + PTY_SINGLE_READ_CEILING_CHARS,
      );

      // AND THE PRODUCER STAYS STOPPED. Proving that nothing arrives is the one
      // thing that needs elapsed time: there is no event for "no data". The
      // window is not the proof of a race, it is the interval over which a
      // growth of zero is asserted - and an unpaused `yes` puts tens of
      // megabytes through in it, so a pause that did not reach the OS cannot
      // survive the check.
      await delay(500);
      expect(flow.unacknowledged).toBe(readAtPause);
      drain.pump();
      // The consumer sees the same stopped stream, one coalescing window behind.
      expect(drain.chars).toBeLessThanOrEqual(readAtPause);

      // NOW let the consumer acknowledge from its data path, exactly as
      // preload does. If pause had not really stopped the producer the totals
      // below would not add up; if acks did not really resume it, this would
      // never finish.
      port.ackFor("t1");
      // One ack to restart the stream that is currently paused below the
      // threshold; every ack after this one comes from the data path itself.
      port.receive({ kind: "ack", terminalId: "t1", charCount: drain.chars });
      traceWindowsPhase("flood: resume acked, waiting for the sentinel");

      await untilProgressing(
        () => {
          drain.pump();
          return drain.sawSentinel;
        },
        () => drain.chars,
        "the flood to run to completion",
        () =>
          `delivered ${String(drain.chars)} chars, unacknowledged ${String(flow.unacknowledged)}`
          + `, paused ${String(flow.isPaused)}, writes in flight ${String(port.outstandingWrites)}`,
      );
      drain.pump();
      traceWindowsPhase(
        `flood: done, ${String(drain.chars)} chars, ${String(drain.markerCount)} markers`,
      );

      // NO MID-STREAM LOSS. Every line the shell wrote is in the ordered live
      // stream: the mirror's row bound governs REPLAY, never the live stream.
      //
      // Both numbers travel in the message. A count that comes back wrong says
      // nothing on its own about WHICH half moved - a stream that arrived whole
      // with unmatched markers is an emulator artifact, a stream that is short
      // in characters too is real loss - and a lane on another operating system
      // is the only place either can be observed.
      const delivered = () =>
        `delivered ${String(drain.chars)} chars, ${String(drain.markerCount)}`
        + ` markers of ${String(lineCount)}`;
      expect(drain.markerCount, delivered()).toBe(lineCount);
      // The payload plus the CR the pty adds to every newline: 36 MB on a Unix
      // pty, and at least that on ConPTY, whose own cursor and erase sequences
      // only add to the count.
      expect(drain.chars, delivered()).toBeGreaterThan(
        lineCount * FLOOD_MARKER_CHARS,
      );

      // MEMORY STAYED BOUNDED. The emergency ceiling is what protects the host
      // when flow control is not enough; a well-behaved consumer never reaches
      // it, and reaching it would have forced a full resync.
      expect(port.eventsOfKind("resyncRequired")).toEqual([]);
    },
    300_000,
  );
});

/* ------------------------------------------------------------------ *
 * (b) Real TUI bytes
 * ------------------------------------------------------------------ */

describe("a real curses program", () => {
  traceWindowsPhase("describe: curses program");
  /**
   * `less` is the chosen TUI, and the choice is deliberate.
   *
   * It is present on every platform this suite runs on, it drives the
   * alternate screen, absolute cursor addressing and erase-to-end-of-line the
   * way any curses program does, and - unlike an editor - it exits cleanly on a
   * single `q` with no modal state to get wrong. The assertion is on the TEXT
   * that lands on the screen rather than on the escape sequences, because the
   * exact sequences are a property of the local terminfo and the content is a
   * property of the mirror doing its job.
   */
  it(
    "survives alternate-screen and cursor-addressed output in the mirror",
    async () => {
      traceWindowsPhase("it: curses mirror");
      const service = buildService();
      const port = new RecordingPort();
      await send(service, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
        port,
      ]);

      // Longer than the 24-row screen, so less PAGES - the alternate screen
      // scrolls and repaints rather than being written once and left alone.
      const lines = Array.from(
        { length: 60 },
        (_, index) => `VEXROW${String(index).padStart(2, "0")}-content`,
      );
      await fs.writeFile(path.join(workDir, "doc.txt"), `${lines.join("\n")}\n`, "utf8");

      // NO `-X`: less is allowed its alternate screen, which is the whole
      // point. TERM is `xterm-256color`, set by the host on every spawn.
      await createTerminal(service, "t1", { args: ["-c", "less doc.txt"] });
      port.receive({ kind: "attach", terminalId: "t1" });

      await until(
        () => dataOf(port).includes("VEXROW11"),
        "less to paint the first page",
      );

      // Page down, so the alternate screen scrolls and repaints rather than
      // being written once and left alone.
      await send(service, {
        kind: "write",
        terminalId: "t1",
        windowId: WINDOW,
        data: " ",
      });
      await until(
        () => dataOf(port).includes("VEXROW30"),
        "less to paint the second page",
      );

      // Serialize WHILE less is still on screen. Quitting first would let less
      // restore the primary screen and clear its own output, so the assertion
      // would pass against an empty buffer.
      const terminal = service.terminal("t1");
      if (terminal === undefined) throw new Error("terminal vanished");
      const serialized = await terminal.process.mirror.serialize();

      // The stream really did carry TUI control sequences, not just text -
      // without this the assertions below would also hold for a `cat`.
      //
      // MEASURED against this machine's `less` and `xterm-256color` terminfo
      // rather than assumed: on Linux the complete set it emits is `?1049h`
      // (alternate screen), `22;0;0t` (window title stack), `?1h` (application
      // cursor keys), `7m`/`27m` (reverse video for the status line) and `K`
      // (erase to end of line). It uses NO absolute cursor addressing - it
      // repaints by writing newlines - so asserting on a `H` sequence here
      // would be testing a convention this program does not follow. That
      // assertion was written first, and the live stream is what corrected it.
      //
      // The witnesses are the two sequences EVERY platform emits by the time
      // the second page is on screen. Reverse video is not one of them: ConPTY
      // re-encodes the stream on its own schedule (it also adds absolute
      // addressing of its own), and the same commit's Windows lane saw `7m`
      // in one vitest step and not in the next (CI run 33804547267, job
      // 100811769277: the full run passed, the pty-host-alone run failed on
      // exactly this line). A witness that depends on when the attribute
      // repaint lands is a witness to timing, not to the mirror.
      const stream = dataOf(port);
      expect(stream).toContain("[?1049h");
      expect(stream).toContain("[K");

      // The mirror's serialization must render back to the rows that are on
      // screen. An invalid or truncated escape sequence would leave the text
      // off the screen entirely.
      const screen = await renderToScreen(serialized.data);
      for (const line of lines.slice(25, 44)) {
        expect(screen).toContain(line);
      }

      // Quit less and confirm the host saw a REAL exit rather than a hang.
      await send(service, {
        kind: "write",
        terminalId: "t1",
        windowId: WINDOW,
        data: "q",
      });
      await until(
        () => port.eventsOfKind("exit").length > 0,
        "less to exit on q",
      );
    },
    60_000,
  );
});

/* ------------------------------------------------------------------ *
 * (c) Detach, keep running, reattach
 * ------------------------------------------------------------------ */

describe("detach and reattach with a real pty", () => {
  traceWindowsPhase("describe: detach and reattach");
  it(
    "keeps producing output while detached and replays VALID VT on reattach",
    async () => {
      traceWindowsPhase("it: detach and reattach");
      const service = buildService();
      const first = new RecordingPort();
      await send(service, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
        first,
      ]);

      await createTerminal(service, "t1", { args: [] });
      first.receive({ kind: "attach", terminalId: "t1" });

      await send(service, {
        kind: "write",
        terminalId: "t1",
        windowId: WINDOW,
        data: "echo VEX_BEFORE_DETACH\n",
      });
      await until(
        () => dataOf(first).includes("VEX_BEFORE_DETACH"),
        "output before the detach",
      );

      // DETACH. The grace timer starts; the shell keeps running.
      first.receive({ kind: "detach", terminalId: "t1" });

      await send(service, {
        kind: "write",
        terminalId: "t1",
        windowId: WINDOW,
        data: "echo VEX_WHILE_DETACHED\n",
      });

      const terminal = service.terminal("t1");
      if (terminal === undefined) throw new Error("terminal vanished");
      await until(
        () => terminal.graceRunning,
        "the detach grace timer to be running",
      );

      // The mirror is the authority while nobody is listening, so this is where
      // the detached output must land. Serializing is async, so the poll has to
      // await it rather than firing it and reading a stale variable.
      await untilAsync(async () => {
        const snapshot = await terminal.process.mirror.serialize();
        return snapshot.data.includes("VEX_WHILE_DETACHED");
      }, "the mirror to hold output produced while detached");

      // REATTACH on a fresh port, exactly as a reloaded renderer does.
      const second = new RecordingPort();
      await send(service, { kind: "attachWindow", windowId: WINDOW, nonce: "m".repeat(32) }, [
        second,
      ]);
      second.receive({ kind: "attach", terminalId: "t1" });

      await until(
        () => second.eventsOfKind("replay").some((event) => event.last),
        "the replay to complete",
      );

      const replay = replayOf(second);
      // VALIDITY, not string matching: the replay is rendered into a fresh
      // headless terminal and the screen is read back.
      const screen = await renderToScreen(replay);
      expect(screen).toContain("VEX_BEFORE_DETACH");
      expect(screen).toContain("VEX_WHILE_DETACHED");

      // The pty was never killed by the detach; only the grace expiry does that.
      // Read the pid explicitly rather than defaulting it: `process.kill(0, 0)`
      // addresses the whole process GROUP, so a `?? 0` fallback here would turn
      // a missing pid into a signal aimed at the test runner itself.
      const shellPid = spawnedPids[0];
      expect(shellPid).toBeGreaterThan(0);
      expect(isAlive(shellPid ?? -1)).toBe(true);
    },
    60_000,
  );
});

/* ------------------------------------------------------------------ *
 * (d) Revive across a service restart
 * ------------------------------------------------------------------ */

describe("revive across a service restart", () => {
  traceWindowsPhase("describe: revive across restart");
  it(
    "restores buffers AND layout from a snapshot written by a previous service",
    async () => {
      traceWindowsPhase("it: revive restores buffers and layout");
      const first = buildService();
      const port = new RecordingPort();
      await send(first, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
        port,
      ]);

      await createTerminal(first, "t1");
      port.receive({ kind: "attach", terminalId: "t1" });
      await send(first, {
        kind: "write",
        terminalId: "t1",
        windowId: WINDOW,
        data: "echo VEX_SURVIVES_RESTART\n",
      });
      await until(
        () => dataOf(port).includes("VEX_SURVIVES_RESTART"),
        "output before the restart",
      );

      // A layout with DELIBERATELY UNEQUAL pane shares, which is the half of
      // the restore the renderer's own model change exists to preserve.
      const layout: TerminalWorkspaceLayout = {
        projectId: PROJECT,
        groups: [
          {
            groupId: "g1",
            orientation: "horizontal",
            panes: [{ terminalId: "t1", relativeSize: 0.7 }],
            activePaneIndex: 0,
          },
        ],
        activeGroupIndex: 0,
      };
      await send(first, {
        kind: "persistWorkspace",
        projectId: PROJECT,
        layoutVersion: 0,
        layout,
      });

      // THE ORDERED SHUTDOWN: serialize, commit, kill, dispose.
      await first.shutdownAll();

      // A SECOND service over the SAME directory - a restarted host.
      const second = buildService();
      const outcome = await send(second, { kind: "readWorkspace", projectId: PROJECT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("readWorkspace refused");

      const snapshot = outcome.value as {
        layout: TerminalWorkspaceLayout;
        terminals: Array<{ terminalId: string; serialized: string }>;
      };

      // LAYOUT survived, shares included.
      expect(snapshot.layout.groups[0]?.panes[0]?.relativeSize).toBe(0.7);
      expect(snapshot.layout.groups[0]?.panes[0]?.terminalId).toBe("t1");

      // BUFFER survived, and is still valid VT.
      const entry = snapshot.terminals.find((item) => item.terminalId === "t1");
      expect(entry).toBeDefined();
      const screen = await renderToScreen(entry?.serialized ?? "");
      expect(screen).toContain("VEX_SURVIVES_RESTART");
    },
    60_000,
  );

  /**
   * (d2) A WORKSPACE THAT WAS EXPLICITLY CLOSED, then quit on.
   *
   * The close is the whole sequence a user performs: commit the buffers, then
   * kill the shells. Afterwards the host held that layout with nothing behind
   * it, and `runShutdown` commits every retained layout on its own initiative -
   * reconciled, at that moment, against terminals that are all dead. The empty
   * result overwrote the file the close had just written, so the promise the
   * close makes ("reopen and your terminals come back") was broken by the very
   * next quit, silently.
   *
   * Driven end to end because that is where the defect lived: a real shell, a
   * real buffer, a real ordered shutdown, and a SECOND service over the same
   * directory - the restart. Removing `final` from the close's commit turns
   * `snapshot.terminals` into `[]` here.
   */
  it(
    "keeps a CLOSED workspace's buffers across an orderly quit and a restart",
    async () => {
      traceWindowsPhase("it: closed workspace survives quit");
      const first = buildService();
      const port = new RecordingPort();
      await send(first, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
        port,
      ]);

      const shell = await createTerminal(first, "t1");
      port.receive({ kind: "attach", terminalId: "t1" });
      await send(first, {
        kind: "write",
        terminalId: "t1",
        windowId: WINDOW,
        data: "echo VEX_CLOSED_THEN_QUIT\n",
      });
      await until(
        () => dataOf(port).includes("VEX_CLOSED_THEN_QUIT"),
        "output before the close",
      );

      // ---- THE CLOSE: the final commit, then the kills ----
      const persisted = await send(first, {
        kind: "persistWorkspace",
        projectId: PROJECT,
        layoutVersion: 0,
        final: true,
        layout: {
          projectId: PROJECT,
          groups: [
            {
              groupId: "g1",
              orientation: "horizontal",
              panes: [{ terminalId: "t1", relativeSize: 1 }],
              activePaneIndex: 0,
            },
          ],
          activeGroupIndex: 0,
        },
      });
      expect(persisted.ok).toBe(true);
      expect(
        (await send(first, { kind: "kill", terminalId: "t1", windowId: WINDOW })).ok,
      ).toBe(true);
      expect(isAlive(shell.pid)).toBe(false);

      // ---- THE QUIT, with the workspace closed and no reopen ----
      await first.shutdownAll();

      // ---- THE RESTART: a second service over the SAME directory ----
      const second = buildService();
      const outcome = await send(second, { kind: "readWorkspace", projectId: PROJECT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("readWorkspace refused");

      const snapshot = outcome.value as {
        layout: TerminalWorkspaceLayout;
        terminals: Array<{ terminalId: string; serialized: string }>;
      } | null;
      if (snapshot === null) throw new Error("the closed workspace's snapshot was lost");

      expect(snapshot.layout.groups[0]?.panes[0]?.terminalId).toBe("t1");
      const entry = snapshot.terminals.find((item) => item.terminalId === "t1");
      expect(entry).toBeDefined();
      const screen = await renderToScreen(entry?.serialized ?? "");
      expect(screen).toContain("VEX_CLOSED_THEN_QUIT");
    },
    60_000,
  );
});

/* ------------------------------------------------------------------ *
 * (e) Shutdown ends real processes (stage B2 round 3, F4)
 * ------------------------------------------------------------------ */

describe("shutdown against real processes", () => {
  traceWindowsPhase("describe: shutdown against real processes");
  /**
   * THE ORPHANED-SHELL PROOF, asserted against the OPERATING SYSTEM.
   *
   * `runShutdown` scheduled a kill and then `dispose` cancelled the very timers
   * that would have delivered it, nulling the pty without signalling it. Every
   * shell that was not going to exit on its own therefore survived the app
   * that spawned it. It never failed a test because this suite REAPED the
   * survivors itself, which is the harness compensating for a production
   * defect rather than observing it.
   *
   * So the shells here are chosen to be ones that will not leave voluntarily -
   * `sleep` for ten minutes - and deadness is read from the kernel with
   * `kill(pid, 0)`, not from the service's own report. Removing the kill from
   * `TerminalProcess.dispose` turns this red, and `afterEach`'s leak detector
   * red with it.
   */
  it("KILLS every real shell it owns, and the kernel agrees", async () => {
    traceWindowsPhase("it: shutdown kills every shell");
    const service = buildService();
    const first = await createTerminal(service, "t1", { args: ["-c", "sleep 600"] });
    const second = await createTerminal(service, "t2", { args: ["-c", "sleep 600"] });
    const third = await createTerminal(service, "t3", { args: ["-c", "sleep 600"] });

    // The premise: these really are running, so the assertion below is about
    // the shutdown rather than about shells that had already exited.
    await until(
      () => isAlive(first.pid) && isAlive(second.pid) && isAlive(third.pid),
      "all three shells to be running",
    );

    await service.shutdownAll();

    // No grace, no polling slack: the shutdown does not resolve until the ptys
    // have exited, so by this line they are gone.
    await until(
      () => ![first.pid, second.pid, third.pid].some(isAlive),
      "every shell to be gone after shutdownAll resolved",
      5_000,
    );
    expect([first.pid, second.pid, third.pid].filter(isAlive)).toEqual([]);
  }, 60_000);

  /**
   * A KILL SETTLES ON THE EXIT of a real process.
   *
   * Main releases the terminal's capacity and its project lease when this
   * request is answered. Answering on the signal rather than the exit is what
   * let a create take the slot of a pty that had not gone, and let a project
   * delete report itself finished with one of its shells still running.
   */
  it("does not answer a kill until the real process has exited", async () => {
    traceWindowsPhase("it: kill settles on exit");
    const service = buildService();
    const terminal = await createTerminal(service, "t1", { args: ["-c", "sleep 600"] });
    await until(() => isAlive(terminal.pid), "the shell to be running");

    const outcome = await send(service, {
      kind: "kill",
      terminalId: "t1",
      windowId: WINDOW,
    });

    expect(outcome).toEqual({ ok: true, value: null });
    // Read from the kernel the instant the reply exists. A kill acknowledged
    // before the exit fails here.
    expect(isAlive(terminal.pid)).toBe(false);
  }, 60_000);
});

describe("mirror-paced flow control against a real pty", () => {
  traceWindowsPhase("describe: mirror-paced flow control");
  /**
   * THE SLOW-RENDERER PROPERTY, END TO END (F2).
   *
   * The consumer here is a real headless xterm whose write completions are
   * HELD, which is what a renderer that has fallen behind actually looks like:
   * the bytes arrived, the parser has them, and nothing has finished with them.
   *
   * Under the old contract preload acknowledged on RECEIPT and `XtermHost`
   * wrote without the completion callback, so this consumer would have been
   * reported as fully caught up and the pty would have run at full speed into
   * a parser queue nobody was draining. The pause below is the whole fix,
   * observed at the producer.
   */
  it("PAUSES the producer for a consumer that never completes its writes", async () => {
    traceWindowsPhase("it: mirror-paced pause");
    const service = buildService();
    const port = new XtermConsumerPort();
    await send(service, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
      port,
    ]);

    const line = "y".repeat(95);
    await createTerminal(service, "t1", {
      args: ["-c", `yes '${line}' | head -n 200000`],
    });
    // Armed, so the consumer WOULD ack - if it ever finished a write.
    port.ackFor("t1");
    port.stalled = true;
    port.receive({ kind: "attach", terminalId: "t1" });

    const terminal = service.terminal("t1");
    if (terminal === undefined) throw new Error("unreachable");

    // The producer is stopped at the source, because the only consumer stopped
    // reporting progress.
    await until(
      () => terminal.process.isPaused,
      "the pty to pause behind a stalled consumer",
    );

    // AND IT STAYS STOPPED. An arrival-time ack would have kept crediting the
    // host and the stream would have run to completion regardless.
    const atPause = port.eventsOfKind("data").length;
    await delay(500);
    const afterWaiting = port.eventsOfKind("data").length;
    expect(afterWaiting - atPause).toBeLessThan(5);

    // Releasing the consumer lets the owed acks out and the producer resumes,
    // so the pause was backpressure and not a deadlock.
    port.resumeConsumer();
    await until(
      () => !terminal.process.isPaused,
      "the pty to resume once the consumer caught up",
    );

    port.dispose();
  }, 120_000);
});

describe("a snapshot against a REAL, CONTINUOUSLY PRODUCING shell", () => {
  traceWindowsPhase("describe: snapshot under continuous production");
  /**
   * (e) THE HOLD REACHES THE OPERATING SYSTEM.
   *
   * The other four properties in this file exist because a scripted pty cannot
   * fail the way a real one does. This one is the same argument applied to the
   * snapshot path: `commitProject` now pauses every producer for the duration
   * of drain -> serialize -> reduce -> commit, and a scripted pty proves only
   * that `pause()` was called. Whether calling it actually stops a real `yes`
   * loop - and therefore whether the mirror is genuinely fixed while it is
   * being serialized - is a question only a kernel pty answers.
   *
   * Before the hold, this path had no pause at all. The mirror's drain is
   * documented to terminate only because its callers pause the producer first,
   * and this caller did not; against a real firehose that is an unbounded wait
   * on the quit path.
   *
   * The assertion is the OUTCOME the user gets: the snapshot commits promptly
   * and the file is on disk, while a real shell is writing as fast as the
   * kernel will take it.
   *
   * ## WHAT THIS TEST DOES NOT PROVE, measured rather than assumed
   *
   * It was run with the hold DELETED and it still passed. The reason is worth
   * recording, because it is easy to mistake this for a proof: a detached
   * terminal is mirror-paced, so by the time the capture runs the flow-control
   * watermark has usually already paused this pty for its own reasons, and the
   * drain then reaches a fixed point whether or not the snapshot took a hold.
   *
   * The DISCRIMINATING proof of the hold is the scripted-firehose test in
   * `host-service.test.ts`, which counts the chunks delivered between the start
   * of a capture and its commit and goes red with three. This one is the real-
   * kernel regression guard for the outcome: that a live shell does not turn
   * the quit path into a hang, and that the hold is released afterwards.
   */
  it("commits promptly while a real `yes` loop is running", async () => {
    traceWindowsPhase("it: snapshot under continuous production");
    const service = buildService();
    const port = new RecordingPort();
    await send(service, { kind: "attachWindow", windowId: WINDOW, nonce: "n".repeat(32) }, [
      port,
    ]);

    // A native producer that never stops on its own. Detached, so the MIRROR is
    // its only consumer - which is the state a snapshot on quit finds.
    const { pid } = await createTerminal(service, "firehose", {
      args: ["-c", "yes vex-snapshot-hold-probe"],
    });
    expect(isAlive(pid)).toBe(true);

    // Let it genuinely fill the mirror first, or the capture would be trivial.
    await untilAsync(
      async () => (await service.terminal("firehose")?.process.mirror.serialize())
        ?.data.includes("vex-snapshot-hold-probe") === true,
      "the real shell to fill the mirror",
    );

    const startedAt = Date.now();
    const persisted = await send(service, {
      kind: "persistWorkspace",
      projectId: PROJECT,
      layoutVersion: 0,
      layout: {
        projectId: PROJECT,
        activeGroupIndex: 0,
        groups: [
          {
            groupId: "g1",
            orientation: "horizontal",
            activePaneIndex: 0,
            panes: [{ terminalId: "firehose", relativeSize: 1 }],
          },
        ],
      },
    });
    const elapsed = Date.now() - startedAt;

    expect(persisted.ok).toBe(true);
    // PROMPTLY, against a producer that is still running. Generous enough for a
    // loaded WSL2 event loop, far under what an unheld drain against `yes`
    // would cost.
    expect(elapsed).toBeLessThan(15_000);

    const file = path.join(snapshotDir, `${PROJECT}.json`);
    const raw = await fs.readFile(file, "utf8");
    const saved = JSON.parse(raw) as {
      terminals: Array<{ terminalId: string; serialized: string }>;
    };
    expect(saved.terminals.map((entry) => entry.terminalId)).toEqual(["firehose"]);
    expect(saved.terminals[0]?.serialized).toContain("vex-snapshot-hold-probe");

    // AND THE PRODUCER WAS RELEASED. A hold that is not released leaves the
    // user with a shell that has silently stopped.
    const after = await service.terminal("firehose")?.process.mirror.serialize();
    expect(after?.data.includes("vex-snapshot-hold-probe")).toBe(true);
    expect(isAlive(pid)).toBe(true);

    await service.shutdownAll();
    expect(await detectSurvivors([pid])).toEqual([]);
  }, 120_000);
});
