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
