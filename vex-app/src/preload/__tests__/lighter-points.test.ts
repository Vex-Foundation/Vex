import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterPointsResult } from "../../shared/schemas/lighter-points.js";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));
const { settings } = await import("../shell/settings.js");
const { CH } = await import("../../shared/ipc/channels.js");

const report: LighterPointsResult = {
  rows: [{ kind: "credential_missing_here", environment: "rhc",
    walletAddress: "0x1111111111111111111111111111111111111111",
    accountIndex: 123, apiKeyIndex: 4, tradingKeyRegistered: true,
    observedAt: "2026-09-09T00:00:00.000Z" }],
  walletCount: 1, observedAt: "2026-09-09T00:00:00.000Z",
};
beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue({ ok: true, data: report }); });

describe("Lighter points preload contract", () => {
  it("preserves local-credential state through the typed, payload-free method", async () => {
    expect(await settings.lighterPoints().promise).toEqual({ ok: true, data: report });
    expect(invoke).toHaveBeenCalledWith(CH.settings.lighterPoints, {
      requestId: expect.any(String), payload: {},
    });
  });

  it("sends cancellation once for this points request", () => {
    const reading = settings.lighterPoints();
    const envelope = invoke.mock.calls[0]?.[1];
    reading.cancel();
    reading.cancel();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(CH.cancel, {
      requestId: expect.any(String), payload: { correlationId: envelope.requestId },
    });
  });
});
