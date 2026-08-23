/**
 * `mission.getDraft` - IPC contract for the C3 deployed-capital declaration.
 *
 * The handler validates its OUTPUT against `missionGetDraftResultSchema`, which
 * is what makes this test worth having: it proves the hash-bound declaration
 * actually crosses the boundary to the renderer (before this change the card
 * could not show it), and it proves the output gate FAILS CLOSED on a malformed
 * declaration rather than handing the renderer a half-declaration it would
 * render as a real capital base.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockGetDraftForSession = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<
    string,
    (e: IpcMainInvokeEvent, p: unknown) => unknown
  >();
  return {
    ipcMain: {
      handle: vi.fn(
        (channel: string, fn: (e: IpcMainInvokeEvent, p: unknown) => unknown) =>
          handlers.set(channel, fn),
      ),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});

vi.mock("../../../database/missions-db.js", () => ({
  getDraftForSession: (...a: unknown[]) => mockGetDraftForSession(...a),
}));

vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerMissionGetDraftHandler } = await import(
  "../../mission/get-draft.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const ISO = "2026-05-21T10:00:00.000Z";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

const DECLARED = {
  amountRaw: "3044000000000000000000",
  decimals: 18,
  chainId: 4663,
  assetAddress: "0x0f9f0000000000000000000000000000000000ee",
  assetSymbol: "VEX",
  amountHuman: "3044",
};

function draft(deployedCapital: unknown): Record<string, unknown> {
  return {
    missionId: "mission-1",
    sessionId: SESSION,
    status: "ready",
    title: "Rebalance",
    goal: "Rebalance the LP",
    constraints: {},
    successCriteria: [],
    stopConditions: [],
    riskProfile: null,
    allowedChains: [],
    allowedProtocols: [],
    allowedWallets: [],
    createdAt: ISO,
    updatedAt: ISO,
    approvedAt: null,
    acceptance: null,
    deployedCapital,
    renewedFromMissionId: null,
    missingFields: [],
    canAcceptContract: true,
  };
}

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.getDraft);
  if (handler === undefined) throw new Error("handler not registered");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as {
    ok: boolean;
    data?: Record<string, unknown> | null;
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registerMissionGetDraftHandler();
});

describe("mission.getDraft deployedCapital contract", () => {
  it("carries a full declaration across the boundary", async () => {
    mockGetDraftForSession.mockResolvedValue({ ok: true, data: draft(DECLARED) });
    const res = await call({ sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(res.data?.["deployedCapital"]).toEqual(DECLARED);
  });

  it("carries an explicit null for an undeclared capital base", async () => {
    mockGetDraftForSession.mockResolvedValue({ ok: true, data: draft(null) });
    const res = await call({ sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(res.data?.["deployedCapital"]).toBeNull();
  });

  it("carries a null amountHuman rather than inventing a figure", async () => {
    mockGetDraftForSession.mockResolvedValue({
      ok: true,
      data: draft({ ...DECLARED, amountHuman: null }),
    });
    const res = await call({ sessionId: SESSION });
    expect(res.ok).toBe(true);
    expect(
      (res.data?.["deployedCapital"] as Record<string, unknown>)["amountHuman"],
    ).toBeNull();
  });

  it("FAILS CLOSED on a malformed declaration instead of leaking a half-declaration", async () => {
    mockGetDraftForSession.mockResolvedValue({
      ok: true,
      data: draft({ amountRaw: "3044", decimals: 18 }),
    });
    const res = await call({ sessionId: SESSION });
    expect(res.ok).toBe(false);
  });

  it("FAILS CLOSED when the declaration key is missing entirely", async () => {
    const withoutKey = draft(null);
    delete withoutKey["deployedCapital"];
    mockGetDraftForSession.mockResolvedValue({ ok: true, data: withoutKey });
    const res = await call({ sessionId: SESSION });
    expect(res.ok).toBe(false);
  });

  it("rejects a non-uuid sessionId at the input gate", async () => {
    const res = await call({ sessionId: "not-a-uuid" });
    expect(res.ok).toBe(false);
    expect(mockGetDraftForSession).not.toHaveBeenCalled();
  });
});
