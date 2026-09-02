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
    let aborted = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
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

    const escalateKill = (): void => {
      if (child.pid && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        killTimer = setTimeout(() => {
          if (child.pid && !child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, gracePeriodMs);
      }
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

    child.on("close", (code, sig) => {
      void (async (): Promise<void> => {
        await Promise.all([stdoutDone, stderrDone]);
      stderrAccum += stderrReader.flush(emitStderrLine);
      stdoutAccum += stdoutReader.flush(emitStdoutLine);
      replayLinesIfNeeded("stderr", stderrAccum);
      replayLinesIfNeeded("stdout", stdoutAccum);
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: sig,
        stdout: redact(stdoutAccum) as string,
        stderr: redact(stderrAccum) as string,
        aborted,
        timedOut,
      });
      })();
    });
  });
}
