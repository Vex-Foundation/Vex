/**
 * Stage 8b — `swap` MUTATING protocol-alias dedicated dispatch path.
 *
 * Two surfaces under test:
 *
 *  A. ROUTING / PATH-IDENTITY / STAMP / PRESSURE (executeProtocolTool mocked at
 *     the boundary, like dispatcher-autoretry-stamp.test.ts):
 *       - side routing: buy → kyberswap.swap.buy; sell/default → kyberswap.swap.sell;
 *         Solana → solana.swap.execute; Solana + side → clear reject (no dispatch);
 *       - path-identity: `swap` and execute_tool({toolId:"kyberswap.swap.sell"})
 *         reach executeProtocolTool with the SAME toolId + params;
 *       - the alias SKIPS the internal mutating-approval gate (executeProtocolTool
 *         is reached even under restricted+unapproved — approval is owned there);
 *       - mission auto-retry-unsafe stamp fires using the TARGET manifest;
 *       - pressure barrier/critical → mutating deny for `swap`.
 *
 *  B. REAL GATE BEHAVIOR (real executeProtocolTool + real evaluateSwapPrequoteGate;
 *     prequote repo + catalog + wallet resolver mocked):
 *       - no fresh quote → Stage-7 gate BLOCK returned BEFORE any approval is
 *         enqueued (no pendingApproval, handler never called);
 *       - restricted + fresh pass/unknown prequote → pendingApproval carrying the
 *         typed safety verdict (pass / "unknown" → UNVERIFIED preview);
 *       - approved re-entry (approved:true) → the gate re-checks (fresh prequote
 *         still required; a missing quote still blocks even when approved).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Part A mocks: boundary mock of executeProtocolTool + manifest lookup ────

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
    role: "parent",
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as unknown as DispatchCtx;
}

// EVM tokens must be a contract address or native (the `swap` router rejects a
// bare symbol early — symmetric with the strict execute handler). tokenIn is
// native ETH; tokenOut is a USDC contract address.
const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const EVM_SWAP_ARGS = { chain: "base", tokenIn: "ETH", tokenOut: USDC_ADDR, amount: "0.5", slippageBps: 50 };

beforeEach(() => {
  getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
});

afterEach(() => vi.clearAllMocks());

describe("swap alias — side routing", () => {
  it("default (no side) → kyberswap.swap.sell with translated params", async () => {
    await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c1" }, ctx());
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("kyberswap.swap.sell");
    expect(req.params).toEqual({
      chain: "base",
      tokenIn: "ETH",
      tokenOut: USDC_ADDR,
      amountIn: "0.5", // amount → amountIn translation
      slippageBps: 50,
    });
  });

  it('side:"sell" → kyberswap.swap.sell', async () => {
    await dispatchTool({ name: "swap", args: { ...EVM_SWAP_ARGS, side: "sell" }, toolCallId: "c2" }, ctx());
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string }];
    expect(req.toolId).toBe("kyberswap.swap.sell");
  });

  it('side:"buy" → kyberswap.swap.buy', async () => {
    await dispatchTool({ name: "swap", args: { ...EVM_SWAP_ARGS, side: "buy" }, toolCallId: "c3" }, ctx());
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string }];
    expect(req.toolId).toBe("kyberswap.swap.buy");
  });

  it("recipient is forwarded on the EVM path", async () => {
    await dispatchTool(
      { name: "swap", args: { ...EVM_SWAP_ARGS, recipient: "0x" + "ab".repeat(20) }, toolCallId: "c3b" },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ params: Record<string, unknown> }];
    expect(req.params.recipient).toBe("0x" + "ab".repeat(20));
  });

  it("Solana (no side) → solana.swap.execute with translated params", async () => {
    await dispatchTool(
      { name: "swap", args: { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amount: "1.5", slippageBps: 50 }, toolCallId: "c4" },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("solana.swap.execute");
    expect(req.params).toEqual({ inputToken: "SOL", outputToken: "USDC", amount: 1.5, slippageBps: 50 });
  });

  it("Solana + side → clear reject, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "swap", args: { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amount: "1", side: "buy" }, toolCallId: "c5" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/side.*EVM-only/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("unknown chain → clear reject, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "swap", args: { chain: "narnia", tokenIn: "A", tokenOut: "B", amount: "1" }, toolCallId: "c6" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/cannot determine swap family/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("missing required arg (amount) → clear reject, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "swap", args: { chain: "base", tokenIn: "ETH", tokenOut: "USDC" }, toolCallId: "c7" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^swap:/);
    expect(result.output).toContain("amount");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("EVM bare symbol token → clear reject, NO dispatch (must use token_find first)", async () => {
    const result = await dispatchTool(
      { name: "swap", args: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amount: "0.5" }, toolCallId: "c7b" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("EVM tokens must be a contract address");
    expect(result.output).toContain("token_find");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap alias — Robinhood Chain 4663 routes to KyberSwap primary, Uniswap fallback", () => {
  // Swap-venue tokens are ADDRESS-ONLY (VIRTUAL → VEX on Robinhood Chain).
  const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
  const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
  const RH_ARGS = { chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amount: "1.5", slippageBps: 50 };

  it("chain 'robinhood' (default side) → kyberswap.swap.sell (KyberSwap aggregates 4663; Uniswap is the fallback)", async () => {
    await dispatchTool({ name: "swap", args: RH_ARGS, toolCallId: "rh1" }, ctx());
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("kyberswap.swap.sell");
    expect(req.params).toEqual({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5", slippageBps: 50 });
  });

  it("NUMERIC chain '4663' with side:'buy' → uniswap.swap.buy (known slug-only venue-router asymmetry: numeric ids skip KyberSwap)", async () => {
    await dispatchTool({ name: "swap", args: { ...RH_ARGS, chain: "4663", side: "buy" }, toolCallId: "rh2" }, ctx());
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string }];
    expect(req.toolId).toBe("uniswap.swap.buy");
  });

  it("a chain with NO venue (neither kyber nor uniswap) → clean error, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "swap", args: { chain: "narnia", tokenIn: VIRTUAL, tokenOut: VEX, amount: "1" }, toolCallId: "rh3" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/cannot determine swap family/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap alias — skips the internal approval gate (executeProtocolTool owns approval)", () => {
  it("restricted + unapproved STILL reaches executeProtocolTool (no dispatcher-side pendingApproval short-circuit)", async () => {
    // A regular mutating internal tool (e.g. polymarket_setup) would be
    // short-circuited by routeInternalTool's gate with pendingApproval and the
    // handler never reached. `swap` must NOT do that — it reaches
    // executeProtocolTool, which runs the prequote gate THEN the approval gate.
    await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c8" }, ctx({ sessionPermission: "restricted", approved: false }));
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("returns executeProtocolTool's result verbatim (pendingApproval + typed prequote.verdict pass through)", async () => {
    executeProtocolTool.mockResolvedValueOnce({
      success: false,
      output: "kyberswap.swap.sell requires approval — mutating tool in restricted permission mode.",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
      prequote: { verdict: "unknown" },
    });
    const result = await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c9" }, ctx());
    expect(result.pendingApproval).toBe(true);
    expect(result.prequote).toEqual({ verdict: "unknown" });
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });
});

describe("swap alias — path-identity with direct execute_tool", () => {
  it("`swap` and execute_tool({toolId:'kyberswap.swap.sell'}) reach executeProtocolTool with identical toolId+params", async () => {
    await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c10a" }, ctx());
    const aliasReq = executeProtocolTool.mock.calls[0]?.[0];

    executeProtocolTool.mockClear();

    await dispatchTool(
      {
        name: "execute_tool",
        args: { toolId: "kyberswap.swap.sell", params: { chain: "base", tokenIn: "ETH", tokenOut: USDC_ADDR, amountIn: "0.5", slippageBps: 50 } },
        toolCallId: "c10b",
      },
      ctx(),
    );
    const directReq = executeProtocolTool.mock.calls[0]?.[0];

    expect(aliasReq).toEqual(directReq);
  });

  it("alias passes the SAME execution-context slice as execute_tool", async () => {
    const c = ctx();
    await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c11a" }, c);
    const aliasCtx = executeProtocolTool.mock.calls[0]?.[1];

    executeProtocolTool.mockClear();

    await dispatchTool(
      { name: "execute_tool", args: { toolId: "kyberswap.swap.sell", params: {} }, toolCallId: "c11b" },
      c,
    );
    const directCtx = executeProtocolTool.mock.calls[0]?.[1];

    expect(aliasCtx).toEqual(directCtx);
  });
});

describe("swap alias — mission auto-retry-unsafe stamp uses the TARGET manifest", () => {
  it("stamps the mission run UNSAFE before dispatch (target manifest mutating:true)", async () => {
    getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
    await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c12" }, ctx({ missionRunId: "run-1" }));
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
    // The stamp predicate resolved the TARGET toolId, not the alias name.
    expect(getProtocolManifest).toHaveBeenCalledWith("kyberswap.swap.sell");
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it('buy side stamp resolves the buy target manifest', async () => {
    getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
    await dispatchTool({ name: "swap", args: { ...EVM_SWAP_ARGS, side: "buy" }, toolCallId: "c12b" }, ctx({ missionRunId: "run-1" }));
    expect(getProtocolManifest).toHaveBeenCalledWith("kyberswap.swap.buy");
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
  });

  it("FAIL-CLOSED: a stamp write failure blocks dispatch", async () => {
    markAutoRetryUnsafe.mockRejectedValueOnce(new Error("db down"));
    const result = await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c13" }, ctx({ missionRunId: "run-1" }));
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("un-routable args (Solana + side) do NOT leak through the stamp predicate — fall back to alias flag, then reject in the branch", async () => {
    // The stamp predicate must classify side-effect risk, not validate. A router
    // throw inside dispatchTargetIsMutating is swallowed (falls back to the
    // alias mutating flag = true), so the stamp still fires; the real route
    // error surfaces as the branch's bounded failure.
    const result = await dispatchTool(
      { name: "swap", args: { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amount: "1", side: "buy" }, toolCallId: "c13b" },
      ctx({ missionRunId: "run-1" }),
    );
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1"); // stamped conservatively
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/side.*EVM-only/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap alias — pressure-band hard-deny (target = mutating)", () => {
  it("barrier → mutating deny, NO dispatch", async () => {
    const result = await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c14" }, ctx({ contextUsageBand: "barrier" }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
    expect(result.output).toContain("barrier");
    expect(result.output).toContain("compact_now");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("critical → mutating deny, NO dispatch", async () => {
    const result = await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c15" }, ctx({ contextUsageBand: "critical" }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("critical");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("warning band does NOT deny — dispatch proceeds", async () => {
    await dispatchTool({ name: "swap", args: EVM_SWAP_ARGS, toolCallId: "c16" }, ctx({ contextUsageBand: "warning" }));
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });
});
