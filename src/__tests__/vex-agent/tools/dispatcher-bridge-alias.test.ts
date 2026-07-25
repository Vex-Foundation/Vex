/**
 * Stage 8c — `bridge` MUTATING protocol-alias dedicated dispatch path.
 *
 * Proves the EXISTING 8b dedicated dispatcher branch picks up the new `bridge`
 * alias with NO dispatcher change: the branch routes ANY MUTATING_PROTOCOL_ALIAS_
 * ROUTERS key through `executeProtocolTool` (which solely owns the prequote gate
 * → approval gate → capture ordering).
 *
 * `executeProtocolTool` is mocked at the boundary (like dispatcher-swap-alias
 * Part A): we assert ROUTING / TRANSLATION / PATH-IDENTITY / mission stamp /
 * pressure-deny. The REAL bridge gate behavior is covered in
 * `protocols/bridge-prequote.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const markAutoRetryUnsafe = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  markAutoRetryUnsafe: (...a: unknown[]) => markAutoRetryUnsafe(...a),
}));

const getProtocolManifest = vi.fn();
vi.mock("@vex-agent/tools/protocols/catalog.js", async (importActual) => {
  const actual = await importActual<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return { ...actual, getProtocolManifest: (...a: unknown[]) => getProtocolManifest(...a) };
});

const executeProtocolTool = vi
  .fn()
  .mockResolvedValue({ success: true, output: "executed", actionKind: "user_wallet_broadcast" });
vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool: (...a: unknown[]) => executeProtocolTool(...a),
  discoverProtocolCapabilities: vi.fn().mockResolvedValue({ success: true, tools: [] }),
}));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");

type DispatchCtx = Parameters<typeof dispatchTool>[1];

function ctx(overrides: Partial<DispatchCtx> = {}): DispatchCtx {
  return {
    sessionId: "s1",
    loadedDocuments: new Map(),
    sessionPermission: "restricted",
    approved: false,
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as unknown as DispatchCtx;
}

const EVM_TOKEN = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC ethereum
const BRIDGE_ARGS = {
  fromChain: "ethereum",
  fromToken: EVM_TOKEN,
  toChain: "base",
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000000",
};

beforeEach(() => {
  getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
});

afterEach(() => vi.clearAllMocks());

describe("bridge alias — routing + translation", () => {
  it("routes to khalani.bridge with the bridge params passed through verbatim", async () => {
    await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b1" }, ctx());
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("khalani.bridge");
    expect(req.params).toEqual({
      fromChain: "ethereum",
      fromToken: EVM_TOKEN,
      toChain: "base",
      toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
    });
  });

  it("forwards the bound money overrides (tradeType, recipient, refundTo, filler)", async () => {
    await dispatchTool(
      {
        name: "bridge",
        args: {
          ...BRIDGE_ARGS,
          tradeType: "EXACT_OUTPUT",
          recipient: "0x" + "ab".repeat(20),
          refundTo: "0x" + "cd".repeat(20),
          filler: "native-filler",
        },
        toolCallId: "b2",
      },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ params: Record<string, unknown> }];
    expect(req.params.tradeType).toBe("EXACT_OUTPUT");
    expect(req.params.recipient).toBe("0x" + "ab".repeat(20));
    expect(req.params.refundTo).toBe("0x" + "cd".repeat(20));
    expect(req.params.filler).toBe("native-filler");
  });

  it("REJECTS a model-supplied referrer / referrerFeeBps BY NAME (NOT dropped, NOT dispatched)", async () => {
    // The fee is deducted from the bridged output and paid to an arbitrary
    // address, and the approval preview never shows it — so the alias must
    // refuse audibly rather than strip the key and dispatch a clean-looking
    // bridge. A silent drop would hide the attempt entirely.
    for (const bad of [
      { referrer: "0x" + "ef".repeat(20) },
      { referrerFeeBps: "9999" },
      { referrer: "0x" + "ef".repeat(20), referrerFeeBps: "100" },
    ]) {
      executeProtocolTool.mockClear();
      const result = await dispatchTool(
        { name: "bridge", args: { ...BRIDGE_ARGS, ...bad }, toolCallId: "bfee" },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/^bridge:/);
      expect(result.output).toMatch(/referrer/);
      expect(result.output).toContain("not an accepted parameter");
      expect(executeProtocolTool).not.toHaveBeenCalled();
    }
  });

  it("REJECTS the execute-only routeId / depositMethod at the alias boundary (NOT forwarded)", async () => {
    // 8c security fix: routeId/depositMethod are unbindable execute-only knobs.
    // `.strict()` on BridgeArgs rejects them so the agent cannot supply them via
    // the menu — clear reject, NO dispatch.
    for (const bad of [{ routeId: "r1" }, { depositMethod: "PERMIT2" }]) {
      executeProtocolTool.mockClear();
      const result = await dispatchTool(
        { name: "bridge", args: { ...BRIDGE_ARGS, ...bad }, toolCallId: "b2x" },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/^bridge:/);
      expect(executeProtocolTool).not.toHaveBeenCalled();
    }
  });

  it("missing required arg (amount) → clear reject, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "bridge", args: { fromChain: "ethereum", fromToken: EVM_TOKEN, toChain: "base", toToken: "0x" }, toolCallId: "b3" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^bridge:/);
    expect(result.output).toContain("amount");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("bridge alias — Robinhood Chain 4663 routes to Relay, never Khalani (LOCKED #3)", () => {
  const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  it("toChain 'robinhood' → relay.bridge (NOT khalani), Khalani-only fields dropped", async () => {
    await dispatchTool(
      {
        name: "bridge",
        args: {
          fromChain: "base",
          fromToken: BASE_USDC,
          toChain: "robinhood",
          toToken: VIRTUAL,
          amount: "1000000",
          // Khalani-only knob — must NOT reach the Relay target. (`referrer` is
          // no longer part of the alias surface at all: it is rejected by name
          // before routing, so it cannot be exercised here.)
          filler: "native-filler",
          // Relay-only slippage — SHOULD pass through.
          slippageBps: "50",
        },
        toolCallId: "rhb1",
      },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("relay.bridge");
    expect(req.toolId).not.toContain("khalani");
    expect(req.params).toEqual({
      fromChain: "base",
      fromToken: BASE_USDC,
      toChain: "robinhood",
      toToken: VIRTUAL,
      amount: "1000000",
      slippageBps: "50",
    });
    expect(req.params).not.toHaveProperty("referrer");
    expect(req.params).not.toHaveProperty("referrerFeeBps");
    expect(req.params).not.toHaveProperty("filler");
  });

  it("fromChain '4663' → relay.bridge (either side local routes to Relay)", async () => {
    await dispatchTool(
      {
        name: "bridge",
        args: { fromChain: "4663", fromToken: VIRTUAL, toChain: "base", toToken: BASE_USDC, amount: "1000000" },
        toolCallId: "rhb2",
      },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string }];
    expect(req.toolId).toBe("relay.bridge");
  });
});

describe("bridge alias — skips the internal approval gate (executeProtocolTool owns approval)", () => {
  it("restricted + unapproved STILL reaches executeProtocolTool (no dispatcher-side short-circuit)", async () => {
    await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b4" }, ctx({ sessionPermission: "restricted", approved: false }));
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("returns executeProtocolTool's result verbatim (pendingApproval + typed prequote.verdict pass through)", async () => {
    executeProtocolTool.mockResolvedValueOnce({
      success: false,
      output: "khalani.bridge requires approval — mutating tool in restricted permission mode.",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
      prequote: { verdict: "unknown" },
    });
    const result = await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b5" }, ctx());
    expect(result.pendingApproval).toBe(true);
    expect(result.prequote).toEqual({ verdict: "unknown" });
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });
});

describe("bridge alias — path-identity with direct execute_tool", () => {
  it("`bridge` and execute_tool({toolId:'khalani.bridge'}) reach executeProtocolTool with identical toolId+params", async () => {
    await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b6a" }, ctx());
    const aliasReq = executeProtocolTool.mock.calls[0]?.[0];

    executeProtocolTool.mockClear();

    await dispatchTool(
      { name: "execute_tool", args: { toolId: "khalani.bridge", params: { ...BRIDGE_ARGS } }, toolCallId: "b6b" },
      ctx(),
    );
    const directReq = executeProtocolTool.mock.calls[0]?.[0];

    expect(aliasReq).toEqual(directReq);
  });
});

describe("bridge alias — mission auto-retry-unsafe stamp uses the TARGET manifest", () => {
  it("stamps the mission run UNSAFE before dispatch (target manifest mutating:true)", async () => {
    getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
    await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b7" }, ctx({ missionRunId: "run-1" }));
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
    // The stamp predicate resolved the TARGET toolId, not the alias name.
    expect(getProtocolManifest).toHaveBeenCalledWith("khalani.bridge");
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED: a stamp write failure blocks dispatch", async () => {
    markAutoRetryUnsafe.mockRejectedValueOnce(new Error("db down"));
    const result = await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b8" }, ctx({ missionRunId: "run-1" }));
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("bridge alias — pressure-band hard-deny (target = mutating)", () => {
  it("barrier → mutating deny, NO dispatch", async () => {
    const result = await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b9" }, ctx({ contextUsageBand: "barrier" }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
    expect(result.output).toContain("barrier");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("critical → mutating deny, NO dispatch", async () => {
    const result = await dispatchTool({ name: "bridge", args: BRIDGE_ARGS, toolCallId: "b10" }, ctx({ contextUsageBand: "critical" }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("critical");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});
