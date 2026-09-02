/**
 * Long-running async runner for `docker compose up`, daemon installs,
 * binary downloads, log streaming. Built on `child_process.spawn` so the
 * caller can drain stdout/stderr line-by-line — `execFile` would buffer
 * everything and DoS main when the subprocess emits MBs of progress.
 *
 * Cancellation: pass an `AbortSignal`. We send SIGTERM, then escalate to
 * SIGKILL after `gracePeriodMs` if the process is still alive. Skill §11
 * cleanup contract — every long-running spawn is owned by a registry.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { redact } from "../logger/redact.js";
import { dockerSpawnEnv } from "./cli-env.js";
import { resolveDockerCli } from "./locate.js";
import { withoutManagedSecrets } from "./env-hygiene.js";

export interface SpawnRunnerOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly gracePeriodMs?: number;
  /**
   * Hard upper bound for the spawned process. After this many ms the
   * process gets the same SIGTERM → SIGKILL escalation as `signal` abort.
   * Default: undefined (no extra deadline; only the externally supplied
   * signal terminates the process).
   */
  readonly timeoutMs?: number;
  readonly onStdoutLine?: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
}

export interface SpawnRunnerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly timedOut: boolean;
}

const DEFAULT_GRACE_MS = 5_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // safety cap for accumulated stdout/stderr

/**
 * How long the runner waits for stdout/stderr to close AFTER the child itself
 * has exited, before settling on the exit facts alone.
 *
 * WHY IT EXISTS. `close` fires only once the process has exited AND every
 * stdio pipe has ended. A descendant that inherited those pipes keeps them
 * open after the direct child is gone, so `close` may never arrive: killing a
 * process does not kill its tree, and on Windows it cannot - `child.kill()`
 * reaches TerminateProcess on the direct child only, which is why VS Code
 * shells out to `taskkill /T` in `src/vs/base/node/processes.ts` (`killTree`).
 * Without this bound a cancelled `runSpawn` never reached a terminal state and
 * its caller waited for ever; the Windows CI lane surfaced it as a 15 s test
 * timeout on the abort case.
 *
 * The child's own exit is the authoritative outcome, so the runner reports it
 * and says out loud, on stderr, that the remaining output was abandoned rather
 * than pretending the streams completed.
 */
const STDIO_DRAIN_AFTER_EXIT_MS = 2_000;

/**
 * Line framing is `\n`, and a CRLF producer's `\r` belongs to the framing, not
 * to the line. Windows console builtins (and any CLI whose Go/MSVC runtime
 * translates on a pipe) terminate with `\r\n`, so a reader that split on `\n`
 * alone would hand every consumer a line ending in `\r`: a `docker ps -q`
 * container id, a `docker context show` name, a progress line broadcast to the
 * renderer. Node's own `readline` strips it for the same reason. The `\r` is
 * removed once, only when it is the last character of a `\n`-terminated line,
 * so a lone `\r` inside a line (progress redraws) survives untouched.
 */
function stripLineTerminatorCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

class StreamLineReader {
  private buffer = "";
  private readonly capBytes: number;
  private accumBytes = 0;

  constructor(capBytes: number = MAX_BUFFER_BYTES) {
    this.capBytes = capBytes;
  }

  push(chunk: string, onLine: (line: string) => void): string {
    const safe =
      this.accumBytes + chunk.length > this.capBytes
        ? chunk.slice(0, Math.max(0, this.capBytes - this.accumBytes))
        : chunk;
    this.accumBytes += safe.length;
    this.buffer += safe;
    let out = "";
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = stripLineTerminatorCarriageReturn(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
      onLine(line);
      out += line + "\n";
      idx = this.buffer.indexOf("\n");
    }
    return out;
  }

  flush(onLine: (line: string) => void): string {
    if (this.buffer.length === 0) return "";
    const line = this.buffer;
    this.buffer = "";
    onLine(line);
    return line;
  }
}

export async function runSpawn(
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnRunnerOptions = {}
): Promise<SpawnRunnerResult> {
  const {
    cwd,
    env,
    signal,
    gracePeriodMs = DEFAULT_GRACE_MS,
    onStdoutLine,
    onStderrLine,
  } = options;
  // Every branch strips managed secrets: a caller-supplied env is not
  // trusted to have done so already, `dockerSpawnEnv()` handles the Docker
  // CLI case, and any other helper (open/systemctl/powershell, …) still
  // gets a stripped clone of `process.env` rather than a full inherit.
  const spawnEnv = env
    ? withoutManagedSecrets(env)
    : command === "docker"
      ? dockerSpawnEnv()
      : withoutManagedSecrets(process.env);
  // One owner decides where `docker` lives (`locate.ts`), so every caller -
  // the probe, the endpoint policy inspector, the daemon starter - resolves
  // to the SAME executable instead of each getting whatever a stale PATH
  // snapshot happens to hold. Falling back to the bare name only preserves
  // the previous ENOENT behaviour when nothing was located.
  const spawnCommand =
    command === "docker"
      ? (resolveDockerCli()?.executablePath ?? command)
      : command;

  return new Promise((resolve) => {
    // `aborted` and `timedOut` are the RUNNER'S OWN facts: this code decided to
    // terminate the child. They are never inferred from what the OS reports,
    // because Windows has no POSIX signals - a killed child comes back as
    // `signal: null` plus an exit code there - and the four outcomes
    // (completed, aborted by the caller, timed out, spawn-failed) must stay
    // distinguishable on every platform.
    let aborted = false;
    let timedOut = false;
    let exited = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    const stdoutReader = new StreamLineReader();
    const stderrReader = new StreamLineReader();
    let stdoutAccum = "";
    let stderrAccum = "";
    let stdoutLinesEmitted = 0;
    let stderrLinesEmitted = 0;

    // Codex turn 5 YELLOW #4: redact each line BEFORE invoking the
    // user-supplied callback (those callbacks fan out to renderer event
    // streams). Final stdout/stderr buffers are also redacted at resolve
    // time, but per-line redaction prevents secrets being broadcast in
    // realtime through the event bus.
    const safeOnStdout = onStdoutLine
      ? (line: string): void => onStdoutLine(redact(line) as string)
      : undefined;
    const safeOnStderr = onStderrLine
      ? (line: string): void => onStderrLine(redact(line) as string)
      : undefined;
    const emitStdoutLine = (line: string): void => {
      stdoutLinesEmitted += 1;
      if (safeOnStdout !== undefined) safeOnStdout(line);
    };
    const emitStderrLine = (line: string): void => {
      stderrLinesEmitted += 1;
      if (safeOnStderr !== undefined) safeOnStderr(line);
    };
    const replayLinesIfNeeded = (
      stream: "stdout" | "stderr",
      content: string
    ): void => {
      if (content.length === 0) return;
      if (stream === "stdout" && stdoutLinesEmitted > 0) return;
      if (stream === "stderr" && stderrLinesEmitted > 0) return;
      const lines = content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
      for (const line of lines) {
        if (stream === "stdout") emitStdoutLine(line);
        else emitStderrLine(line);
      }
    };

    const child: ChildProcess = spawn(spawnCommand, [...args], {
      cwd,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      const flushed = stdoutReader.push(chunk, emitStdoutLine);
      stdoutAccum += flushed;
    });
    child.stderr?.on("data", (chunk: string) => {
      const flushed = stderrReader.push(chunk, emitStderrLine);
      stderrAccum += flushed;
    });
    child.stdout?.resume();
    child.stderr?.resume();

    child.on("error", (err: Error) => {
      stderrAccum += stderrReader.flush(emitStderrLine);
      stdoutAccum += stdoutReader.flush(emitStdoutLine);
      const code =
        "code" in err && typeof err.code === "string" ? err.code : "unknown";
      const spawnErrorLine = `[spawn error: ${code}]`;
      stderrAccum += `${spawnErrorLine}\n`;
      emitStderrLine(spawnErrorLine);
    });

    const waitForStreamClose = (
      stream: ChildProcess["stdout"] | ChildProcess["stderr"]
    ): Promise<void> =>
      new Promise((streamResolve) => {
        if (!stream) {
          streamResolve();
          return;
        }
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          streamResolve();
        };
        stream.once("end", settle);
        stream.once("close", settle);
        stream.once("error", settle);
      });
    const stdoutDone = waitForStreamClose(child.stdout);
    const stderrDone = waitForStreamClose(child.stderr);

    /**
     * SIGTERM now, SIGKILL after the grace period if the child is still alive.
     *
     * The liveness guard is our own `exited` flag, NOT `child.killed`:
     * `killed` records that a signal was successfully DELIVERED, not that the
     * process died. Guarding the escalation on `!child.killed` made the SIGKILL
     * branch unreachable - the SIGTERM immediately before it set `killed` -
     * so a child that ignores SIGTERM was never force-killed and the run never
     * terminated. On win32 both names map to TerminateProcess and the first
     * send is already forceful, so only the POSIX path uses the second step.
     */
    const escalateKill = (): void => {
      if (child.pid === undefined || exited) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      if (killTimer !== null) return;
      killTimer = setTimeout(() => {
        killTimer = null;
        if (child.pid === undefined || exited) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, gracePeriodMs);
    };

    const onAbort = (): void => {
      aborted = true;
      escalateKill();
    };
    const onTimeout = (): void => {
      timedOut = true;
      escalateKill();
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(onTimeout, options.timeoutMs);
    }

    /**
     * The single terminal state of the run. `stdioComplete` is false only when
     * the child exited but its pipes stayed open past the drain bound, i.e.
     * output was abandoned; that is reported on stderr rather than hidden, in
     * the same shape as the `[spawn error: ...]` line, so a caller can never
     * mistake an abandoned stream for a complete one.
     */
    const finish = (
      code: number | null,
      sig: NodeJS.Signals | null,
      stdioComplete: boolean
    ): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      stderrAccum += stderrReader.flush(emitStderrLine);
      stdoutAccum += stdoutReader.flush(emitStdoutLine);
      replayLinesIfNeeded("stderr", stderrAccum);
      replayLinesIfNeeded("stdout", stdoutAccum);
      if (!stdioComplete) {
        const abandonedLine =
          "[stdio abandoned: the process exited but a descendant still holds its stdout/stderr]";
        stderrAccum += `${abandonedLine}\n`;
        emitStderrLine(abandonedLine);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        code,
        signal: sig,
        stdout: redact(stdoutAccum) as string,
        stderr: redact(stderrAccum) as string,
        aborted,
        timedOut,
      });
    };

    // The child's own exit is the authoritative outcome. `close` is still the
    // preferred settle point because it also means the output is complete, but
    // it is not guaranteed to arrive (see `STDIO_DRAIN_AFTER_EXIT_MS`), so the
    // exit starts a bounded wait for it.
    child.on("exit", (code, sig) => {
      exited = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (settled || drainTimer !== null) return;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        finish(code, sig, false);
      }, STDIO_DRAIN_AFTER_EXIT_MS);
    });

    child.on("close", (code, sig) => {
      void (async (): Promise<void> => {
        await Promise.all([stdoutDone, stderrDone]);
        finish(code, sig, true);
      })();
    });
  });
}
