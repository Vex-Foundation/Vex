import { beforeEach, expect, it, vi } from "vitest";
import { CH } from "../../shared/ipc/channels.js";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));
const { projects } = await import("../agent/projects.js");
const input = { projectId: "11111111-1111-4111-8111-111111111111", expectedName: "Example", alsoTrashFolder: true, closeHolders: true };
beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue({ ok: true, data: { outcome: "already_removed" } }); });
it("carries close intent on the delete channel and cancels exactly that invocation", async () => {
  const request = projects.deleteAbortable(input);
  expect(invoke).toHaveBeenCalledWith(CH.projects.delete, { requestId: expect.any(String), payload: input });
  const envelope = invoke.mock.calls[0]?.[1];
  request.cancel(); request.cancel();
  expect(invoke).toHaveBeenCalledWith(CH.cancel, expect.objectContaining({ payload: { correlationId: envelope.requestId } }));
  expect(invoke.mock.calls.filter(([channel]) => channel === CH.cancel)).toHaveLength(1);
  expect(await request.promise).toMatchObject({ ok: true, data: { outcome: "already_removed" } });
});
it("rejects caller-selected PIDs at preload without invoking main", async () => {
  const invalid = { ...input, pid: 6484 };
  expect(await projects.deleteAbortable(invalid).promise).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
  expect(invoke).not.toHaveBeenCalled();
});
