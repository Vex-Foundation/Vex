/**
 * vex.sessions.branch IPC handler.
 *
 * Contract under test: input is strict-validated at the boundary (uuid
 * source, positive int anchor, bounded optional name); the DB helper's
 * discriminated outcome passes through untouched — a blocked branch is an
 * ok(outcome) the renderer switches on, never a thrown error; DB failures
 * surface as a redacted err. The handler adds no retry of its own: each
 * successful call mints a new session.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "./../test-sender.js";

const mocks = vi.hoisted(() => ({
  branchSession: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("electron", () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, p: unknown) => unknown) =>
        handlers.set(channel, fn)),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});
vi.mock("../../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("../../../database/sessions-db.js", () => ({
  branchSession: mocks.branchSession,
}));

const { registerSessionsBranchHandler } = await import("../../sessions/branch.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const sender = createTrustedSender({ sender: createTestWebContents() });
const SOURCE_ID = "00000000-0000-4000-8000-000000000001";

const CREATED_SESSION = {
  id: "00000000-0000-4000-8000-000000000002",
  mode: "agent",
  permission: "restricted",
  title: "Branch title",
  initialGoal: null,
  startedAt: new Date().toISOString(),
  endedAt: null,
  missionStatus: null,
  pinnedAt: null,
};

async function invoke(payload: unknown): Promise<any> {
  const handler = electronMock.__handlers.get(CH.sessions.branch);
  if (!handler) throw new Error("No handler for sessions.branch");
  return handler(sender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.__handlers.clear();
  registerSessionsBranchHandler();
  mocks.branchSession.mockResolvedValue({
    ok: true,
    data: { outcome: "created", session: CREATED_SESSION },
  });
});

describe("sessions.branch IPC", () => {
  it("a valid request forwards to the DB helper and returns the created session outcome", async () => {
    const result = await invoke({ sourceId: SOURCE_ID, messageId: 41 });
    expect(result).toEqual({
      ok: true,
      data: { outcome: "created", session: CREATED_SESSION },
    });
    expect(mocks.branchSession).toHaveBeenCalledWith({
      sourceId: SOURCE_ID,
      messageId: 41,
    });
  });

  it("every blocked state is an ok(outcome) the renderer can switch on, never a thrown error", async () => {
    for (const outcome of [
      "not_found",
      "unsupported_mode",
      "anchor_not_found",
      "anchor_compacted",
      "open_tool_batch",
    ]) {
      mocks.branchSession.mockResolvedValue({ ok: true, data: { outcome } });
      const result = await invoke({ sourceId: SOURCE_ID, messageId: 41 });
      expect(result).toEqual({ ok: true, data: { outcome } });
    }
  });

  it("anchor seam: a zero or negative message id is rejected before the DB helper runs", async () => {
    const zero = await invoke({ sourceId: SOURCE_ID, messageId: 0 });
    expect(zero.ok).toBe(false);
    const negative = await invoke({ sourceId: SOURCE_ID, messageId: -1 });
    expect(negative.ok).toBe(false);
    const fractional = await invoke({ sourceId: SOURCE_ID, messageId: 1.5 });
    expect(fractional.ok).toBe(false);
    expect(mocks.branchSession).not.toHaveBeenCalled();
  });

  it("name seam: 80 chars pass the boundary, 81 are rejected before the DB helper runs", async () => {
    const ok80 = await invoke({
      sourceId: SOURCE_ID,
      messageId: 41,
      name: "t".repeat(80),
    });
    expect(ok80.ok).toBe(true);
    const rejected = await invoke({
      sourceId: SOURCE_ID,
      messageId: 41,
      name: "t".repeat(81),
    });
    expect(rejected.ok).toBe(false);
    expect(mocks.branchSession).toHaveBeenCalledTimes(1);
  });

  it("a malformed source id never reaches the DB helper", async () => {
    const result = await invoke({ sourceId: "not-a-uuid", messageId: 41 });
    expect(result.ok).toBe(false);
    expect(mocks.branchSession).not.toHaveBeenCalled();
  });

  it("a DB failure surfaces as the helper's redacted err, not a crash", async () => {
    mocks.branchSession.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "internal",
        message: "Unable to complete the session operation.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const result = await invoke({ sourceId: SOURCE_ID, messageId: 41 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.unexpected");
  });
});
