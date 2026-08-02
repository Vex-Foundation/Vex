/**
 * `mission.setLaunchCeilings` handler — MAIN owns the ETH→wei conversion.
 *
 * The renderer sends the plain decimal string the user typed; this handler is
 * the single place it becomes wei. That is the whole point of the test named
 * "converts…": if the conversion ever moves to the renderer, a UI decimals slip
 * becomes a thousandfold ceiling (rule 90).
 *
 * Also pinned: the schema gates the engine call, an unrepresentable amount is
 * NAMED rather than truncated, and a thrown engine error is redacted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockSetMissionLaunchCeilings = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();

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

vi.mock("@vex-agent/engine/mission/set-launch-ceilings.js", () => ({
  setMissionLaunchCeilings: (...a: unknown[]) => mockSetMissionLaunchCeilings(...a),
}));
vi.mock("../../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerMissionSetLaunchCeilingsHandler } = await import(
  "../../mission/set-launch-ceilings.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const MISSION = "mission-1";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.setLaunchCeilings);
  if (!handler) throw new Error("No handler for mission.setLaunchCeilings");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as {
    ok: boolean;
    data?: { outcome: string; [k: string]: unknown };
    error?: { code: string };
  };
}

const UPDATED = {
  outcome: "updated",
  maxLaunchValueRaw: "50000000000000000",
  maxLaunchValueDecimals: 18,
  maxLaunchCount: 2,
  acceptanceCleared: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  electronMock.__handlers.clear();
  registerMissionSetLaunchCeilingsHandler();
});

describe("mission.setLaunchCeilings", () => {
  it("converts the decimal ETH ceiling to wei at 18 decimals", async () => {
    mockSetMissionLaunchCeilings.mockResolvedValueOnce(UPDATED);

    const r = await call({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueEth: "0.05",
      maxLaunchCount: 2,
    });

    expect(r.ok).toBe(true);
    expect(mockSetMissionLaunchCeilings).toHaveBeenCalledWith({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueRaw: "50000000000000000",
      maxLaunchValueDecimals: 18,
      maxLaunchCount: 2,
    });
  });

  it("passes a cleared ceiling through as null on BOTH pair members", async () => {
    mockSetMissionLaunchCeilings.mockResolvedValueOnce({
      ...UPDATED,
      maxLaunchValueRaw: null,
      maxLaunchValueDecimals: null,
    });

    await call({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueEth: null,
      maxLaunchCount: null,
    });

    expect(mockSetMissionLaunchCeilings).toHaveBeenCalledWith({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueRaw: null,
      maxLaunchValueDecimals: null,
      maxLaunchCount: null,
    });
  });

  it("NAMES an amount too precise for wei instead of truncating it", async () => {
    const r = await call({
      sessionId: SESSION,
      missionId: MISSION,
      // 19 fractional digits — not representable in wei.
      maxLaunchValueEth: "0.0000000000000000001",
      maxLaunchCount: 1,
    });

    expect(r.ok).toBe(true);
    expect(r.data?.outcome).toBe("invalid");
    expect(String(r.data?.reason)).toContain("18 decimal places");
    expect(mockSetMissionLaunchCeilings).not.toHaveBeenCalled();
  });

  it("rejects a wei-shaped or otherwise malformed amount at the schema", async () => {
    for (const maxLaunchValueEth of ["50000000000000000e0", "0,05", "-1"]) {
      const r = await call({
        sessionId: SESSION,
        missionId: MISSION,
        maxLaunchValueEth,
        maxLaunchCount: 1,
      });
      expect(r.ok).toBe(false);
    }
    expect(mockSetMissionLaunchCeilings).not.toHaveBeenCalled();
  });

  it("rejects a negative or fractional count before the engine", async () => {
    for (const maxLaunchCount of [-1, 1.5]) {
      const r = await call({
        sessionId: SESSION,
        missionId: MISSION,
        maxLaunchValueEth: "0.05",
        maxLaunchCount,
      });
      expect(r.ok).toBe(false);
    }
    expect(mockSetMissionLaunchCeilings).not.toHaveBeenCalled();
  });

  it("maps blocked_status and not_found through the envelope", async () => {
    mockSetMissionLaunchCeilings.mockResolvedValueOnce({
      outcome: "blocked_status",
      status: "running",
    });
    const blocked = await call({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueEth: "0.05",
      maxLaunchCount: 1,
    });
    expect(blocked.data).toEqual({ outcome: "blocked_status", status: "running" });

    mockSetMissionLaunchCeilings.mockResolvedValueOnce({ outcome: "not_found" });
    const missing = await call({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueEth: null,
      maxLaunchCount: null,
    });
    expect(missing.data).toEqual({ outcome: "not_found" });
  });

  it("returns a redacted control failure when the engine throws", async () => {
    mockSetMissionLaunchCeilings.mockRejectedValueOnce(new Error("db down"));
    const r = await call({
      sessionId: SESSION,
      missionId: MISSION,
      maxLaunchValueEth: "0.05",
      maxLaunchCount: 1,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("db down");
  });
});
