/**
 * Stage B4.2a spike, parent half: drive the Go `spike-overlapped-stdio` child
 * from ELECTRON MAIN and record what the platform actually did.
 *
 * THE QUESTION THIS ANSWERS. Can a Go child spawned from Electron main on
 * Windows with Node's `'overlapped'` stdio mode open and use additional
 * inherited stdio pipes (slot 3 and up) as real duplex planes: concurrent
 * duplex on one handle, deadlines that fire, close that cancels a blocked
 * read, useful throughput in small chunks, and a bound on writes this parent
 * is not reading?
 *
 * WHY ELECTRON AND NOT PLAIN NODE. Production spawns the pipe-front from
 * Electron main, so the libuv that creates these pipes must be ELECTRON'S. A
 * plain `node` run would measure a different libuv build and prove nothing
 * about the shipped path. This is the same reason `scripts/probe-node-pty.mjs`
 * runs under Electron rather than vitest.
 *
 * THE STDIO LAYOUT this harness asks for, and what each slot is for:
 *
 *   0  pipe         stdin, unused
 *   1  pipe         the child's ONE JSON report
 *   2  pipe         the child's NDJSON progress, which is also how this
 *                   harness knows which phase to drive
 *   3  overlapped   plane A: duplex, read deadline, throughput
 *   4  overlapped   plane B: must keep flowing while plane C is stalled
 *   5  overlapped   plane C: this harness deliberately NEVER reads it while
 *                   the child is stalling on it, then drains it and writes ONE
 *                   marker back to release the child from its exit interlock
 *   6  overlapped   plane D: the child closes it under a blocked read
 *
 * Using stderr for choreography is a HARNESS convenience, not a proposal: a
 * real transport would never put control on a log stream. See README.md.
 *
 * EXIT CONTRACT. 0 when a complete evidence artifact was produced, including
 * an artifact that records a NEGATIVE answer or an unsupported platform, since
 * a negative measurement is a result. Non-zero only when this harness could
 * not measure at all: the child would not spawn, the artifact could not be
 * written, the watchdog fired, or `--require-measurement` was passed and the
 * child did not complete its measurement.
 *
 * Usage:
 *   pnpm exec electron scripts/spikes/overlapped-stdio/run-spike.mjs \
 *     [--child <path to the built binary>] \
 *     [--json <artifact path>] \
 *     [--require-measurement]
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import {
  ACTION_DRAIN_UNREAD_PLANE,
  ACTION_END_THROUGHPUT_PHASE,
  ACTION_RECORD_THROUGHPUT_ERROR,
  ACTION_RECORD_THROUGHPUT_REQUEST,
  ACTION_START_THROUGHPUT_WRITE,
  createChoreography,
} from "./choreography.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VEX_APP_ROOT = path.resolve(HERE, "..", "..", "..");
const REPO_ROOT = path.resolve(VEX_APP_ROOT, "..");

/** Must match the constants in bridge/cmd/spike-overlapped-stdio/main_windows.go. */
const PLANE_DUPLEX = 3;
const PLANE_KEEPALIVE = 4;
const PLANE_UNREAD = 5;
const PLANE_CLOSE_CANCEL = 6;
const CHILD_DUPLEX_MARKER = "vex-spike-child-duplex-3f91\n";
const PARENT_DUPLEX_MARKER = "vex-spike-parent-duplex-8c02\n";
const PARENT_DRAINED_MARKER = "vex-spike-parent-drained-5d17\n";
const THROUGHPUT_CHUNK = 32 * 1024;

/** The stub build's exit code for "this platform cannot run the measurement". */
const CHILD_EXIT_UNSUPPORTED = 2;

/**
 * Total budget for the whole run. It must OUTLAST the instrument, or this
 * harness would give up on a measurement the child was still completing and
 * report a timeout that says nothing about the platform. The instrument's own
 * hard watchdog is 180s measured from its start (and its 15s drain handshake
 * runs inside that budget, not after it), after which this harness still waits
 * up to STDIO_GRACE_MS for the report to arrive: 240s clears 185s with room for
 * a slow runner.
 */
const HARNESS_DEADLINE_MS = 240_000;

/** How long to drain the deliberately unread plane once the child is done with it. */
const DRAIN_MS = 2_000;

/**
 * How long to wait for the child's stdio to CLOSE after the process is gone.
 * 'exit' says the process died, not that its report was delivered, so the
 * report is read from closed streams; this timer is the bound on a stdio
 * handle that something outside this harness holds open.
 */
const STDIO_GRACE_MS = 5_000;

/**
 * Bound on the interlock write that releases the child from its drain wait.
 * The child's matching bound is `drainHandshakeWait` (15s) in
 * bridge/cmd/spike-overlapped-stdio/main_windows.go, which must stay LARGER
 * than DRAIN_MS + this, or the child gives up before the marker is sent.
 */
const HANDSHAKE_WRITE_MS = 5_000;

/**
 * Bounds on what this harness retains from the child's streams. The report is
 * a few kilobytes and the progress stream a few dozen lines; anything past
 * these bounds is a broken instrument, and the overflow is COUNTED and
 * reported rather than silently dropped.
 */
const STDOUT_CAP_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_LINES = 200;

/** Longest partial NDJSON line held while waiting for its newline. */
const STDERR_PARTIAL_LINE_CAP = 1024 * 1024;

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function flagValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function goTargetForThisHost() {
  const goos = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform] ?? process.platform;
  const goarch = { x64: "amd64", arm64: "arm64" }[process.arch] ?? process.arch;
  return `${goos}-${goarch}`;
}

function resolveChildPath() {
  const explicit = flagValue("--child");
  if (explicit !== undefined) return path.resolve(process.cwd(), explicit);
  const binary = process.platform === "win32" ? "spike-overlapped-stdio.exe" : "spike-overlapped-stdio";
  return path.join(REPO_ROOT, "bridge", "dist", goTargetForThisHost(), binary);
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

function environmentProvenance() {
  return {
    timestamp_utc: new Date().toISOString(),
    commit: gitCommit(),
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    os_version: typeof os.version === "function" ? os.version() : "unavailable",
    electron: process.versions.electron,
    node_in_electron: process.versions.node,
    chrome: process.versions.chrome,
    v8: process.versions.v8,
    cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
  };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

function run() {
  const childPath = resolveChildPath();
  const artifactPath = flagValue("--json");
  const requireMeasurement = process.argv.includes("--require-measurement");

  /** Everything this harness saw with its own eyes, as opposed to what the child reported. */
  const parent = {
    stdio_request: ["pipe", "pipe", "pipe", "overlapped", "overlapped", "overlapped", "overlapped"],
    stdio_slots: [],
    events: [],
    duplex: { child_marker_seen: false, reply_written: false, reply_error: null },
    throughput: {
      requested_bytes: null,
      bytes_written: 0,
      bytes_received: 0,
      write_returned_false: 0,
      drain_waits_ms: 0,
      elapsed_ms: null,
      error: null,
    },
    keepalive: { frames_echoed: 0, bytes_echoed: 0, error: null },
    unread_plane: {
      resumed_after_stall: false,
      bytes_drained_after_stall: 0,
      drain_error: null,
      drain_marker_written: false,
      drain_marker_error: null,
    },
    close_cancel_plane: { ended: false, error: null },
    /**
     * How the child's report was collected. `stdout_closed` is the only value
     * that makes `child_report` trustworthy: a report read while stdout was
     * still open may be a prefix of the document the child wrote.
     */
    report_collection: { stdout_closed: false, note: null },
  };

  let settled = false;
  let watchdog = null;
  let child = null;
  let stdout = "";
  let stdoutRetainedBytes = 0;
  let stdoutDroppedBytes = 0;
  let stderrTail = "";
  let stderrDroppedLines = 0;
  let stderrLineBuffer = "";
  let childExit = null;

  /**
   * Every timer this harness arms, so `finish` can release them all on every
   * path. A stray timer keeps the Electron event loop alive and, worse, can
   * fire against state the run has already published.
   */
  const timers = new Set();
  const armTimer = (ms, fn) => {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
    return handle;
  };
  /** Resolves with "settled" or "timeout"; never rejects, and always disarms its timer. */
  const bounded = (promise, ms) =>
    new Promise((resolve) => {
      const handle = armTimer(ms, () => resolve("timeout"));
      const done = () => {
        clearTimeout(handle);
        timers.delete(handle);
        resolve("settled");
      };
      promise.then(done, done);
    });
  /**
   * The drain of the deliberately unread plane outlives the child: the bytes
   * the operating system buffered behind this parent are still readable after
   * the writer is gone, and the child exits within milliseconds of announcing
   * the end of the stall. Without this the measurement would report whatever
   * happened to arrive in that gap.
   */
  let drainSettled = Promise.resolve();

  const finish = (outcome, harnessError) => {
    if (settled) return;
    settled = true;
    if (watchdog !== null) clearTimeout(watchdog);
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    try {
      child?.kill();
    } catch {
      // Already gone, which is the state we wanted.
    }
    // The extra planes are this harness's handles. Releasing them explicitly
    // keeps the teardown honest rather than relying on app.exit to take them.
    for (let i = PLANE_DUPLEX; i < parent.stdio_request.length; i += 1) {
      try {
        child?.stdio[i]?.destroy();
      } catch {
        // Already destroyed, which is the state we wanted.
      }
    }

    let childReport = null;
    let childReportError = null;
    if (stdoutDroppedBytes > 0) {
      childReportError =
        `the child wrote more than the ${STDOUT_CAP_BYTES} byte retention bound on stdout and `
        + `${stdoutDroppedBytes} bytes were dropped; the report is incomplete`;
    } else if (stdout.trim() !== "") {
      try {
        childReport = JSON.parse(stdout);
      } catch (error) {
        childReportError = `the child's stdout was not one JSON document: ${error.message}`;
      }
    } else if (outcome === "measured") {
      childReportError = "the child exited 0 but wrote no report";
    }
    if (
      childReportError === null
      && !parent.report_collection.stdout_closed
      && parent.report_collection.note !== null
    ) {
      // Not fatal by itself, and it can still parse; but the reader must know
      // the document was taken from a stream that had not finished delivering.
      childReportError = parent.report_collection.note;
    }

    let finalOutcome = outcome;
    if (finalOutcome === "measured" && (childReport === null || childReport.measurement_completed !== true)) {
      finalOutcome = "child-failed";
    }

    const document = {
      spike: "overlapped-stdio",
      schema: 1,
      outcome: finalOutcome,
      question:
        "can a Go child spawned from Electron main with Node 'overlapped' stdio use additional "
        + "inherited stdio pipes (slot 3 and up) as duplex planes with deadlines and close cancellation",
      harness_error: harnessError ?? null,
      child_binary: childPath,
      child_exit: childExit,
      child_report_error: childReportError,
      environment: environmentProvenance(),
      go_version: childReport?.go_version ?? null,
      parent_observations: parent,
      child_report: childReport,
      child_stdout_dropped_bytes: stdoutDroppedBytes,
      child_stderr_tail: stderrTail,
      child_stderr_dropped_lines: stderrDroppedLines,
    };

    let wrote = null;
    if (artifactPath !== undefined) {
      const resolved = path.resolve(process.cwd(), artifactPath);
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, `${JSON.stringify(document, null, 2)}\n`);
        wrote = resolved;
      } catch (error) {
        console.log(`FAIL: could not write the evidence artifact to ${resolved}: ${error.message}`);
        console.log(JSON.stringify(document, null, 2));
        app.exit(1);
        return;
      }
    } else {
      console.log(JSON.stringify(document, null, 2));
    }

    console.log(`outcome: ${finalOutcome}`);
    if (wrote !== null) console.log(`evidence: ${wrote}`);
    if (childReport?.verdict !== undefined) {
      console.log(`verdict: ${JSON.stringify(childReport.verdict)}`);
    }

    if (harnessError !== null && harnessError !== undefined) {
      console.log(`FAIL: ${harnessError}`);
      app.exit(1);
      return;
    }
    if (requireMeasurement && finalOutcome !== "measured") {
      console.log(`FAIL: --require-measurement was passed and the outcome is "${finalOutcome}"`);
      app.exit(1);
      return;
    }
    app.exit(0);
  };

  if (!fs.existsSync(childPath)) {
    finish("child-failed", `no spike binary at ${childPath}. Build it with \`go build -o <path> ./cmd/spike-overlapped-stdio\` from bridge/.`);
    return;
  }

  watchdog = setTimeout(() => {
    finish("timeout", `the run did not finish within ${HARNESS_DEADLINE_MS}ms`);
  }, HARNESS_DEADLINE_MS);

  try {
    child = spawn(childPath, [], {
      stdio: parent.stdio_request,
      windowsHide: true,
    });
  } catch (error) {
    finish("child-failed", `spawn failed: ${error.message}`);
    return;
  }

  // WHAT NODE ACTUALLY PRODUCED per slot, recorded before anything is driven.
  // Rule 10: the runtime is the specification, so the request above is not
  // evidence of what exists.
  for (let i = 0; i < parent.stdio_request.length; i += 1) {
    const stream = child.stdio[i];
    parent.stdio_slots.push({
      index: i,
      requested: parent.stdio_request[i],
      present: stream !== null && stream !== undefined,
      constructor: stream?.constructor?.name ?? null,
      readable: stream?.readable ?? null,
      writable: stream?.writable ?? null,
    });
  }

  child.on("error", (error) => finish("child-failed", `child process error: ${error.message}`));

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    // Bounded retention (rule 05): the report is a few kilobytes, so anything
    // past the cap is a broken instrument. The overflow is COUNTED and
    // reported, never silently discarded.
    const bytes = Buffer.byteLength(chunk, "utf8");
    if (stdoutRetainedBytes + bytes <= STDOUT_CAP_BYTES) {
      stdout += chunk;
      stdoutRetainedBytes += bytes;
    } else {
      stdoutDroppedBytes += bytes;
    }
  });

  /**
   * THE REAL COMPLETION SIGNAL FOR THE REPORT. 'exit' says the process died,
   * not that its stdout was delivered: the child's ONE JSON document can still
   * be in the pipe when 'exit' fires, and parsing then yields a truncated
   * document or none at all. So the report is read only after stdout has ended
   * or closed. This promise carries NO timer of its own; the bound is applied
   * at exit (STDIO_GRACE_MS), where it belongs, because a timer armed at spawn
   * would expire during the measurement and put the harness right back to
   * reading an open stream.
   */
  const stdoutClosed = new Promise((resolve) => {
    child.stdout.on("end", resolve);
    child.stdout.on("close", resolve);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail += chunk;
    const tailLines = stderrTail.split("\n");
    if (tailLines.length > STDERR_TAIL_LINES) {
      stderrDroppedLines += tailLines.length - STDERR_TAIL_LINES;
      stderrTail = tailLines.slice(-STDERR_TAIL_LINES).join("\n");
    }
    stderrLineBuffer += chunk;
    const lines = stderrLineBuffer.split("\n");
    stderrLineBuffer = lines.pop() ?? "";
    if (stderrLineBuffer.length > STDERR_PARTIAL_LINE_CAP) {
      // An NDJSON line this long is not a progress event, and holding it would
      // grow without bound. Dropped, counted, and visible in the artifact.
      stderrDroppedLines += 1;
      stderrLineBuffer = "";
    }
    for (const line of lines) {
      if (line.trim() === "") continue;
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // A plain diagnostic line, kept in the tail and not a control event.
      }
      parent.events.push(event);
      onChildEvent(event);
    }
  });

  child.on("exit", (code, signal) => {
    childExit = { code, signal };
    let outcome = "child-failed";
    if (code === 0) {
      outcome = "measured";
    } else if (code === CHILD_EXIT_UNSUPPORTED && process.platform !== "win32") {
      outcome = "unsupported-platform";
    }
    // ONE completion path, and every wait on it is bounded. The drain of the
    // unread plane is awaited alongside stdout because it is a parent-side
    // OBSERVATION that must be complete before the document is published; its
    // own window plus the interlock write is its bound.
    Promise.all([
      bounded(stdoutClosed, STDIO_GRACE_MS).then((how) => {
        parent.report_collection.stdout_closed = how === "settled";
        parent.report_collection.note = how === "settled"
          ? null
          : `the child's stdout had not closed ${STDIO_GRACE_MS}ms after the process exited, so the `
            + "report was read from a stream that was still open and may be incomplete";
      }),
      bounded(drainSettled, DRAIN_MS + HANDSHAKE_WRITE_MS + 1_000),
    ]).then(
      () => finish(outcome, null),
      (error) => finish(outcome, `settling the child's streams failed: ${error.message}`),
    );
  });

  // -------------------------------------------------------------------------
  // the planes
  // -------------------------------------------------------------------------

  const planeA = child.stdio[PLANE_DUPLEX];
  const planeB = child.stdio[PLANE_KEEPALIVE];
  const planeC = child.stdio[PLANE_UNREAD];
  const planeD = child.stdio[PLANE_CLOSE_CANCEL];

  // On a platform where the extra slots did not materialize there is nothing
  // to drive; the child will say so and this harness records it.
  if (planeA === null || planeA === undefined) return;

  let duplexBuffer = "";
  let throughputStart = null;

  planeA.on("data", (chunk) => {
    if (!parent.duplex.child_marker_seen) {
      duplexBuffer += chunk.toString("latin1");
      if (duplexBuffer.includes(CHILD_DUPLEX_MARKER)) {
        parent.duplex.child_marker_seen = true;
        // The reply is what releases the child's PENDING read, so it is
        // written the instant the marker lands.
        planeA.write(PARENT_DUPLEX_MARKER, (error) => {
          parent.duplex.reply_written = error === null || error === undefined;
          parent.duplex.reply_error = error?.message ?? null;
        });
        const after = duplexBuffer.slice(duplexBuffer.indexOf(CHILD_DUPLEX_MARKER) + CHILD_DUPLEX_MARKER.length);
        parent.throughput.bytes_received += Buffer.byteLength(after, "latin1");
      }
      return;
    }
    parent.throughput.bytes_received += chunk.length;
  });
  planeA.on("error", (error) => {
    parent.throughput.error = `plane ${PLANE_DUPLEX}: ${error.message}`;
  });

  if (planeB !== null && planeB !== undefined) {
    planeB.on("data", (chunk) => {
      parent.keepalive.frames_echoed += 1;
      parent.keepalive.bytes_echoed += chunk.length;
      planeB.write(chunk, (error) => {
        if (error) parent.keepalive.error = error.message;
      });
    });
    planeB.on("error", (error) => {
      parent.keepalive.error = error.message;
    });
  }

  // PLANE C IS NEVER RESUMED until the child says the stall is over. A Node
  // socket does not read until something asks it to, so leaving it paused with
  // no 'data' listener is exactly the "parent stopped reading" condition the
  // child is measuring against.
  if (planeC !== null && planeC !== undefined) {
    planeC.pause();
    planeC.on("error", (error) => {
      parent.unread_plane.drain_error = error.message;
    });
  }

  if (planeD !== null && planeD !== undefined) {
    planeD.on("end", () => {
      parent.close_cancel_plane.ended = true;
    });
    planeD.on("error", (error) => {
      parent.close_cancel_plane.error = error.message;
    });
  }

  // -------------------------------------------------------------------------
  // choreography
  // -------------------------------------------------------------------------

  /**
   * The DECISION lives in choreography.mjs, which is pure and unit-tested
   * (choreography.test.mjs, `node --test`); this function only performs what it
   * decided. The split exists because the first Windows run lost a whole
   * direction to an event-ordering assumption that no Electron-bound harness
   * could have been tested against.
   */
  const choreography = createChoreography();

  function onChildEvent(event) {
    for (const action of choreography.onEvent(event)) {
      switch (action.type) {
        case ACTION_RECORD_THROUGHPUT_REQUEST:
          parent.throughput.requested_bytes = action.totalBytes;
          break;
        case ACTION_START_THROUGHPUT_WRITE:
          startThroughputWrite(action.totalBytes);
          break;
        case ACTION_RECORD_THROUGHPUT_ERROR:
          if (parent.throughput.error === null) parent.throughput.error = action.message;
          break;
        case ACTION_END_THROUGHPUT_PHASE:
          parent.throughput.elapsed_ms = throughputStart === null ? null : Date.now() - throughputStart;
          break;
        case ACTION_DRAIN_UNREAD_PLANE:
          drainUnreadPlane();
          break;
        default:
          // An action this harness does not implement is a defect in the pair,
          // and it is recorded rather than ignored.
          parent.throughput.error = `unimplemented choreography action: ${action.type}`;
          break;
      }
    }
  }

  function startThroughputWrite(totalBytes) {
    throughputStart = Date.now();
    const chunk = Buffer.alloc(THROUGHPUT_CHUNK, "vex-spike-throughput-");
    let remaining = totalBytes;

    const pump = () => {
      while (remaining > 0) {
        const size = Math.min(THROUGHPUT_CHUNK, remaining);
        remaining -= size;
        parent.throughput.bytes_written += size;
        const more = planeA.write(chunk.subarray(0, size));
        if (!more && remaining > 0) {
          parent.throughput.write_returned_false += 1;
          const waitStart = Date.now();
          planeA.once("drain", () => {
            parent.throughput.drain_waits_ms += Date.now() - waitStart;
            pump();
          });
          return;
        }
      }
    };
    pump();
  }

  /**
   * Measurement 7's parent half, and the OTHER end of the child's exit
   * interlock (`awaitParentDrain` in main_windows.go).
   *
   * The bytes the operating system buffered behind a parent that stopped
   * reading are only countable while the WRITER is still alive: a child that
   * exits first tears the pipe down and the count becomes a number about
   * teardown rather than about the platform's buffer. So the child parks on a
   * read of plane 5 after the stall, and this drain ends by writing the one
   * marker that releases it. The write is bounded; a marker that cannot be
   * delivered is recorded, and the child's own bound then reports its result as
   * untrustworthy rather than hanging.
   */
  function drainUnreadPlane() {
    if (planeC === null || planeC === undefined) return;
    // How much the operating system had actually buffered behind a parent that
    // stopped reading. This is the number the credit window has to respect.
    planeC.on("data", (chunk) => {
      parent.unread_plane.bytes_drained_after_stall += chunk.length;
    });
    parent.unread_plane.resumed_after_stall = true;
    planeC.resume();
    drainSettled = new Promise((resolve) => {
      armTimer(DRAIN_MS, () => {
        planeC.pause();
        releaseChildFromDrainWait().then(resolve, resolve);
      });
    });
  }

  function releaseChildFromDrainWait() {
    return new Promise((resolve) => {
      let done = false;
      const settle = (error) => {
        if (done) return;
        done = true;
        parent.unread_plane.drain_marker_written = error === null;
        parent.unread_plane.drain_marker_error = error;
        resolve();
      };
      const bound = armTimer(HANDSHAKE_WRITE_MS, () =>
        settle(`the drain marker was not flushed within ${HANDSHAKE_WRITE_MS}ms`));
      try {
        planeC.write(PARENT_DRAINED_MARKER, (error) => {
          clearTimeout(bound);
          timers.delete(bound);
          settle(error === null || error === undefined ? null : error.message);
        });
      } catch (error) {
        clearTimeout(bound);
        timers.delete(bound);
        settle(error.message);
      }
    });
  }
}

app.whenReady().then(run, (error) => {
  console.log(`FAIL: Electron did not become ready: ${error.stack ?? error}`);
  app.exit(1);
});
