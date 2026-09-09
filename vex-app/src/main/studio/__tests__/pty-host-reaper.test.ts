import { expect, it, vi } from "vitest";
import { selectOrphanedHosts } from "../pty-host-reaper.js";
import type { ProcessEntry } from "../windows-processes.js";
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const binary = "C:\\Vex\\electron.exe";
const marked: ProcessEntry = { pid: 50, parentPid: 40, startedAt: 1000, binary,
  commandLine: '"C:\\Vex\\electron.exe" --type=utility --vex-pty-host --vex-parent-pid=40' };
it.each([
  { name: "marked orphan", entry: marked, parent: false, selected: true },
  { name: "live parent", entry: marked, parent: true, selected: false },
  { name: "unmarked old release", entry: { ...marked, commandLine: "electron.exe --type=utility" }, parent: false, selected: false },
  { name: "foreign binary", entry: { ...marked, binary: "C:\\Other\\electron.exe" }, parent: false, selected: false },
  { name: "marker substring", entry: { ...marked, commandLine: "electron.exe --vex-pty-host-extra --vex-parent-pid=40" }, parent: false, selected: false },
  { name: "parent mismatch", entry: { ...marked, parentPid: 39 }, parent: false, selected: false },
  { name: "unreadable executable", entry: { ...marked, binary: null }, parent: false, selected: false },
  { name: "case insensitive binary", entry: { ...marked, binary: binary.toUpperCase() }, parent: false, selected: true },
])("selects only our identified orphan: $name", ({ entry, parent, selected }) => {
  const processes = [entry, ...(parent ? [{ ...marked, pid: 40, parentPid: 1, commandLine: "main" }] : [])];
  expect(selectOrphanedHosts(processes, binary)).toEqual(selected ? [entry] : []);
});
