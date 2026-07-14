/** Hypervexing aliases must reach the real protocol runtime gate order. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearHlPolicyProvider,
  registerHlPolicyProvider,
} from "../../../lib/hyperliquid-policy.js";
import {
  clearHlWorkspaceModeProvider,
  registerHlWorkspaceModeProvider,
} from "../../../lib/hyperliquid-workspace-mode.js";

const protectionGate = vi.fn();
vi.mock("@vex-agent/tools/protocols/hyperliquid/protection-gate.js", () => ({
  evaluateHyperliquidProtectionGate: (...args: unknown[]) => protectionGate(...args),
  evaluateHyperliquidCollateralGate: vi.fn().mockResolvedValue(null),
}));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const openArgs = {
  coin: "BTC", side: "long", size: "0.001", price: "60000", leverage: 3, marginMode: "isolated",
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    loadedDocuments: new Map(),
    sessionPermission: "restricted",
    approved: false,
    role: "parent",
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as Parameters<typeof dispatchTool>[1];
}

beforeEach(() => {
  registerHlPolicyProvider(() => ({ policy: {}, version: "v1", provenance: "preferences" }));
  registerHlWorkspaceModeProvider((sessionId) => sessionId === SESSION_ID ? "hypervexing" : "normal");
  protectionGate.mockReset();
});

afterEach(() => {
  clearHlPolicyProvider();
  clearHlWorkspaceModeProvider();
});

describe("Hypervexing aliases use the canonical protocol gate chain", () => {
  it("reaches the protection gate and blocks an SL-less open before approval", async () => {
    protectionGate.mockResolvedValueOnce({
      kind: "block",
      message: "A stop-loss is required by the current Hyperliquid policy.",
    });
    const result = await dispatchTool({ name: "hl_open", args: openArgs, toolCallId: "hl-1" }, context());
    expect(protectionGate).toHaveBeenCalledWith(
      "hyperliquid.perp.open",
      openArgs,
      expect.objectContaining({ sessionId: SESSION_ID }),
    );
    expect(result.success).toBe(false);
    expect(result.pendingApproval).toBeUndefined();
    expect(result.output).toContain("stop-loss");
  });

  it("lets the canonical restricted approval gate produce the pending intent", async () => {
    protectionGate.mockResolvedValueOnce({
      kind: "allow",
      snapshot: { state: "FLAT", positionSize: "0", fullPositionStops: [] },
      stopLossVerdict: "protected_required",
    });
    const result = await dispatchTool({
      name: "hl_open",
      args: { ...openArgs, slPrice: "59000" },
      toolCallId: "hl-2",
    }, context());
    expect(result).toMatchObject({
      success: false,
      pendingApproval: true,
      actionKind: "external_post",
    });
  });

  it("hard-blocks a hallucinated alias outside Hypervexing mode", async () => {
    registerHlWorkspaceModeProvider(() => "normal");
    const result = await dispatchTool({ name: "hl_open", args: openArgs, toolCallId: "hl-3" }, context());
    expect(result.success).toBe(false);
    expect(result.output).toContain("only in the Hypervexing workspace");
    expect(protectionGate).not.toHaveBeenCalled();
  });
});
