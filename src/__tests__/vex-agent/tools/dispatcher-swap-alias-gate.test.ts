/**
 * Agent Scan plan v3 §11.2 — `swap_execute` alias × REAL Stage-7 prequote gate
 * + approval gate ordering. Rewrite of the retired `swap` (buy/sell/amount)
 * contract against the unified `{chain, tokenIn, tokenOut, amountIn,
 * slippageBps?}` shape — the gate mechanics under test are unchanged by the
 * rename (`EXECUTE_GATE_TOOLS["kyberswap.swap.execute"]` carries the SAME
 * `{kind:"swap", family:"eip155", provider:"kyberswap"}` registration the old
 * `kyberswap.swap.sell` row did).
 *
 * Uses the REAL `executeProtocolTool` and the REAL `evaluateSwapPrequoteGate`
 * (the gate is the safety chokepoint — mocking it would prove nothing). The
 * boundaries below are mocked: the prequote repo (no DB), the wallet resolver
 * (deterministic address), and the protocol catalog (manifest = the real
 * kyberswap.swap.execute shape; handler = a spy so we can assert it never runs
 * before approval / gate pass).
 *
 * Proves the invariant Codex flagged: a `swap_execute` with no fresh quote hits
 * the Stage-7 BLOCK BEFORE any approval is enqueued; a restricted swap with a
 * fresh pass/unknown prequote yields pendingApproval carrying the TYPED
 * verdict; and approved re-entry STILL re-checks the gate (a missing quote
 * blocks even when approved). All routed through the dedicated dispatcher
 * branch via `swap_execute`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rowVexFee } from "./protocols/prequote/vex-fee-fixtures.js";

// ── Prequote repo (no DB) — the gate's two reads are controlled per test ────
const existsFreshFailByMatch = vi.fn().mockResolvedValue(false);
const findLatestFreshByMatch = vi.fn().mockResolvedValue(null);
vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  existsFreshFailByMatch: (...a: unknown[]) => existsFreshFailByMatch(...a),
  findLatestFreshByMatch: (...a: unknown[]) => findLatestFreshByMatch(...a),
  create: vi.fn().mockResolvedValue(undefined),
}));

// ── Wallet resolver — deterministic EVM address (no keystore) ───────────────
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (_r: unknown, _p: unknown, _family: string) =>
    "0x1234567890abcdef1234567890abcdef12345678",
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: (err: unknown) => { throw err; },
}));

// ── Catalog — real kyberswap.swap.execute manifest shape + a spy handler ────
const swapHandler = vi.fn().mockResolvedValue({ success: true, output: "broadcast ok" });
const getProtocolManifest = vi.fn();
const getProtocolHandler = vi.fn();
vi.mock("@vex-agent/tools/protocols/catalog.js", async (importActual) => {
  const actual = await importActual<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return {
    ...actual,
    getProtocolManifest: (...a: unknown[]) => getProtocolManifest(...a),
    getProtocolHandler: (...a: unknown[]) => getProtocolHandler(...a),
  };
});

// Capture pipeline / DB writes — no-ops (we never reach a successful capture
// in these tests, but the runtime imports them eagerly via dynamic import).
vi.mock("@vex-agent/db/repos/executions.js", () => ({ recordExecution: vi.fn().mockResolvedValue(0) }));
vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  markAutoRetryUnsafe: vi.fn().mockResolvedValue(undefined),
}));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");

type DispatchCtx = Parameters<typeof dispatchTool>[1];

const EXECUTE_MANIFEST = {
  toolId: "kyberswap.swap.execute",
  namespace: "kyberswap" as const,
  lifecycle: "active" as const,
  description: "execute a swap",
  mutating: true,
  actionKind: "user_wallet_broadcast" as const,
  params: [
    { key: "chain", type: "string" as const, required: true, description: "" },
    { key: "tokenIn", type: "string" as const, required: true, description: "" },
    { key: "tokenOut", type: "string" as const, required: true, description: "" },
    { key: "amountIn", type: "string" as const, required: true, description: "" },
    { key: "slippageBps", type: "number" as const, description: "" },
  ],
  exampleParams: {},
};

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
    walletResolution: { source: "session", sessionId: "s1" },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as unknown as DispatchCtx;
}

// USDC on Base — a real address so the EVM gate identity build does not throw
// `unresolved_token` (a bare symbol is un-gateable at execute).
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Use addresses for both legs so buildEvmIdentity never hits `unresolved_token`.
const WETH_BASE = "0x4200000000000000000000000000000000000006";

function swapArgs(extra: Record<string, unknown> = {}) {
  return { chain: "base", tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "0.5", slippageBps: 50, ...extra };
}

beforeEach(() => {
  getProtocolManifest.mockReturnValue(EXECUTE_MANIFEST);
  getProtocolHandler.mockReturnValue(swapHandler);
  existsFreshFailByMatch.mockResolvedValue(false);
  findLatestFreshByMatch.mockResolvedValue(null);
});

afterEach(() => vi.clearAllMocks());

describe("swap_execute alias × Stage-7 gate — no fresh quote", () => {
  it("BLOCKS before any approval is enqueued (no pendingApproval, handler never called)", async () => {
    const result = await dispatchTool({ name: "swap_execute", args: swapArgs(), toolCallId: "g1" }, ctx());
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no fresh quote/i);
    // The gate block must short-circuit BEFORE the approval gate.
    expect(result.pendingApproval).toBeUndefined();
    expect(swapHandler).not.toHaveBeenCalled();
    // Gate read happened (proves we went through executeProtocolTool's gate).
    expect(findLatestFreshByMatch).toHaveBeenCalled();
  });

  it("still blocks even when approved:true (approved re-entry re-checks the gate)", async () => {
    const result = await dispatchTool({ name: "swap_execute", args: swapArgs(), toolCallId: "g2" }, ctx({ approved: true }));
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no fresh quote/i);
    expect(swapHandler).not.toHaveBeenCalled();
  });

  it("a fresh FAIL prequote blocks with the safety-fail message (handler never called)", async () => {
    existsFreshFailByMatch.mockResolvedValue(true);
    const result = await dispatchTool({ name: "swap_execute", args: swapArgs(), toolCallId: "g3" }, ctx({ approved: true }));
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/flagged unsafe|honeypot|scam/i);
    expect(swapHandler).not.toHaveBeenCalled();
  });
});

describe("swap_execute alias × Stage-7 gate — fresh prequote present", () => {
  function freshRow(verdict: "pass" | "unknown") {
    return {
      prequoteId: "prequote-1",
      sessionId: "s1",
      matchHash: "h",
      kind: "swap" as const,
      family: "eip155" as const,
      provider: "kyberswap",
      chainId: 8453,
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      tokenIn: WETH_BASE,
      tokenOut: USDC_BASE,
      amount: "0.5",
      slippageBps: 50,
      safetyVerdict: verdict,
      safetyDetail: { vexFee: rowVexFee({ collection: "inside_route" }) },
      routeRef: null,
    // Migration 095: a row that predates the claim lane reads as an
    // executable, unclaimed quote. It authorizes nothing on its own - the
    // claim additionally requires a stored route snapshot.
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
      createdAt: "2026-06-04T00:00:00Z",
      expiresAt: "2999-01-01T00:00:00Z",
    };
  }

  it("restricted + fresh PASS prequote → pendingApproval carrying verdict 'pass' (handler NOT called yet)", async () => {
    findLatestFreshByMatch.mockResolvedValue(freshRow("pass"));
    const result = await dispatchTool({ name: "swap_execute", args: swapArgs(), toolCallId: "g4" }, ctx());
    expect(result.pendingApproval).toBe(true);
    expect(result.prequote).toEqual({ verdict: "pass", vexFee: rowVexFee({ collection: "inside_route" }) });
    expect(result.actionKind).toBe("user_wallet_broadcast");
    expect(swapHandler).not.toHaveBeenCalled();
  });

  it("restricted + fresh UNKNOWN prequote → pendingApproval carrying verdict 'unknown' (UNVERIFIED preview)", async () => {
    findLatestFreshByMatch.mockResolvedValue(freshRow("unknown"));
    const result = await dispatchTool({ name: "swap_execute", args: swapArgs(), toolCallId: "g5" }, ctx());
    expect(result.pendingApproval).toBe(true);
    expect(result.prequote).toEqual({ verdict: "unknown", vexFee: rowVexFee({ collection: "inside_route" }) });
    expect(swapHandler).not.toHaveBeenCalled();
  });

  it("approved + fresh PASS prequote → gate allows, approval skipped, handler RUNS", async () => {
    findLatestFreshByMatch.mockResolvedValue(freshRow("pass"));
    const result = await dispatchTool({ name: "swap_execute", args: swapArgs(), toolCallId: "g6" }, ctx({ approved: true }));
    expect(result.success).toBe(true);
    expect(result.output).toContain("broadcast ok");
    expect(swapHandler).toHaveBeenCalledTimes(1);
    // Handler received the translated params (amountIn passes straight through).
    const [params] = swapHandler.mock.calls[0] as [Record<string, unknown>];
    expect(params.amountIn).toBe("0.5");
    expect(params.chain).toBe("base");
  });
});
