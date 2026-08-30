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
 * Fake timers are off the table here: a real pty's data arrives on the event
 * loop from a real kernel, and freezing the clock would freeze the thing under
 * test. Grace periods are made short by INJECTION (`graceMs` / `shortGraceMs`)
 * instead.
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
import { RecordingPort } from "./scripted-pty.js";

/**
 * Grace values small enough that a detach-then-expire is observable inside a
 * test, and large enough that a loaded WSL2 event loop does not expire a grace
 * the test still needs. Injected, never faked.
 */
const GRACE_MS = 1_500;
const SHORT_GRACE_MS = 400;

const WINDOW = "w1";
const PROJECT = "p1";

let snapshotDir: string;
let workDir: string;
let toMain: TerminalHostMessage[];
let services: PtyHostService[];
/** Every pid this test spawned, reaped in `afterEach` whatever else happened. */
let spawnedPids: number[];
let requestCounter = 0;

function buildService(): PtyHostService {
  const service = new PtyHostService({
    // THE PRODUCTION SEAMS. Only these two differ from `host-service.test.ts`.
    spawn: createNodePtySpawner(),
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
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      // No overlay: the scrubbed base environment is what production gives a
      // shell, and a test that widened it would prove something else.
      env: {},
    },
  });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.code}`);
  const value = outcome.value as { pid: number };
  spawnedPids.push(value.pid);
  return value;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until every pid is gone, or fail loudly.
 *
 * This is the suite's own reaping, not an assertion about the service: see the
 * header on why `shutdownAll()` resolving is not proof of a dead shell.
 */
async function reap(pids: readonly number[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter(isAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    for (const pid of remaining) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone between the filter and here. That is the goal state.
      }
    }
    await delay(25);
    remaining = remaining.filter(isAlive);
  }
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
 * A port that acknowledges FROM THE DATA PATH, the way preload does.
 *
 * Preload's `countForAck` runs inside its port `onmessage` handler: an ack is
 * emitted as soon as `TERMINAL_ACK_CHARS` have been delivered, on the same turn
 * the data arrived. An earlier version of the flood test instead acked from a
 * 5 ms `setInterval`, and that was wrong twice over. It was unfaithful - no
 * consumer in the system behaves that way - and because flow control blocks the
 * pty until an ack arrives, TOTAL THROUGHPUT became a function of timer
 * scheduling: alone the flood took 5.5 s, but under CPU contention from a
 * parallel run the timer starved and the same test needed over 162 s and blew
 * its budget. Acking from the data path removes the scheduler from the loop
 * entirely.
 *
 * The ack is posted in a MICROTASK rather than synchronously: the host sends
 * data from inside its own `handleData`, and answering it on that same stack
 * would re-enter the flow-control accounting mid-send.
 */
class AutoAckingPort extends RecordingPort {
  private pending = 0;
  private terminalId: string | null = null;

  ackFor(terminalId: string): void {
    this.terminalId = terminalId;
  }

  override postMessage(value: unknown): void {
    super.postMessage(value);
    const target = this.terminalId;
    // Not armed yet: the flood's first phase deliberately does not acknowledge,
    // and counting there would make the catch-up ack that arms this port
    // ambiguous about what it covers. Nothing accumulates until `ackFor`.
    if (target === null) return;
    const event = value as { kind?: string; data?: string };
    if (event.kind !== "data" && event.kind !== "replay") return;
    this.pending += event.data?.length ?? 0;
    if (this.pending < TERMINAL_ACK_CHARS) return;
    const charCount = this.pending;
    this.pending = 0;
    queueMicrotask(() => {
      this.receive({ kind: "ack", terminalId: target, charCount });
    });
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
});

afterEach(async () => {
  for (const service of services) {
    try {
      await service.shutdownAll();
    } catch {
      // A service that already shut down in the test body is the normal case.
    }
  }
  // The service's own report is not evidence. Reap what we spawned.
  await reap(spawnedPids);
  await fs.rm(snapshotDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * (a) Flow control against a real producer
 * ------------------------------------------------------------------ */

describe("flow control against a real pty", () => {
  /**
   * A consumer that acknowledges exactly as preload does, so the pty is driven
   * through pause and resume repeatedly over a large volume.
   */
  it(
    "PAUSES a real producer above the high watermark and resumes it on acks, losing nothing",
    async () => {
      const service = buildService();
      const port = new AutoAckingPort();
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
      const lineCount = 500_000;
      const line = "x".repeat(95);
      const sentinel = "VEX_FLOOD_DONE";
      await createTerminal(service, "t1", {
        args: [
          "-c",
          `yes '${line}' | head -n ${String(lineCount)}; echo ${sentinel}`,
        ],
      });
      const drain = new PortDrain(port, line, sentinel);
      port.receive({ kind: "attach", terminalId: "t1" });

      // FIRST: do not acknowledge. The host must pause the REAL pty, so the
      // stream has to STOP rather than growing without bound.
      await until(
        () => {
          drain.pump();
          return drain.chars > TERMINAL_FLOW_HIGH_WATERMARK_CHARS;
        },
        "the first burst to cross the high watermark",
      );
      drain.pump();
      const atPause = drain.chars;
      await delay(500);
      drain.pump();
      const afterWaiting = drain.chars;

      // The producer can overrun by at most what was already in flight when
      // pause was called. What it must NOT do is keep streaming for 500 ms - an
      // unpaused `yes` delivers tens of megabytes in that window.
      expect(afterWaiting - atPause).toBeLessThan(TERMINAL_FLOW_HIGH_WATERMARK_CHARS);
      expect(afterWaiting).toBeLessThan(2_000_000);

      // NOW let the consumer acknowledge from its data path, exactly as
      // preload does. If pause had not really stopped the producer the totals
      // below would not add up; if acks did not really resume it, this would
      // never finish.
      port.ackFor("t1");
      // One ack to restart the stream that is currently paused below the
      // threshold; every ack after this one comes from the data path itself.
      port.receive({ kind: "ack", terminalId: "t1", charCount: drain.chars });

      await until(
        () => {
          drain.pump();
          return drain.sawSentinel;
        },
        "the flood to run to completion",
        // A GENEROUS budget, not a weakened assertion. The volume and the
        // exact-count check below are unchanged; this only decides how much
        // CPU starvation the test tolerates before calling it a failure.
        // Measured on this machine: 4.3 s idle, 7.5 s under six spinning
        // cores, 132 s while two full `tsc` lint runs (twelve processes at
        // 4 GB each) were also running. A real producer on a shared event loop
        // is throughput-bound, so the budget has to clear the pathological
        // case or the suite reports a scheduler as a flow-control defect.
        240_000,
      );
      drain.pump();

      // NO MID-STREAM LOSS. Every line the shell wrote is in the ordered live
      // stream: the mirror's row bound governs REPLAY, never the live stream.
      expect(drain.markerCount).toBe(lineCount);
      // ~48 MB of payload plus the CR the pty adds to every newline.
      expect(drain.chars).toBeGreaterThan(48_000_000);

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
      // rather than assumed: the complete set it emits is `?1049h` (alternate
      // screen), `22;0;0t` (window title stack), `?1h` (application cursor
      // keys), `7m`/`27m` (reverse video for the status line) and `K` (erase to
      // end of line). It uses NO absolute cursor addressing - it repaints by
      // writing newlines - so asserting on a `H` sequence here would be testing
      // a convention this program does not follow. That assertion was written
      // first, and the live stream is what corrected it.
      const stream = dataOf(port);
      expect(stream).toContain("[?1049h");
      expect(stream).toContain("[7m");
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
  it(
    "keeps producing output while detached and replays VALID VT on reattach",
    async () => {
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
  it(
    "restores buffers AND layout from a snapshot written by a previous service",
    async () => {
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
      await send(first, { kind: "persistWorkspace", projectId: PROJECT, layout });

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
});
