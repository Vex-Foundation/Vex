import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { keepFailedAttempt, keptSentence } = await import("../migration/failed-attempt.js");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-failed-attempt-"));
  roots.push(root);
  return root;
}

const BASE = { reason: "restore_failed", message: "pg_restore failed: x", at: "2026-10-19T14:11:37.280Z" };

describe("keepFailedAttempt", () => {
  it("keeps nothing and makes no directory when there was no tool output and no server log", async () => {
    const root = tempRoot();
    const dir = path.join(root, "kept");
    expect(await keepFailedAttempt({ ...BASE, dir, tool: null, serverLogDir: path.join(root, "pg18", "log") })).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it("moves the server log out of the data dir, so the rollback cannot take it", async () => {
    const root = tempRoot();
    const logDir = path.join(root, "pg18", "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "postgresql-1.log"), "first\n");
    writeFileSync(path.join(logDir, "postgresql-2.log"), "second\n");
    const dir = path.join(root, "kept");
    const kept = await keepFailedAttempt({
      ...BASE,
      dir,
      tool: { name: "pg_restore", code: 1, stderr: "pg_restore: error: boom\r\n" },
      serverLogDir: logDir,
    });
    expect(kept).toEqual({ dir, tool: "pg_restore", toolOutput: "kept", serverLog: "kept" });
    expect(existsSync(logDir)).toBe(false);
    expect(readdirSync(path.join(dir, "server-log")).sort()).toEqual(["postgresql-1.log", "postgresql-2.log"]);
    expect(readFileSync(path.join(dir, "pg_restore.stderr.txt"), "utf8")).toBe("pg_restore: error: boom\r\n");
    expect(JSON.parse(readFileSync(path.join(dir, "failure.json"), "utf8"))).toEqual({
      ...BASE,
      tool: { name: "pg_restore", exitCode: 1 },
      toolOutput: "kept",
      serverLog: "kept",
    });
  });
});

describe("keptSentence", () => {
  const dir = "/rt/migration-failed-attempt";

  it.each([
    [{ toolOutput: "kept", serverLog: "kept" }, `The full pg_restore output and the database server's log were kept in ${dir}.`],
    [{ toolOutput: "kept", serverLog: "none" }, `The full pg_restore output was kept in ${dir}.`],
    [
      { toolOutput: "kept", serverLog: "not_kept" },
      `The full pg_restore output was kept in ${dir}. The database server's log could not be kept; the app log says why.`,
    ],
    [{ toolOutput: "not_kept", serverLog: "none" }, "The full pg_restore output could not be kept; the app log says why."],
    [{ toolOutput: "none", serverLog: "none" }, ""],
  ] as const)("says exactly what was kept (%o)", (states, expected) => {
    expect(keptSentence({ dir, tool: "pg_restore", ...states })).toBe(expected);
  });
});
