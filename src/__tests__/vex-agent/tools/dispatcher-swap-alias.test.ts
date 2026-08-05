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

  it("Solana → solana.swap.execute with the SAME keys (W5a)", async () => {
    await dispatchTool(
      { name: "swap_execute", args: { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5", slippageBps: 50 }, toolCallId: "c2" },
      ctx(),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("solana.swap.execute");
    expect(req.params).toEqual({ tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5", slippageBps: 50 });
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

describe("swap_execute alias — a chain id routes exactly like its slug", () => {
  // CORRECTED (Wave B, card B2). This block used to assert that the bare chain
  // id "4663" was "Kyber-blind" and therefore REJECTED with "KyberSwap does not
  // support chain 4663" plus a burned Uniswap reveal — describing the
  // slug-vs-numeric-id split as "a real, documented asymmetry in the shared
  // venue router". It was neither real nor intended: `kyberswap/chains.ts`
  // registers Robinhood Chain as `{ chainId: 4663, aggregator: true }` with
  // aggregator support verified live on 2026-07-13, and `venue-router.ts`'s own
  // header states 4663 → [kyberswap (primary), uniswap (fallback)].
  //
  // What the old assertion actually pinned was a resolver defect: only the SLUG
  // reached Kyber's table, so the id spelling fell through to Uniswap's numeric
  // path and the agent was told a venue lacked support it has — spending the
  // session's one-shot reveal on the spelling of a chain. `token_find` returns
  // `chainId` as a NUMBER, so that spelling is the common one.
  //
  // Both forms now resolve through the same registry rows, so the reveal cannot
  // fire on a chain KyberSwap covers. The reveal itself is unchanged and still
  // fires from its genuine triggers (Kyber route-not-found codes at quote time,
  // a mined on-chain revert at execute time) inside the KyberSwap handlers.
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

  it('chain "4663" (chain id) ALSO routes to kyberswap.swap.execute, on the canonical slug', async () => {
    await dispatchTool(
      { name: "swap_execute", args: { chain: "4663", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5", slippageBps: 50 }, toolCallId: "rh2" },
      ctx({ sessionId: "s-reveal-2" }),
    );
    const [req] = executeProtocolTool.mock.calls[0] as [{ toolId: string; params: Record<string, unknown> }];
    expect(req.toolId).toBe("kyberswap.swap.execute");
    // Normalized to the slug, so the id and the slug produce one identity —
    // which is what lets a quote taken on one spelling gate an execute on the
    // other (the prequote match-hash resolves the chain the same way).
    expect(req.params).toEqual({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5", slippageBps: 50 });
  });

  it("does NOT burn the session's Uniswap reveal on the chain id spelling", async () => {
    const sessionId = "s-reveal-2";
    expect(revealUniswapPair).toBeDefined();
    await dispatchTool(
      { name: "swap_execute", args: { chain: "4663", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" }, toolCallId: "rh3" },
      ctx({ sessionId }),
    );

    // Proven behaviorally, the same way the old test proved the opposite: the
    // hidden pair is dispatched for the SAME session immediately after and must
    // be REFUSED, because nothing revealed it.
    executeProtocolTool.mockClear();
    const hidden = await dispatchTool(
      { name: "swap_execute_uniswap", args: { chain: "4663", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" }, toolCallId: "rh4" },
      ctx({ sessionId }),
    );
    expect(hidden.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
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

    // `toolCallId` is compared separately, not ignored: it is the ONE field that
    // must legitimately differ, because each context carries the id of the call
    // it is actually answering (Fala B — `trench.launch_request_form` parks its
    // turn and its result must address exactly that call). Path identity is
    // still asserted over every other field.
    expect(aliasCtx?.toolCallId).toBe("c12a");
    expect(directCtx?.toolCallId).toBe("c12b");
    expect({ ...aliasCtx, toolCallId: null }).toEqual({ ...directCtx, toolCallId: null });
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
    expect(result.output).not.toMatch(/compact_now/);
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
