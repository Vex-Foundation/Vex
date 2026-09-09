import { beforeEach, expect, it, vi } from "vitest";
import { refreshCleanupHolders } from "../pending-cleanup-holders.js";
import type { ProjectPendingCleanups } from "@shared/schemas/project-cleanup.js";
const holders = vi.hoisted(() => vi.fn());
vi.mock("../project-trash-holders.js", () => ({ resolveTrashHolders: holders }));
vi.mock("../projects-root.js", () => ({ resolveProjectsRoot: async () => ({ ok: true, data: "/projects" }), resolveProjectDirectory: () => "/projects/example" }));
const page: ProjectPendingCleanups = { items: [{ projectId: "11111111-1111-4111-8111-111111111111", name: "Example", folder: "example", trashRequested: true, attempts: 5,
  trashFailure: { reason: "busy", folder: "/projects/example", holders: [{ kind: "vex_orphaned_terminal", pid: 50 }] },
}], nextOffset: null };
beforeEach(() => vi.resetAllMocks());
it("replaces saved holder PIDs with a current read", async () => {
  holders.mockResolvedValue([{ kind: "external" }]);
  const refreshed = await refreshCleanupHolders(page, new AbortController().signal);
  expect(refreshed.items[0]?.trashFailure).toEqual({ reason: "busy", folder: "/projects/example", holders: [{ kind: "external" }] });
  expect(holders).toHaveBeenCalledWith("/projects/example", false, expect.any(AbortSignal));
});
it("keeps the obligation visible without stale holder authority when inspection fails", async () => {
  holders.mockRejectedValue(new Error("unavailable"));
  const refreshed = await refreshCleanupHolders(page, new AbortController().signal);
  expect(refreshed.items[0]).toMatchObject({ attempts: 5, trashFailure: { reason: "busy", folder: "/projects/example" } });
  expect(refreshed.items[0]?.trashFailure).not.toHaveProperty("holders");
});
it("honors cancellation without inspecting any process", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(refreshCleanupHolders(page, controller.signal)).rejects.toThrow();
  expect(holders).not.toHaveBeenCalled();
});
