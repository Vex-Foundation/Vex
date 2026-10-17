import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_RUNTIME_STATE,
  readRuntimeState,
  RuntimeStateCorruptError,
  writeRuntimeState,
} from "../runtime-state.js";

const roots: string[] = [];
function stateFile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-runtime-state-"));
  roots.push(root);
  return path.join(root, "nested", "runtime-state.json");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const recorded = { pg: { systemIdentifier: "7697576143254888004", lastPort: 45999, major: 18 as const } };

describe("runtime-state.json", () => {
  it("a missing file is a fresh install", async () => {
    expect(await readRuntimeState(stateFile())).toEqual(EMPTY_RUNTIME_STATE);
  });

  it("round-trips and keeps fields a newer build wrote", async () => {
    const file = stateFile();
    await writeRuntimeState(file, { ...recorded, provider: "native" } as never);
    const read = await readRuntimeState(file);
    expect(read).toEqual({ ...recorded, provider: "native" });
  });

  it("writes atomically: temp file then rename, no temp file left", async () => {
    const file = stateFile();
    await writeRuntimeState(file, recorded);
    const { promises } = await import("node:fs");
    const rename = vi.spyOn(promises, "rename");
    await writeRuntimeState(file, { pg: { ...recorded.pg, lastPort: 1234 } });
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(to).toBe(file);
    expect(path.dirname(from)).toBe(path.dirname(file));
    expect(readdirSync(path.dirname(file))).toEqual(["runtime-state.json"]);
    expect(JSON.parse(readFileSync(file, "utf8")).pg.lastPort).toBe(1234);
  });

  it("a failed rename leaves the previous file intact and removes the temp file", async () => {
    const file = stateFile();
    await writeRuntimeState(file, recorded);
    const { promises } = await import("node:fs");
    vi.spyOn(promises, "rename").mockRejectedValueOnce(Object.assign(new Error("EIO"), { code: "EIO" }));
    await expect(writeRuntimeState(file, EMPTY_RUNTIME_STATE)).rejects.toThrow("EIO");
    expect(await readRuntimeState(file)).toEqual(recorded);
    expect(readdirSync(path.dirname(file))).toEqual(["runtime-state.json"]);
  });

  const migration = {
    installId: "11111111-2222-3333-4444-555555555555",
    step: "dumped" as const,
    outcome: null,
    dump: { sha256: "0".repeat(64), bytes: 1234 },
    attempts: 1,
    lastFailure: { kind: "restore_failed", message: "boom", at: "2026-10-17T00:00:00.000Z" },
    oldStackStopped: null,
    startedAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:01.000Z",
  };

  it("round-trips the provider marker and the migration record", async () => {
    const file = stateFile();
    await writeRuntimeState(file, { pg: null, provider: "native", migration });
    expect(await readRuntimeState(file)).toEqual({ pg: null, provider: "native", migration });
  });

  it.each([
    ["an unknown migration step", JSON.stringify({ pg: null, migration: { ...migration, step: "halfway" } })],
    ["a migration with no install id", JSON.stringify({ pg: null, migration: { ...migration, installId: "" } })],
    ["a malformed dump digest", JSON.stringify({ pg: null, migration: { ...migration, dump: { sha256: "xyz", bytes: 1 } } })],
    ["an unknown provider", JSON.stringify({ pg: null, provider: "docker" })],
  ])("REFUSES %s rather than guessing where the migration stands", async (_label, content) => {
    const file = stateFile();
    await writeRuntimeState(file, EMPTY_RUNTIME_STATE);
    writeFileSync(file, content);
    await expect(readRuntimeState(file)).rejects.toBeInstanceOf(RuntimeStateCorruptError);
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it.each([
    ["not JSON", "{ \"pg\": "],
    ["a wrong major", JSON.stringify({ pg: { ...recorded.pg, major: 17 } })],
    ["a non-numeric identifier", JSON.stringify({ pg: { ...recorded.pg, systemIdentifier: "abc" } })],
    ["no pg key", JSON.stringify({})],
  ])("REFUSES a corrupt file (%s) and leaves it untouched", async (_label, content) => {
    const file = stateFile();
    await writeRuntimeState(file, EMPTY_RUNTIME_STATE);
    writeFileSync(file, content);
    await expect(readRuntimeState(file)).rejects.toBeInstanceOf(RuntimeStateCorruptError);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});
