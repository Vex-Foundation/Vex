/**
 * The Postgres tool runner returns once the TOOL exits, even when a process
 * it started keeps its stdout/stderr open. That is `pg_ctl start` on Windows:
 * its `cmd.exe` and the postmaster under it hold the pipes for the life of the
 * server, and waiting for the pipes to close hung the first run forever (the
 * clean-machine gate, win32-x64). Reproduced here with a real process tree.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runPgTool } = await import("../native/postgres-supervisor.js");

const ENV = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

// A tool that prints, leaves a child holding its stdio for 30 s, and exits 0.
const TOOL = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" });
process.stdout.write("started pid " + child.pid + "\\n");
process.exit(0);
`;

describe("runPgTool", () => {
  it("settles on the tool's exit while a grandchild still holds its pipes", async () => {
    const startedAt = Date.now();
    const result = await runPgTool(process.execPath, ["-e", TOOL], { env: ENV, timeoutMs: 20_000 });
    const elapsed = Date.now() - startedAt;

    const grandchild = Number(/started pid (\d+)/.exec(result.stdout)?.[1]);
    try {
      expect(result.code).toBe(0);
      expect(grandchild).toBeGreaterThan(0);
      // The tool exits at once; the bound is the post-exit drain, far below
      // the grandchild's 30 s.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (grandchild > 0) process.kill(grandchild, "SIGKILL");
    }
  }, 30_000);

  it("still reports a failing tool's code and output", async () => {
    const result = await runPgTool(
      process.execPath,
      ["-e", "process.stderr.write('no such data directory'); process.exit(3)"],
      { env: ENV, timeoutMs: 20_000 },
    );
    expect(result).toEqual({ code: 3, stdout: "", stderr: "no such data directory" });
  });
});
