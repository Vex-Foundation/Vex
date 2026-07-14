/** Hyperliquid preload event boundary: strict DTO validation before renderer delivery. */

import { afterEach, describe, expect, it, vi } from "vitest";

type IpcListener = (event: unknown, ...args: unknown[]) => void;
const listeners = new Map<string, Set<IpcListener>>();
const invoke = vi.fn();

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: IpcListener) => {
      const set = listeners.get(channel) ?? new Set<IpcListener>();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel: string, listener: IpcListener) => {
      listeners.get(channel)?.delete(listener);
    },
    invoke,
  },
}));

const { hyperliquid } = await import("../agent/hyperliquid.js");
const { CH, EV } = await import("../../shared/ipc/channels.js");
const { hyperliquidPolicyTransportSchema } = await import("../../shared/schemas/hyperliquid.js");

const SESSION = "00000000-0000-4000-8000-000000000001";
const ISO = "2026-07-11T12:00:00.000Z";

function emit(channel: string, payload: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener({}, payload);
}

afterEach(() => {
  listeners.clear();
  vi.clearAllMocks();
});

describe("vex.hyperliquid subscriptions", () => {
  it("exposes narrow validated methods for markets, book, workspace reconciliation, and re-entry", async () => {
    invoke.mockResolvedValue({ ok: true, data: [] });

    await hyperliquid.getMarkets({ sessionId: SESSION });
    await hyperliquid.getBook({ sessionId: SESSION, coin: "BTC" });
    await hyperliquid.getWorkspaceMode({ sessionId: SESSION });
    await hyperliquid.enterWorkspace({ sessionId: SESSION });

    expect(invoke).toHaveBeenNthCalledWith(1, CH.hyperliquid.getMarkets, expect.objectContaining({
      payload: { sessionId: SESSION },
    }));
    expect(invoke).toHaveBeenNthCalledWith(2, CH.hyperliquid.getBook, expect.objectContaining({
      payload: { sessionId: SESSION, coin: "BTC" },
    }));
    expect(invoke).toHaveBeenNthCalledWith(3, CH.hyperliquid.getWorkspaceMode, expect.objectContaining({
      payload: { sessionId: SESSION },
    }));
    expect(invoke).toHaveBeenNthCalledWith(4, CH.hyperliquid.enterWorkspace, expect.objectContaining({
      payload: { sessionId: SESSION },
    }));
  });

  it("delivers only a strict renderer-safe position DTO", () => {
    const callback = vi.fn();
    const off = hyperliquid.onPositionsUpdate(callback);
    emit(EV.hyperliquid.positionsUpdate, {
      sessionId: SESSION,
      updatedAt: ISO,
      positions: [{
        coin: "BTC",
        side: "long",
        size: "0.01",
        entryPx: "100000",
        markPx: "100100",
        leverage: "3",
        marginMode: "isolated",
        liquidationPx: "75000",
        unrealizedPnl: "1",
        fundingAccrued: "-0.01",
        slPrice: "98000",
        tpPrice: null,
        protectionState: "PROTECTED",
        confirmedAt: ISO,
        updatedAt: ISO,
      }],
    });
    expect(callback).toHaveBeenCalledTimes(1);

    emit(EV.hyperliquid.positionsUpdate, {
      sessionId: SESSION,
      updatedAt: ISO,
      positions: [],
      rawProjection: { mustNotReachRenderer: true },
    });
    expect(callback).toHaveBeenCalledTimes(1);
    off();
  });

  it("delivers a valid risk proposal and drops an untrusted extra key", () => {
    const callback = vi.fn();
    const off = hyperliquid.onRiskProposalUpdate(callback);
    const proposal = {
      proposalId: "00000000-0000-4000-8000-000000000002",
      sessionId: SESSION,
      coin: "BTC",
      policy: hyperliquidPolicyTransportSchema.parse({}),
      proposedBy: "agent",
      status: "proposed",
      confirmedAt: null,
      expiresAt: null,
      createdAt: ISO,
    };
    emit(EV.hyperliquid.riskProposalUpdate, proposal);
    expect(callback).toHaveBeenCalledWith(proposal);

    emit(EV.hyperliquid.riskProposalUpdate, { ...proposal, rawPolicyJson: {} });
    expect(callback).toHaveBeenCalledTimes(1);
    off();
  });

  it("delivers only strict main-owned workspace mode events", () => {
    const callback = vi.fn();
    const off = hyperliquid.onWorkspaceMode(callback);
    const event = { sessionId: SESSION, mode: "hypervexing", requestedBy: "agent", acknowledged: false };
    emit(EV.hyperliquid.workspaceMode, event);
    expect(callback).toHaveBeenCalledWith(event);

    emit(EV.hyperliquid.workspaceMode, { ...event, requestedBy: "renderer" });
    emit(EV.hyperliquid.workspaceMode, { ...event, extra: true });
    expect(callback).toHaveBeenCalledTimes(1);
    off();
  });
});
