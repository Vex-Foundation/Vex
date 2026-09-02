/**
 * Smoke tests for the long-running spawn helper. Uses Node's `printf`
 * surrogate (`node -e`) to keep the test suite portable across CI.
 */

import { describe, expect, it } from "vitest";
import { runSpawn } from "../spawn-runner.js";

function stdoutCommand(): { readonly command: string; readonly args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "echo a&&echo b&&echo c"],
    };
  }
  return { command: "printf", args: ["a\nb\nc\n"] };
}

function stderrCommand(): { readonly command: string; readonly args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      // No space before the redirection: `echo boom 1>&2` echoes "boom "
      // (cmd.exe treats everything up to the operator as the echoed text),
      // which would make this assert on a fixture artefact rather than on
      // the runner's stderr framing.
      args: ["/d", "/s", "/c", "echo boom>&2&&exit /b 7"],
    };
  }
  return { command: "sh", args: ["-c", "printf 'boom\\n' >&2; exit 7"] };
}

/**
 * A long-running DIRECT child, spawned through `process.execPath` so the
 * subject stays the runner's cancellation contract on all three lanes.
 *
 * The win32 fixture used to be `cmd.exe /c "ping -n 30 ..."`, which put a shell
 * between the runner and the process holding the pipes: `child.kill()` reaches
 * TerminateProcess on `cmd.exe` alone (VS Code shells out to `taskkill /T` in
 * `src/vs/base/node/processes.ts` for exactly this reason), `ping.exe` survived
 * holding the inherited stdout/stderr, `close` never fired and the case failed
 * as a 15 s timeout. That is a real property of process trees and it now has
 * its own test below; this one asserts the plain abort path.
 */
function hangCommand(): { readonly command: string; readonly args: string[] } {
  return {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  };
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 delivers nothing and only asks whether the pid exists; libuv
    // implements it on Windows too (`uv__kill` answers with a liveness check
    // instead of TerminateProcess for signum 0).
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kill a process this test deliberately made outlive its parent, then WAIT for
 * the world to agree it is gone. Returns the pids still alive at the deadline,
 * so the caller fails the run over a leak rather than the run leaking quietly.
 */
async function reap(
  pid: number | undefined,
  timeoutMs = 10_000
): Promise<number[]> {
  if (pid === undefined) return [];
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone, or never started. Both are the goal state.
  }
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await delay(25);
  }
  return isAlive(pid) ? [pid] : [];
}

describe("runSpawn", () => {
  it("captures stdout via line callback and final stdout buffer", async () => {
    const lines: string[] = [];
    const command = stdoutCommand();
    const result = await runSpawn(
      command.command,
      command.args,
      { onStdoutLine: (line) => lines.push(line) }
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(lines).toEqual(["a", "b", "c"]);
    expect(result.aborted).toBe(false);
  });

  it("captures stderr separately", async () => {
    const errLines: string[] = [];
    const command = stderrCommand();
    const result = await runSpawn(
      command.command,
      command.args,
      { onStderrLine: (line) => errLines.push(line) }
    );
    expect(result.code).toBe(7);
    expect(errLines).toEqual(["boom"]);
  });

  /**
   * The CRLF producer is spawned through `process.execPath` so this runs
   * identically on all three lanes rather than only where the console
   * builtins happen to emit `\r\n`. A `\r` left on the line would reach
   * consumers as part of a container id, a context name or a renderer log
   * row, so it is stripped as framing - while a bare `\r` INSIDE a line
   * (progress redraws) must survive.
   */
  it("treats the CR of a CRLF terminator as framing, not as line content", async () => {
    const lines: string[] = [];
    const result = await runSpawn(
      process.execPath,
      ["-e", `process.stdout.write("a\\r\\nb\\rmid\\r\\n")`],
      { onStdoutLine: (line) => lines.push(line) }
    );
    expect(result.code).toBe(0);
    expect(lines).toEqual(["a", "b\rmid"]);
    expect(result.stdout).toBe("a\nb\rmid\n");
  });

  it("honors AbortSignal and reports aborted=true", async () => {
    const ac = new AbortController();
    const command = hangCommand();
    const promise = runSpawn(
      command.command,
      command.args,
      { signal: ac.signal, gracePeriodMs: 200 }
    );
    setTimeout(() => ac.abort(), 50);
    const result = await promise;
    // `aborted` is the runner's OWN decision, so it holds on every platform.
    expect(result.aborted).toBe(true);
    // The four outcomes stay distinct: this run was cancelled by its caller,
    // it did not hit a deadline.
    expect(result.timedOut).toBe(false);
    // THE REPORTED SIGNAL IS THE NAME WE SENT, ON EVERY PLATFORM - including
    // win32, where the MECHANISM is TerminateProcess but the REPORTING is not
    // lossy. libuv's `uv_process_kill` (src/win/process.c) maps SIGTERM to
    // `TerminateProcess(handle, 1)` and then records `process->exit_signal =
    // signum`; `uv__process_proc_exit` hands that same value back as the
    // exit callback's `term_signal`, Node's `process_wrap.cc` OnExit turns it
    // into a name via `signo_string(term_signal)`, and `internal/child_process`
    // emits it as the `'exit'` event's `signal`. So there is no platform
    // branch to make here: a branch asserting `null` on win32 would be
    // asserting a POSIX intuition the runtime contradicts, which is what the
    // Windows lane measured.
    expect(result.signal).toBe("SIGTERM");
  });

  /**
   * THE ESCALATION IS REACHABLE. The SIGKILL step used to be guarded on
   * `!child.killed`, and `killed` only records that a signal was DELIVERED, so
   * the SIGTERM one line above it disabled the escalation permanently: a child
   * that ignores SIGTERM was never force-killed and `runSpawn` never settled.
   * The child announces itself on stdout before the abort, so the ordering is
   * an observed state transition and not a sleep.
   *
   * POSIX only: on win32 there is no ignorable termination to escalate past -
   * the first `kill()` is already TerminateProcess.
   */
  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL when the child ignores SIGTERM",
    async () => {
      const ac = new AbortController();
      const result = await runSpawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); "
            + "process.stdout.write('ready\\n')",
        ],
        {
          signal: ac.signal,
          gracePeriodMs: 300,
          onStdoutLine: (line) => {
            if (line === "ready") ac.abort();
          },
        }
      );
      expect(result.aborted).toBe(true);
      expect(result.signal).toBe("SIGKILL");
    },
    20_000
  );

  /**
   * A KILLED CHILD IS NOT A KILLED TREE. `close` waits for the stdio pipes as
   * well as the exit, and a descendant that inherited those pipes keeps them
   * open, so the runner has to settle on the exit facts alone or its caller
   * waits for ever. This is the reproducer for the win32 lane's 15 s abort
   * timeout. The abandoned output is REPORTED, never silently presented as a
   * complete stream.
   *
   * WHY THE DESCENDANT IS `detached`, AND WHY THAT IS NOT A TEST TRICK.
   * libuv creates ONE global job object per process on the first spawn, with
   * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and assigns both the current process
   * and every NON-detached child to it (`uv__init_global_job_handle` and the
   * `AssignProcessToJobObject` at the end of `uv_spawn`, src/win/process.c).
   * When our direct child dies, its handle to that job closes, the job closes
   * with it and Windows terminates everything inside - so an ordinary Node
   * grandchild dies WITH the child, its inherited pipe handles close, and the
   * abandoned-stdio path is unreachable by construction. That is what the
   * Windows lane measured: `close` fired normally and `stderr` was empty.
   * A process spawned with `detached` is deliberately NOT assigned to the job
   * (`if (!(options->flags & UV_PROCESS_DETACHED))`, same file), while
   * `CreateProcessW` still passes `bInheritHandles`, so it keeps the child's
   * stdout/stderr open after the child is gone. That is the real shape of the
   * production hazard on Windows - a `docker`/daemon helper that daemonises
   * itself - and it reproduces the same condition POSIX reaches with a plain
   * fork, so ONE test covers all three lanes.
   *
   * The descendant is reaped by pid afterwards: it OUTLIVES the run by design,
   * so unlike the pty suite's leak detector (`real-pty.test.ts`) a survivor
   * here is the subject, not a defect. What must not happen is it outliving
   * the TEST - a process still holding the vitest worker's inherited pipes is
   * how the Windows lane's worker died.
   */
  it("settles when a surviving descendant still holds the child's pipes", async () => {
    const ac = new AbortController();
    let descendantPid: number | undefined;
    let leaked: number[] = [];
    try {
      const result = await runSpawn(
        process.execPath,
        [
          "-e",
          "const gc = require('node:child_process').spawn(process.execPath, "
            + "['-e', 'setTimeout(() => {}, 6000)'], "
            + "{ stdio: ['ignore', 'inherit', 'inherit'], detached: true, "
            + "windowsHide: true }); "
            + "gc.unref(); "
            + "setInterval(() => {}, 1000); "
            + "process.stdout.write('ready ' + gc.pid + '\\n')",
        ],
        {
          signal: ac.signal,
          gracePeriodMs: 200,
          onStdoutLine: (line) => {
            const match = /^ready (\d+)$/.exec(line);
            if (match === null) return;
            descendantPid = Number(match[1]);
            ac.abort();
          },
        }
      );
      expect(result.aborted).toBe(true);
      expect(result.stderr).toContain("[stdio abandoned:");
      // The pid is what proves the fixture built the condition rather than
      // stumbling into an early exit that happened to look the same.
      expect(descendantPid).toBeDefined();
    } finally {
      leaked = await reap(descendantPid);
    }
    expect(leaked).toEqual([]);
  }, 20_000);
});
