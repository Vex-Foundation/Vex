import { afterEach, expect, it, vi } from "vitest";
import { TERMINAL_HOST_BEAT_INTERVAL_MS, type TerminalHostMessage } from "@shared/schemas/terminal.js";
import { watchParent } from "../parent-lifetime.js";
import { PtyHostService } from "../host-service.js";
import { TerminalSnapshotStore } from "../snapshot-store.js";
import { RecordingPort, fakeProbe, scriptedSpawnerPool } from "./scripted-pty.js";
import { terminateTerminal } from "../../platform/process-lifetime.js";

afterEach(() => vi.useRealTimers());
it("kills every owned terminal before exiting when its parent disappears", async () => {
  vi.useFakeTimers();
  const pool = scriptedSpawnerPool();
  const replies: TerminalHostMessage[] = [];
  const service = new PtyHostService({
    spawn: pool.spawn, probe: fakeProbe({ directories: ["/project"], files: ["/bin/bash"], executables: { bash: "/bin/bash" } }),
    baseEnv: {}, snapshotStore: new TerminalSnapshotStore("/unused"), scrollbackRows: 100,
    graceMs: 60000, shortGraceMs: 6000, platform: "linux", sendToMain: (message) => replies.push(message),
  });
  for (const id of ["one", "two"]) await service.handleMainMessage({ requestId: id, request: {
    kind: "create", terminalId: id, projectId: "11111111-1111-4111-8111-111111111111", windowId: "window",
    launch: { executable: "bash", args: [], cwd: "/project", projectLabel: "Project", cols: 80, rows: 24, env: {} },
  } }, []);
  expect(service.liveTerminalCount).toBe(2);
  await service.handleMainMessage({ requestId: "holders", request: { kind: "folderHolders", directory: "/project", close: false } }, []);
  expect(replies.find((message) => message.kind === "reply" && message.requestId === "holders")).toMatchObject({
    kind: "reply", outcome: { ok: true, value: [
      { kind: "vex_terminal", pid: 4242, project: "Project", projectId: "11111111-1111-4111-8111-111111111111" },
      { kind: "vex_terminal", pid: 4242, project: "Project", projectId: "11111111-1111-4111-8111-111111111111" },
    ] },
  });
  await service.handleMainMessage({ requestId: "invalid", request: { kind: "folderHolders", directory: "/project", close: true, pid: 4242 } }, []);
  expect(replies.some((message) => message.kind === "reply" && message.requestId === "invalid")).toBe(false);
  expect(pool.ptys.every((pty) => !pty.killed)).toBe(true);
  const port = new RecordingPort();
  await service.handleMainMessage({ requestId: "port", request: { kind: "attachWindow", windowId: "window", nonce: "n".repeat(16) } }, [port]);
  port.receive({ kind: "folderHolders", directory: "/project", close: true });
  expect(pool.ptys.every((pty) => !pty.killed)).toBe(true);
  let alive = true;
  const exit = vi.fn(() => {
    expect(pool.ptys.every((pty) => pty.killed)).toBe(true);
    expect(service.liveTerminalCount).toBe(0);
    expect(port.closed).toBe(true);
  });
  const stop = watchParent({ parentPid: 41, exists: () => alive,
    shutdown: () => service.shutdownAfterParentLoss(), exit, heartbeat: vi.fn(), log: vi.fn() });
  await vi.advanceTimersByTimeAsync(TERMINAL_HOST_BEAT_INTERVAL_MS);
  expect(exit).not.toHaveBeenCalled();
  alive = false;
  await vi.advanceTimersByTimeAsync(TERMINAL_HOST_BEAT_INTERVAL_MS);
  expect(exit).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(TERMINAL_HOST_BEAT_INTERVAL_MS);
  expect(exit).toHaveBeenCalledOnce();
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["win32", "linux", "darwin"] as const)("terminates the shell through the %s platform seam", (platform) => {
  const pty = { pid: 6484, kill: vi.fn() };
  const tree = vi.fn();
  terminateTerminal(pty, platform, tree);
  if (platform === "win32") expect(tree).toHaveBeenCalledWith(6484);
  else expect(tree).not.toHaveBeenCalled();
  expect(pty.kill).toHaveBeenCalledOnce();
});
