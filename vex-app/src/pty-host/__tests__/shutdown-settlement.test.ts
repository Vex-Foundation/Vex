import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_MAXIMUM_SHUTDOWN_MS,
  type TerminalHostMessage,
} from "@shared/schemas/terminal.js";
import { PtyHostService } from "../host-service.js";
import { TerminalSnapshotStore } from "../snapshot-store.js";
import { fakeProbe, scriptedSpawnerPool, type ScriptedPty } from "./scripted-pty.js";

let directory: string;
let service: PtyHostService;
let ptys: ScriptedPty[];
let messages: TerminalHostMessage[];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vex-shutdown-settlement-"));
  vi.useFakeTimers();
  const pool = scriptedSpawnerPool();
  ptys = pool.ptys;
  messages = [];
  service = new PtyHostService({
    spawn: pool.spawn,
    probe: fakeProbe({
      directories: ["/project"],
      files: ["/bin/bash"],
      executables: { bash: "/bin/bash" },
    }),
    baseEnv: { PATH: "/bin" },
    snapshotStore: new TerminalSnapshotStore(directory),
    scrollbackRows: 1000,
    graceMs: 60_000,
    shortGraceMs: 6_000,
    sendToMain: (message) => messages.push(message),
    platform: "win32",
    killTree: vi.fn(),
  });
});

afterEach(async () => {
  try {
    for (const pty of ptys) pty.exit(0);
    const shutdown = service.shutdownAll();
    await vi.advanceTimersByTimeAsync(TERMINAL_MAXIMUM_SHUTDOWN_MS);
    await shutdown;
  } finally {
    vi.useRealTimers();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createTerminal(terminalId: string): Promise<ScriptedPty> {
  await service.handleMainMessage({
    requestId: terminalId,
    request: {
      kind: "create",
      terminalId,
      windowId: "window",
      projectId: "project",
      launch: {
        executable: "bash",
        args: [],
        cwd: "/project",
        projectLabel: "project",
        cols: 80,
        rows: 24,
        env: {},
      },
    },
  }, []);
  const reply = messages.find((message) =>
    message.kind === "reply" && message.requestId === terminalId);
  expect(reply).toMatchObject({ kind: "reply", outcome: { ok: true } });
  const pty = ptys[ptys.length - 1];
  if (pty === undefined) throw new Error("create did not spawn a pty");
  // Windows conpty can finish closing after kill returns. The test owns the
  // eventual native exit event, independently of the kill request.
  pty.ignoresKill = true;
  return pty;
}

async function produceUntilKilled(producers: readonly ScriptedPty[]): Promise<void> {
  for (let elapsed = 0; elapsed < TERMINAL_MAXIMUM_SHUTDOWN_MS; elapsed += 100) {
    for (const pty of producers) pty.emit("still producing\r\n");
    await vi.advanceTimersByTimeAsync(100);
    if (producers.every((pty) => pty.killed)) return;
  }
  throw new Error("shutdown never killed all continuously producing ptys");
}

describe("host shutdown waits for conpty settlement", () => {
  it("retains every continuously producing pty until its controlled native exit", async () => {
    const first = await createTerminal("first");
    const second = await createTerminal("second");
    let completed = false;
    const shutdown = service.shutdownAll().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);

    // Output resets the quiet-period debounce, so shutdown must force a kill.
    // Observing that kill is the gate: no wall-clock race or sampled delay.
    await produceUntilKilled([first, second]);
    expect(completed).toBe(false);
    expect(messages.filter((message) => message.kind === "terminalExit")).toEqual([]);

    first.exit(17);
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    expect(messages.filter((message) => message.kind === "terminalExit")).toEqual([
      { kind: "terminalExit", terminalId: "first", exitCode: 17, signal: null },
    ]);
    expect(service.terminal("second")).toBeDefined();

    second.exit(23);
    await shutdown;
    expect(messages.filter((message) => message.kind === "terminalExit")).toEqual([
      { kind: "terminalExit", terminalId: "first", exitCode: 17, signal: null },
      { kind: "terminalExit", terminalId: "second", exitCode: 23, signal: null },
    ]);
    expect(service.terminal("first")).toBeUndefined();
    expect(service.terminal("second")).toBeUndefined();
  });

  it("keeps the existing shutdown bound when the native exit never arrives", async () => {
    const pty = await createTerminal("wedged");
    let completed = false;
    const shutdown = service.shutdownAll().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    const started = Date.now();
    await produceUntilKilled([pty]);
    const remaining = TERMINAL_MAXIMUM_SHUTDOWN_MS - (Date.now() - started);
    if (remaining > 0) {
      await vi.advanceTimersByTimeAsync(remaining - 1);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    await shutdown;
    expect(completed).toBe(true);
    expect(Date.now() - started).toBe(TERMINAL_MAXIMUM_SHUTDOWN_MS);
    expect(service.terminal("wedged")).toBeUndefined();
  });
});
