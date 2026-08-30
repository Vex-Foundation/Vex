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
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
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
    onExit: (exitCode: number, signal: number | null) => void;
  }>;
}): { process: TerminalProcess; pty: ScriptedPty } {
  const pty = options.pty ?? new ScriptedPty();
  const process = new TerminalProcess(
    {
      executable: options.executable ?? "bash",
      args: [],
      cwd: options.cwd ?? CWD,
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
      onProperty: () => {},
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
      { executable: "bash", args: [], cwd: CWD, cols: 80, rows: 24, env: {} },
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
      { executable: "bash", args: ["-i"], cwd: CWD, cols: 80, rows: 24, env: {} },
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
