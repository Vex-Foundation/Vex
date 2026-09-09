import { expect, it } from "vitest";
import { parseStoredTrashFailure, projectTrashFailureSchema, trashRemediation } from "./project-cleanup.js";
import { projectDeleteInputSchema } from "./projects.js";
import { ptyParentPid } from "./pty-lifetime.js";
import { terminalFolderRequestSchema, terminalFolderHoldersSchema } from "./terminal-holders.js";
it("reads legacy obligations and complete structured holder observations", () => {
  expect(parseStoredTrashFailure("trash:busy")).toBe("busy");
  const failure = { reason: "busy", folder: "C:\\projects\\trading", holders: [{ kind: "vex_orphaned_terminal", pid: 6484 }] };
  expect(parseStoredTrashFailure(`trash:${JSON.stringify(failure)}`)).toEqual(failure);
  expect(trashRemediation(projectTrashFailureSchema.parse(failure))).toContain("previous session");
  expect(parseStoredTrashFailure("trash:private native error")).toBeNull();
  expect(projectTrashFailureSchema.safeParse({ ...failure, holders: [{ kind: "vex_terminal", pid: -1 }] }).success).toBe(false);
});
it("accepts only cleanup intent, never caller-selected paths or PIDs", () => {
  const input = { projectId: "11111111-1111-4111-8111-111111111111", expectedName: "Example", alsoTrashFolder: true, closeHolders: true };
  expect(projectDeleteInputSchema.safeParse(input).success).toBe(true);
  for (const extra of [{ pid: 1 }, { directory: "/outside" }, { closeHolders: "true" }]) {
    expect(projectDeleteInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  }
});
it("requires a marker and exactly one positive parent PID", () => {
  expect(ptyParentPid(["--vex-pty-host", "--vex-parent-pid=41"])).toBe(41);
  for (const args of [["--vex-parent-pid=41"], ["--vex-pty-host", "--vex-parent-pid=0"], ["--vex-pty-host", "--vex-parent-pid=41", "--vex-parent-pid=42"]]) expect(ptyParentPid(args)).toBeNull();
});
it("rejects off-contract host queries and responses", () => {
  expect(terminalFolderRequestSchema.safeParse({ kind: "folderHolders", directory: "/project", close: false }).success).toBe(true);
  expect(terminalFolderRequestSchema.safeParse({ kind: "folderHolders", directory: "/project", close: true, pid: 1 }).success).toBe(false);
  expect(terminalFolderHoldersSchema.safeParse([{ kind: "external", pid: 1 }]).success).toBe(false);
});
it("does not attribute an unidentified lock to another program", () => {
  expect(trashRemediation({ reason: "busy", folder: "C:\\projects\\example" })).toContain("could not be identified");
});
