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
    if (process.platform === "win32") {
      // Windows has no POSIX signals: `kill()` is TerminateProcess, so Node
      // reports a plain exit code and `signal: null`. Asserting a name here
      // would be asserting a POSIX detail the platform cannot produce.
      expect(result.signal).toBeNull();
    } else {
      expect(result.signal).toBe("SIGTERM");
    }
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
   * waits for ever. This is the Linux-reproducible form of the win32 lane's
   * 15 s abort timeout. The abandoned output is REPORTED, never silently
   * presented as a complete stream.
   */
  it("settles when a surviving descendant still holds the child's pipes", async () => {
    const ac = new AbortController();
    const result = await runSpawn(
      process.execPath,
      [
        "-e",
        "require('child_process').spawn(process.execPath, "
          + "['-e', 'setTimeout(() => {}, 6000)'], "
          + "{ stdio: ['ignore', 'inherit', 'inherit'] }); "
          + "setInterval(() => {}, 1000); process.stdout.write('ready\\n')",
      ],
      {
        signal: ac.signal,
        gracePeriodMs: 200,
        onStdoutLine: (line) => {
          if (line === "ready") ac.abort();
        },
      }
    );
    expect(result.aborted).toBe(true);
    expect(result.stderr).toContain("[stdio abandoned:");
  }, 20_000);
});
