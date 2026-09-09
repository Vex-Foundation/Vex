import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deleteProject } from "../project-delete.js";
import { resetProjectLifecycleGateForTests } from "../project-lifecycle-gate.js";
const state = vi.hoisted(() => ({ root: "", attempts: 0, done: vi.fn(), failed: vi.fn() }));
vi.mock("../../logger/index.js", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../projects-root.js", () => ({
  resolveProjectsRoot: async () => ({ ok: true, data: state.root }),
  resolveProjectDirectory: (root: string, slug: string) => path.join(root, slug),
}));
vi.mock("../../database/projects/delete.js", () => ({
  tombstoneProject: async () => ({ ok: true, data: { kind: "already_tombstoned", slug: "example", cleanupState: "trash_pending" } }),
  tombstoneRequestedTrash: () => true,
  recordProjectCleanupFailure: async (...args: unknown[]) => { state.failed(...args); state.attempts += 1; return { ok: true, data: state.attempts }; },
  markProjectCleanupDone: async (...args: unknown[]) => { state.done(...args); return { ok: true, data: true }; },
  readTombstonedProject: vi.fn(), listUnfinishedProjectCleanups: vi.fn(), slugHeldByUnfinishedCleanup: vi.fn(),
}));
vi.mock("../../database/projects/installer-provenance.js", () => ({
  readArtifactProvenance: async () => ({ ok: true, data: new Map() }), clearArtifactProvenance: vi.fn(),
}));
beforeEach(async () => {
  state.root = await mkdtemp(path.join(os.tmpdir(), "vex-close-cleanup-"));
  await mkdir(path.join(state.root, "example"));
  state.attempts = 4; vi.clearAllMocks(); resetProjectLifecycleGateForTests();
});
afterEach(async () => { resetProjectLifecycleGateForTests(); await rm(state.root, { recursive: true, force: true }); });
it("preserves the fifth failure and resolves the tombstone after close and one retry", async () => {
  // Capture the canonical identity before the successful retry removes it.
  const resolvedDirectory = await realpath(path.join(state.root, "example"));
  let closed = false;
  const holders = vi.fn(async (_directory: string, close: boolean) => {
    if (close) closed = true;
    return [{ kind: "vex_terminal" as const, pid: 6484, project: "Example" }];
  });
  const trash = vi.fn(async (directory: string) => {
    if (!closed) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    await rm(directory, { recursive: true });
  });
  const deps = { trashItem: trash, removeTerminalSnapshot: async () => true, resolveTrashHolders: holders };
  const input = { projectId: "11111111-1111-4111-8111-111111111111", expectedName: "Example", alsoTrashFolder: false };
  expect(await deleteProject(input, "first", deps)).toMatchObject({ ok: true, data: {
    outcome: "cleanup_pending", attempts: 5, trashRequested: true, trashFailure: { reason: "busy" },
  } });
  expect(state.done).not.toHaveBeenCalled();
  expect(await deleteProject({ ...input, closeHolders: true }, "retry", deps)).toMatchObject({ ok: true, data: {
    outcome: "cleanup_resumed", trash: "trashed", trashRequested: true,
  } });
  expect(holders).toHaveBeenCalledWith(resolvedDirectory, true, undefined);
  expect(trash).toHaveBeenCalledTimes(2);
  expect(state.done).toHaveBeenCalledOnce();
  expect(state.failed).toHaveBeenCalledOnce();
});
it("cancellation before a retry never closes a holder or reaches trash", async () => {
  const controller = new AbortController(); controller.abort();
  const holders = vi.fn(); const trash = vi.fn();
  await deleteProject({ projectId: "11111111-1111-4111-8111-111111111111", expectedName: "Example", alsoTrashFolder: true, closeHolders: true },
    "cancel", { trashItem: trash, removeTerminalSnapshot: async () => true, resolveTrashHolders: holders }, controller.signal);
  expect(holders).not.toHaveBeenCalled(); expect(trash).not.toHaveBeenCalled();
});
