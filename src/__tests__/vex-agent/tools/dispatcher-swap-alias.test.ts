/**
 * Agent Scan plan v3 §11.2 — `swap_execute` / `swap_execute_uniswap` MUTATING
 * protocol-alias dedicated dispatch path. Rewrite of the retired `swap`
 * buy/sell/side/recipient contract (Stage 8b) against the final unified
 * surface: `{chain, tokenIn, tokenOut, amountIn, slippageBps?}`, KyberSwap-only
 * EVM routing (no silent Uniswap fallback), and the hidden `swap_execute_uniswap`
 * pair gated on a session-scoped reveal.
 *
 * Two surfaces under test:
 *
 *  A. ROUTING / PATH-IDENTITY / STAMP / PRESSURE (executeProtocolTool mocked at
 *     the boundary, like dispatcher-autoretry-stamp.test.ts):
 *       - EVM (Kyber-covered chain) → kyberswap.swap.execute unchanged params;
 *       - Solana → solana.swap.execute with amountIn translated to a number amount;
 *       - a chain Kyber does NOT cover (but Uniswap does) → REJECTED and reveals
 *         the hidden Uniswap pair for the session — NO silent fallback dispatch;
 *       - legacy `side`/`recipient`/`amount` fields are REJECTED (.strict()),
 *         never silently stripped;
 *       - path-identity: `swap_execute` and execute_tool({toolId:"kyberswap.swap.execute"})
 *         reach executeProtocolTool with the SAME toolId + params;
 *       - the alias SKIPS the internal mutating-approval gate (executeProtocolTool
 *         is reached even under restricted+unapproved — approval is owned there);
 *       - mission auto-retry-unsafe stamp fires using the TARGET manifest;
 *       - pressure barrier/critical → mutating deny for `swap_execute`.
 *
 *  B. HIDDEN `swap_execute_uniswap` — dispatch-side hard reject before an
 *     active reveal (independent of whatever the tool list showed the model),
 *     resolves to `uniswap.swap.execute` once revealed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearUniswapPairReveal, revealUniswapPair } from "@vex-agent/tools/registry/uniswap-reveal.js";

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
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as unknown as DispatchCtx;
}

// EVM tokens must be a contract address or native (the router rejects a bare
// symbol early — symmetric with the strict execute handler). tokenIn is
// native ETH; tokenOut is a USDC contract address.
const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const EVM_SWAP_ARGS = { chain: "base", tokenIn: "ETH", tokenOut: USDC_ADDR, amountIn: "0.5", slippageBps: 50 };

beforeEach(() => {
  getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
});

afterEach(() => {
  vi.clearAllMocks();
  // Reveal state is a module-level session map — clear every sessionId this
  // file touches so tests never leak reveal state into each other.
  for (const sid of ["s1", "s-reveal-1", "s-reveal-2", "s-hidden-1", "s-hidden-2", "s-hidden-3"]) {
    clearUniswapPairReveal(sid);
  }
});

describe("swap_execute alias — EVM / Solana routing (KyberSwap-only, no side/buy/sell)", () => {
  it("EVM (Kyber-covered chain) → kyberswap.swap.execute with unchanged params", async () => {
    await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c1" }, ctx());
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("kyberswap.swap.execute");
    expect(req.params).toEqual({
      chain: "base",
      tokenIn: "ETH",
      tokenOut: USDC_ADDR,
      amountIn: "0.5",
      slippageBps: 50,
    });
  });

  it("Solana → solana.swap.execute with amountIn translated to a numeric amount", async () => {
    await dispatchTool(
      { name: "swap_execute", args: { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5", slippageBps: 50 }, toolCallId: "c2" },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("solana.swap.execute");
    expect(req.params).toEqual({ inputToken: "SOL", outputToken: "USDC", amount: 1.5, slippageBps: 50 });
  });

  it("unknown chain (neither Kyber nor Uniswap) → clear reject, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "swap_execute", args: { chain: "narnia", tokenIn: "A", tokenOut: "B", amountIn: "1" }, toolCallId: "c3" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/cannot determine swap family/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("missing required arg (amountIn) → clear reject, NO dispatch", async () => {
    const result = await dispatchTool(
      { name: "swap_execute", args: { chain: "base", tokenIn: "ETH", tokenOut: USDC_ADDR }, toolCallId: "c4" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/^swap_execute:/);
    expect(result.output).toContain("amountIn");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("EVM bare symbol token → clear reject, NO dispatch (must use token_find first)", async () => {
    const result = await dispatchTool(
      { name: "swap_execute", args: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "0.5" }, toolCallId: "c5" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("EVM tokens must be a contract address");
    expect(result.output).toContain("token_find");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap_execute alias — legacy fields are REJECTED, never silently stripped (FIX-SPINE C4)", () => {
  it('rejects a legacy "side" field', async () => {
    const result = await dispatchTool(
      { name: "swap_execute", args: { ...EVM_SWAP_ARGS, side: "sell" }, toolCallId: "c6" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/unrecognized/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it('rejects a legacy "recipient" field', async () => {
    const result = await dispatchTool(
      { name: "swap_execute", args: { ...EVM_SWAP_ARGS, recipient: "0x" + "ab".repeat(20) }, toolCallId: "c7" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/unrecognized/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it('rejects a legacy "amount" field (renamed to amountIn)', async () => {
    const { amountIn: _drop, ...rest } = EVM_SWAP_ARGS;
    const result = await dispatchTool(
      { name: "swap_execute", args: { ...rest, amount: "0.5" }, toolCallId: "c8" },
      ctx(),
    );
    expect(result.success).toBe(false);
    // Both the unrecognized `amount` key and the missing `amountIn` fire.
    expect(result.output).toMatch(/unrecognized|amountIn/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap_execute alias — chain Kyber does not cover reveals the hidden Uniswap pair", () => {
  // Robinhood Chain resolves via its KyberSwap SLUG ("robinhood") but NOT via
  // the bare numeric chain id "4663" (kyberswap/chains.ts's ALIASES map has no
  // numeric entries) — a real, documented slug-vs-numeric-id asymmetry in the
  // shared venue router. "robinhood" stays on KyberSwap; "4663" only resolves
  // via Uniswap's numeric-id path, so THAT spelling is the one that triggers
  // the pre-call reveal-eligible reject.
  const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
  const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";

  it('chain "robinhood" (slug) still routes to kyberswap.swap.execute — no reveal', async () => {
    await dispatchTool(
      { name: "swap_execute", args: { chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5", slippageBps: 50 }, toolCallId: "rh1" },
      ctx({ sessionId: "s-reveal-1" }),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("kyberswap.swap.execute");
    expect(req.params).toEqual({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5", slippageBps: 50 });
  });

  it('chain "4663" (numeric, Kyber-blind) → REJECTED and reveals swap_execute_uniswap for the session', async () => {
    const sessionId = "s-reveal-2";
    expect(revealUniswapPair).toBeDefined();
    const result = await dispatchTool(
      { name: "swap_execute", args: { chain: "4663", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" }, toolCallId: "rh2" },
      ctx({ sessionId }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/kyberswap does not support/i);
    expect(result.output).toContain("swap_execute_uniswap");
    expect(executeProtocolTool).not.toHaveBeenCalled();

    // The reveal actually fired for THIS session — proven by dispatching the
    // hidden pair for the SAME session immediately after, with no separate
    // reveal call.
    await dispatchTool(
      { name: "swap_execute_uniswap", args: { chain: "4663", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" }, toolCallId: "rh3" },
      ctx({ sessionId }),
    );
    const [uniReq] = executeProtocolTool.mock.calls[0] as [{ toolId: string }];
    expect(uniReq.toolId).toBe("uniswap.swap.execute");
  });
});

describe("swap_execute alias — skips the internal approval gate (executeProtocolTool owns approval)", () => {
  it("restricted + unapproved STILL reaches executeProtocolTool (no dispatcher-side pendingApproval short-circuit)", async () => {
    // A regular mutating internal tool would be short-circuited by
    // routeInternalTool's gate with pendingApproval and the handler never
    // reached. `swap_execute` must NOT do that — it reaches
    // executeProtocolTool, which runs the prequote gate THEN the approval gate.
    await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c9" }, ctx({ sessionPermission: "restricted", approved: false }));
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("returns executeProtocolTool's result verbatim (pendingApproval + typed prequote.verdict pass through)", async () => {
    executeProtocolTool.mockResolvedValueOnce({
      success: false,
      output: "kyberswap.swap.execute requires approval — mutating tool in restricted permission mode.",
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
      prequote: { verdict: "unknown" },
    });
    const result = await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c10" }, ctx());
    expect(result.pendingApproval).toBe(true);
    expect(result.prequote).toEqual({ verdict: "unknown" });
    expect(result.actionKind).toBe("user_wallet_broadcast");
  });
});

describe("swap_execute alias — path-identity with direct execute_tool", () => {
  it("`swap_execute` and execute_tool({toolId:'kyberswap.swap.execute'}) reach executeProtocolTool with identical toolId+params", async () => {
    await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c11a" }, ctx());
    const aliasReq = executeProtocolTool.mock.calls[0]?.[0];

    executeProtocolTool.mockClear();

    await dispatchTool(
      {
        name: "execute_tool",
        args: { toolId: "kyberswap.swap.execute", params: { chain: "base", tokenIn: "ETH", tokenOut: USDC_ADDR, amountIn: "0.5", slippageBps: 50 } },
        toolCallId: "c11b",
      },
      ctx(),
    );
    const directReq = executeProtocolTool.mock.calls[0]?.[0];

    expect(aliasReq).toEqual(directReq);
  });

  it("alias passes the SAME execution-context slice as execute_tool", async () => {
    const c = ctx();
    await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c12a" }, c);
    const aliasCtx = executeProtocolTool.mock.calls[0]?.[1];

    executeProtocolTool.mockClear();

    await dispatchTool(
      { name: "execute_tool", args: { toolId: "kyberswap.swap.execute", params: {} }, toolCallId: "c12b" },
      c,
    );
    const directCtx = executeProtocolTool.mock.calls[0]?.[1];

    expect(aliasCtx).toEqual(directCtx);
  });
});

describe("swap_execute alias — mission auto-retry-unsafe stamp uses the TARGET manifest", () => {
  it("stamps the mission run UNSAFE before dispatch (target manifest mutating:true)", async () => {
    getProtocolManifest.mockReturnValue({ mutating: true, actionKind: "user_wallet_broadcast" });
    await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c13" }, ctx({ missionRunId: "run-1" }));
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1");
    // The stamp predicate resolved the TARGET toolId, not the alias name.
    expect(getProtocolManifest).toHaveBeenCalledWith("kyberswap.swap.execute");
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED: a stamp write failure blocks dispatch", async () => {
    markAutoRetryUnsafe.mockRejectedValueOnce(new Error("db down"));
    const result = await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c14" }, ctx({ missionRunId: "run-1" }));
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("un-routable args do NOT leak through the stamp predicate — fall back to the alias flag, then reject in the branch", async () => {
    // The stamp predicate must classify side-effect risk, not validate. A router
    // throw inside dispatchTargetIsMutating is swallowed (falls back to the
    // alias mutating flag = true), so the stamp still fires; the real route
    // error surfaces as the branch's bounded failure.
    const result = await dispatchTool(
      { name: "swap_execute", args: { chain: "narnia", tokenIn: "A", tokenOut: "B", amountIn: "1" }, toolCallId: "c15" },
      ctx({ missionRunId: "run-1" }),
    );
    expect(markAutoRetryUnsafe).toHaveBeenCalledWith("run-1"); // stamped conservatively
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/cannot determine swap family/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap_execute alias — pressure-band hard-deny (target = mutating)", () => {
  it("barrier → mutating deny, NO dispatch", async () => {
    const result = await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c16" }, ctx({ contextUsageBand: "barrier" }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
    expect(result.output).toContain("barrier");
    expect(result.output).toContain("compact_now");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("critical → mutating deny, NO dispatch", async () => {
    const result = await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c17" }, ctx({ contextUsageBand: "critical" }));
    expect(result.success).toBe(false);
    expect(result.output).toContain("critical");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("warning band does NOT deny — dispatch proceeds", async () => {
    await dispatchTool({ name: "swap_execute", args: EVM_SWAP_ARGS, toolCallId: "c18" }, ctx({ contextUsageBand: "warning" }));
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });
});

describe("swap_execute_uniswap alias — hidden pair, dispatch-side hard reject before reveal", () => {
  it("rejects when the session has no active reveal, independent of the tool list", async () => {
    const result = await dispatchTool(
      { name: "swap_execute_uniswap", args: EVM_SWAP_ARGS, toolCallId: "h1" },
      ctx({ sessionId: "s-hidden-1" }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not available yet for this session/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("routes to uniswap.swap.execute once the session has an active reveal", async () => {
    const sessionId = "s-hidden-2";
    revealUniswapPair(sessionId);
    await dispatchTool(
      { name: "swap_execute_uniswap", args: EVM_SWAP_ARGS, toolCallId: "h2" },
      ctx({ sessionId }),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string }];
    expect(req.toolId).toBe("uniswap.swap.execute");
  });

  it("a reveal in ONE session does not leak into another session (cross-session isolation)", async () => {
    revealUniswapPair("s-hidden-3");
    const result = await dispatchTool(
      { name: "swap_execute_uniswap", args: EVM_SWAP_ARGS, toolCallId: "h3" },
      ctx({ sessionId: "some-other-unrevealed-session" }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not available yet for this session/i);
  });
});
