/**
 * SPAWN VALIDATION as a table, and EXIT SEQUENCING as a clock.
 *
 * Both exist because their failure modes are indistinguishable from working
 * software until a user hits them:
 *
 *  - a missing cwd or unresolvable shell without validation becomes a native
 *    exception from node-pty whose message names a path and helps nobody;
 *  - an exit fired before trailing output has flushed silently eats the last
 *    line of every build, which is the line people actually read.
 */

import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_DATA_FLUSH_TIMEOUT_MS,
  TERMINAL_KILL_SETTLE_MS,
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  type TerminalProperty,
} from "@shared/schemas/terminal.js";
import { TerminalProcess } from "../terminal-process.js";
import { ScriptedPty, fakeProbe, scriptedSpawner } from "./scripted-pty.js";

const CWD = "/projects/demo";
const SHELL = "/bin/bash";

function build(options: {
  probe: ReturnType<typeof fakeProbe>;
  pty?: ScriptedPty;
  executable?: string;
  cwd?: string;
  sinks?: Partial<{
    onData: (data: string) => void;
    onProperty: (change: TerminalProperty) => void;
    onExit: (exitCode: number, signal: number | null) => void;
  }>;
}): { process: TerminalProcess; pty: ScriptedPty } {
  const pty = options.pty ?? new ScriptedPty();
  const process = new TerminalProcess(
    {
      executable: options.executable ?? "bash",
      args: [],
      cwd: options.cwd ?? CWD,
      projectLabel: "proj",
      cols: 80,
      rows: 24,
      env: {},
    },
    {
      spawn: scriptedSpawner(pty).spawn,
      probe: options.probe,
      baseEnv: { PATH: "/usr/bin" },
      scrollbackRows: 1000,
      platform: "linux",
    },
    {
      onData: options.sinks?.onData ?? (() => {}),
      onProperty: options.sinks?.onProperty ?? (() => {}),
      onExit: options.sinks?.onExit ?? (() => {}),
    },
  );
  return { process, pty };
}

describe("spawn validation", () => {
  it.each([
    [
      "a starting directory that does not exist",
      fakeProbe({ files: [SHELL], executables: { bash: SHELL } }),
      "launch_cwd_missing",
    ],
    [
      "a starting directory that is a FILE",
      fakeProbe({ files: [CWD, SHELL], executables: { bash: SHELL } }),
      "launch_cwd_not_directory",
    ],
    [
      "a shell that resolves nowhere",
      fakeProbe({ directories: [CWD] }),
      "launch_executable_missing",
    ],
    [
      "a shell that resolves to something that is not a file",
      fakeProbe({
        directories: [CWD, "/usr/lib/notashell"],
        executables: { bash: "/usr/lib/notashell" },
      }),
      "launch_executable_not_file",
    ],
  ])("refuses %s with %s", async (_label, probe, code) => {
    const { process, pty } = build({ probe });
    const started = await process.start();

    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    expect(started.code).toBe(code);
    // NOTHING was spawned. A refusal that had already forked a process would
    // leave an orphan behind on every bad configuration.
    expect(pty.writes).toEqual([]);
    expect(pty.killed).toBe(false);
    process.dispose();
  });

  it("refuses a native spawn failure as launch_spawn_failed rather than throwing", async () => {
    const process = new TerminalProcess(
      { executable: "bash", args: [], cwd: CWD, projectLabel: "proj", cols: 80, rows: 24, env: {} },
      {
        spawn: () => {
          throw new Error("A native exception occurred during launch");
        },
        probe: fakeProbe({
          directories: [CWD],
          files: [SHELL],
          executables: { bash: SHELL },
        }),
        baseEnv: {},
        scrollbackRows: 1000,
        platform: "linux",
      },
      { onData: () => {}, onProperty: () => {}, onExit: () => {} },
    );

    const started = await process.start();
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    expect(started.code).toBe("launch_spawn_failed");
    process.dispose();
  });

  it("spawns the ABSOLUTE resolved executable, not the name it was given", async () => {
    const pty = new ScriptedPty();
    const spawner = scriptedSpawner(pty);
    const process = new TerminalProcess(
      { executable: "bash", args: ["-i"], cwd: CWD, projectLabel: "proj", cols: 80, rows: 24, env: {} },
      {
        spawn: spawner.spawn,
        probe: fakeProbe({
          directories: [CWD],
          files: [SHELL],
          executables: { bash: SHELL },
        }),
        baseEnv: { PATH: "/usr/bin" },
        scrollbackRows: 1000,
        platform: "linux",
      },
      { onData: () => {}, onProperty: () => {}, onExit: () => {} },
    );

    const started = await process.start();
    expect(started.ok).toBe(true);
    // node-pty must never search PATH a second time with an environment we did
    // not validate against.
    expect(spawner.calls[0]?.executable).toBe(SHELL);
    expect(spawner.calls[0]?.args).toEqual(["-i"]);
    if (started.ok) expect(started.shellName).toBe("bash");
    process.dispose();
  });
});

describe("exit sequencing", () => {
  const goodProbe = fakeProbe({
    directories: [CWD],
    files: [SHELL],
    executables: { bash: SHELL },
  });

  it("captures trailing output emitted within the flush window BEFORE announcing exit", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const order: string[] = [];
      const { process, pty } = build({
        probe: goodProbe,
        sinks: {
          onData: (data) => {
            seen.push(data);
            order.push("data");
          },
          onExit: () => order.push("exit"),
        },
      });
      await process.start();

      pty.exit(0);
      // node-pty issue #72: data can arrive AFTER the exit event. Emitting at
      // 200 ms restarts the 250 ms window, which is the behaviour under test.
      await vi.advanceTimersByTimeAsync(200);
      pty.emit("the last line of the build\r\n");
      await vi.advanceTimersByTimeAsync(200);
      expect(order).not.toContain("exit");

      await vi.advanceTimersByTimeAsync(TERMINAL_DATA_FLUSH_TIMEOUT_MS + 10);

      expect(seen.join("")).toContain("the last line of the build");
      expect(order[order.length - 1]).toBe("exit");
      expect(pty.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-kills a process that keeps writing past the maximum shutdown time", async () => {
    vi.useFakeTimers();
    try {
      let exits = 0;
      const { process, pty } = build({
        probe: goodProbe,
        sinks: { onExit: () => (exits += 1) },
      });
      await process.start();

      process.shutdown(false);
      // A program that emits every 100 ms restarts the flush window forever.
      for (let tick = 0; tick < 60; tick += 1) {
        await vi.advanceTimersByTimeAsync(100);
        pty.emit("still going\r\n");
      }

      // The backstop fired at 5000 ms regardless, which is the whole point.
      expect(pty.killed).toBe(true);
      expect(exits).toBe(1);
      expect(TERMINAL_MAXIMUM_SHUTDOWN_MS).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces exit exactly once even when shutdown races the pty's own exit", async () => {
    vi.useFakeTimers();
    try {
      let exits = 0;
      const { process, pty } = build({
        probe: goodProbe,
        sinks: { onExit: () => (exits += 1) },
      });
      await process.start();

      pty.exit(3);
      process.shutdown(true);
      await vi.advanceTimersByTimeAsync(TERMINAL_MAXIMUM_SHUTDOWN_MS + 100);

      expect(exits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * THE WINDOWS DEFERRED PID.
 *
 * node-pty >= 1.2.0-beta.11 defers ConPTY's `connect()`, so `pty.pid` is `0`
 * from the spawn call until the conout worker is ready
 * (`windowsPtyAgent.js:39` and `:134`, copied into the terminal at
 * `windowsTerminal.js:62` and refreshed at `:67-69`). Reading it once, at
 * spawn - which is what this host did - published `0` to main and the renderer
 * for the entire life of every Windows terminal, and handed `0` to the cwd
 * probe on every Enter keystroke.
 *
 * These run with a `platform: "linux"` process on purpose: the DEFERRAL, not the
 * operating system, is the contract, and a fake that answers `0` is the only way
 * to exercise it deterministically anywhere. `real-pty.test.ts` on a Windows
 * lane is what proves the deferral actually resolves against ConPTY.
 */
describe("the pid, when node-pty does not have one yet", () => {
  const goodProbe = fakeProbe({
    directories: [CWD],
    files: [SHELL],
    executables: { bash: SHELL },
  });

  it("emits the pid property on the FIRST DATA EVENT, once, and never emits 0", async () => {
    const pty = new ScriptedPty();
    pty.deferPid();
    const properties: TerminalProperty[] = [];
    const { process } = build({
      probe: goodProbe,
      pty,
      sinks: { onProperty: (change) => properties.push(change) },
    });

    const started = await process.start();

    // Nothing was published, because there was nothing true to publish.
    expect(properties.filter((change) => change.property === "pid")).toEqual([]);
    // The create reply answers immediately and carries the best-effort echo.
    // Blocking it on the pid would make creating a terminal wait for the shell
    // to produce output, which a silent shell never does.
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.pid).toBe(0);

    // ConPTY connected; the first byte of the shell's prompt follows it.
    pty.resolvePid(31_337);
    pty.emit("$ ");

    expect(properties.filter((change) => change.property === "pid")).toEqual([
      { property: "pid", value: 31_337 },
    ]);

    // A second chunk does not re-announce a value that cannot have changed.
    pty.emit("ls\r\n");
    expect(properties.filter((change) => change.property === "pid")).toHaveLength(1);

    process.dispose();
  });

  it("keeps waiting when the first data event still has no pid, rather than publishing 0", async () => {
    const pty = new ScriptedPty();
    pty.deferPid();
    const properties: TerminalProperty[] = [];
    const { process } = build({
      probe: goodProbe,
      pty,
      sinks: { onProperty: (change) => properties.push(change) },
    });
    await process.start();

    pty.emit("early\r\n");
    expect(properties.filter((change) => change.property === "pid")).toEqual([]);

    pty.resolvePid(99);
    pty.emit("late\r\n");
    expect(properties.filter((change) => change.property === "pid")).toEqual([
      { property: "pid", value: 99 },
    ]);

    process.dispose();
  });

  it("emits the pid at spawn when node-pty already has one", async () => {
    const properties: TerminalProperty[] = [];
    const { process } = build({
      probe: goodProbe,
      sinks: { onProperty: (change) => properties.push(change) },
    });

    await process.start();

    // The Unix path is unchanged: no data event is required for the pid to be
    // known, and none is waited for.
    expect(properties.filter((change) => change.property === "pid")).toEqual([
      { property: "pid", value: 4242 },
    ]);
    process.dispose();
  });

  it("NEVER asks the cwd probe about pid 0", async () => {
    const askedFor: number[] = [];
    const probe = {
      ...goodProbe,
      readCwd: (pid: number) => {
        askedFor.push(pid);
        return goodProbe.readCwd(pid);
      },
    };
    const pty = new ScriptedPty();
    pty.deferPid();
    const properties: TerminalProperty[] = [];
    const { process } = build({
      probe,
      pty,
      sinks: { onProperty: (change) => properties.push(change) },
    });

    await process.start();
    // The trigger path, not only the one on ready: a user pressing Enter is
    // what would have run `lsof -p 0` once per keystroke, per terminal.
    await process.refreshCwd();
    expect(askedFor).toEqual([]);

    // "The pid is not known yet" and "the cwd could not be read" are the same
    // fact, and the answer to both is to leave the label alone - which for a
    // shell that has not moved is still the directory it was launched in. On
    // Windows this is the ordinary steady state, not a failure.
    expect(properties).toContainEqual({ property: "displayCwd", value: "proj" });

    pty.resolvePid(4242);
    await process.refreshCwd();
    expect(askedFor).toEqual([4242]);

    process.dispose();
  });
});

/**
 * A DATA-SOCKET ERROR IS A DEAD TERMINAL, NOT A DEAD HOST.
 *
 * node-pty's socket error handler rethrows anything it does not classify as
 * ordinary, unless the socket carries a second `error` listener
 * (`windowsTerminal.js:90-104`, `unixTerminal.js:101-127`), and it registers
 * none itself (`terminal.js:90-94` forwards `data` and `exit` only). The
 * production spawner registers that listener; this is the other half - what the
 * host does once the error is an event instead of an exception.
 */
describe("a pty whose data socket fails", () => {
  const goodProbe = fakeProbe({
    directories: [CWD],
    files: [SHELL],
    executables: { bash: SHELL },
  });

  it("ends the terminal on the ordinary exit route instead of propagating", async () => {
    vi.useFakeTimers();
    try {
      const exits: Array<{ exitCode: number; signal: number | null }> = [];
      const { process, pty } = build({
        probe: goodProbe,
        sinks: { onExit: (exitCode, signal) => exits.push({ exitCode, signal }) },
      });
      await process.start();

      // Nothing escapes the callback. An exception here is a pty host that
      // dies, taking every terminal in every project with it.
      expect(() => {
        pty.failSocket(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      }).not.toThrow();

      // Still the flush window: output already in flight reaches the consumer
      // before the exit, exactly as for a shell that exited on its own.
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(TERMINAL_DATA_FLUSH_TIMEOUT_MS + 10);

      // ONE exit, and the terminal is gone. Without this route the terminal
      // would sit in the workspace forever with a socket nothing can read.
      expect(exits).toHaveLength(1);
      expect(pty.killed).toBe(true);
      expect(process.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the failure code when the pty never manages to report an exit", async () => {
    vi.useFakeTimers();
    try {
      const exits: Array<{ exitCode: number; signal: number | null }> = [];
      const { process, pty } = build({
        probe: goodProbe,
        sinks: { onExit: (exitCode, signal) => exits.push({ exitCode, signal }) },
      });
      await process.start();

      // The process that will not die: the kill lands, the OS never reports the
      // exit, and the settle bound is what ends the wait. This is the only case
      // in which the failure code is the code the consumer sees - a pty that
      // does report an exit reports a real one, and that one wins.
      pty.ignoresKill = true;
      pty.failSocket(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      await vi.advanceTimersByTimeAsync(
        TERMINAL_DATA_FLUSH_TIMEOUT_MS + TERMINAL_KILL_SETTLE_MS + 50,
      );

      // node-pty's own code for a pty that failed rather than exited.
      expect(exits).toEqual([{ exitCode: -1, signal: null }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a REAL exit code win over the failure code when the pty also reports one", async () => {
    vi.useFakeTimers();
    try {
      const exits: number[] = [];
      const { process, pty } = build({
        probe: goodProbe,
        sinks: { onExit: (exitCode) => exits.push(exitCode) },
      });
      await process.start();

      pty.exit(3);
      pty.failSocket(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      await vi.advanceTimersByTimeAsync(TERMINAL_DATA_FLUSH_TIMEOUT_MS + 10);

      // The shell said 3. An error arriving alongside it must not overwrite the
      // one fact the user's script actually reported.
      expect(exits).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces exactly one exit when the socket fails after the terminal already exited", async () => {
    vi.useFakeTimers();
    try {
      let exits = 0;
      const { process, pty } = build({
        probe: goodProbe,
        sinks: { onExit: () => (exits += 1) },
      });
      await process.start();

      pty.exit(0);
      await vi.advanceTimersByTimeAsync(TERMINAL_DATA_FLUSH_TIMEOUT_MS + 10);
      expect(exits).toBe(1);

      pty.failSocket(new Error("read EIO"));
      await vi.advanceTimersByTimeAsync(TERMINAL_DATA_FLUSH_TIMEOUT_MS + 10);
      expect(exits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resize discipline", () => {
  const goodProbe = fakeProbe({
    directories: [CWD],
    files: [SHELL],
    executables: { bash: SHELL },
  });

  it("clamps to >= 1 and DROPS a no-op resize", async () => {
    const { process, pty } = build({ probe: goodProbe });
    await process.start();

    process.resize(0, 0);
    expect(pty.resizes).toEqual([{ cols: 1, rows: 1 }]);

    // The same dimensions again reach the pty zero more times: a drag that
    // emits the same size on every frame must not become a resize storm.
    process.resize(1, 1);
    process.resize(1, 1);
    expect(pty.resizes).toHaveLength(1);

    process.dispose();
  });

  it("applies rows immediately and DEBOUNCES columns once the buffer is tall", async () => {
    const { process, pty } = build({ probe: goodProbe });
    await process.start();
    // Make the buffer taller than the debounce threshold. This runs on REAL
    // timers: xterm's write callback is scheduled on the event loop, so
    // draining it under fake timers would wait for a clock nothing advances.
    pty.emit("line\r\n".repeat(400));
    await process.mirror.drain();

    vi.useFakeTimers();
    try {
      pty.resizes.length = 0;
      process.resize(120, 40);

      // Rows landed at once, columns did not.
      expect(pty.resizes).toEqual([{ cols: 80, rows: 40 }]);

      await vi.advanceTimersByTimeAsync(150);
      expect(pty.resizes[pty.resizes.length - 1]).toEqual({ cols: 120, rows: 40 });

      process.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
