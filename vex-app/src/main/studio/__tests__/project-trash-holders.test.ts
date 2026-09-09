import { beforeEach, expect, it, vi } from "vitest";
import { resolveTrashHolders } from "../project-trash-holders.js";
import type { ProcessEntry } from "../windows-processes.js";
const fakes = vi.hoisted(() => ({ folders: vi.fn(), orphans: vi.fn(), cwd: vi.fn(), kill: vi.fn() }));
vi.mock("../terminal-domain.js", () => ({ terminalDomain: () => ({ folderHolders: fakes.folders }) }));
vi.mock("../pty-host-reaper.js", () => ({ orphanedHosts: fakes.orphans }));
vi.mock("../windows-processes.js", () => ({ readWindowsCwd: fakes.cwd }));
vi.mock("../../../platform/process-lifetime.js", () => ({ killWindowsTree: fakes.kill }));
const folder = "C:\\projects\\trading";
const host: ProcessEntry = { pid: 100, parentPid: 99, binary: "C:\\Vex\\electron.exe", commandLine: "marked host", startedAt: 1000 };
const shell: ProcessEntry = { pid: 101, parentPid: 100, binary: "C:\\Windows\\cmd.exe", commandLine: "cmd", startedAt: 2000 };
beforeEach(() => {
  vi.resetAllMocks();
  fakes.folders.mockResolvedValue([]);
  fakes.orphans.mockResolvedValue({ hosts: [host], processes: [host, shell] });
  fakes.cwd.mockResolvedValue(`${folder}\\nested`);
});
it("names an own orphan shell and closes its tree only after revalidation", async () => {
  expect(await resolveTrashHolders(folder, false)).toEqual([{ kind: "vex_orphaned_terminal", pid: 101 }]);
  expect(fakes.kill).not.toHaveBeenCalled();
  await resolveTrashHolders(folder, true);
  expect(fakes.kill).toHaveBeenCalledWith(101);
});
it("does not attribute a sibling directory or a foreign process", async () => {
  fakes.cwd.mockResolvedValue(`${folder}-other`);
  expect(await resolveTrashHolders(folder, true)).toEqual([{ kind: "external" }]);
  fakes.orphans.mockResolvedValue({ hosts: [], processes: [shell] });
  expect(await resolveTrashHolders(folder, true)).toEqual([{ kind: "external" }]);
  expect(fakes.kill).not.toHaveBeenCalled();
});
it("rejects a reused shell PID before termination", async () => {
  fakes.orphans.mockResolvedValueOnce({ hosts: [host], processes: [host, shell] })
    .mockResolvedValue({ hosts: [host], processes: [host, { ...shell, startedAt: 3000 }] });
  await resolveTrashHolders(folder, true);
  expect(fakes.kill).not.toHaveBeenCalled();
});
it("cancellation before the action reaches neither host nor taskkill", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(resolveTrashHolders(folder, true, controller.signal)).rejects.toThrow();
  expect(fakes.folders).not.toHaveBeenCalled();
  expect(fakes.kill).not.toHaveBeenCalled();
});
it("cancellation during cwd inspection prevents tree termination", async () => {
  const controller = new AbortController();
  fakes.cwd.mockImplementation(async () => { controller.abort(); return folder; });
  await expect(resolveTrashHolders(folder, true, controller.signal)).rejects.toThrow();
  expect(fakes.kill).not.toHaveBeenCalled();
});
