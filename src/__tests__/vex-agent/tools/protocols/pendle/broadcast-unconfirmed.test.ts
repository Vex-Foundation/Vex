/**
 * Pendle post-broadcast honesty, per mutating tool (phase-4 card H-4, rewritten
 * for card B1's activity spine).
 *
 * WHAT THIS FILE USED TO PIN. Every mutating handler signed, broadcast, and THEN
 * read the Pendle asset catalogue back for USD valuation — inside the SAME
 * `try`. The `txHash` was a `const` scoped inside that `try`, so a throw in the
 * read-back landed in a `catch` that could not see the hash: the agent was told
 * a funded, already-broadcast trade had simply FAILED, and was free to retry it.
 *
 * WHAT CHANGED. Card B1 moved the evidence — and the valuation reads it needs —
 * to BEFORE the signature, and routed every broadcast through
 * `signed-broadcast.ts`, which now owns the receipt wait and returns a
 * discriminated outcome instead of a bare hash. Two consequences this suite
 * pins:
 *
 *   1. The unproven outcomes are no longer exotic post-hoc catches; they are
 *      first-class returns. Every mutating tool must surface the hash, refuse a
 *      retry, and report `success: false` — because `runtime/capture.ts` skips
 *      capture on a failed result, so a mined-but-unproven trade must never
 *      project a lot from amounts nobody decoded.
 *   2. A PRE-broadcast failure never mentions a broadcast or a hash. That
 *      boundary is the one that decides whether an agent may safely retry, and
 *      it must not blur. (Its wording is still pinned byte-for-byte, and now
 *      includes the REAL cause: owner decree 2026-08-02 — a code + hint alone
 *      told the agent nothing about what actually failed.)
 *
 * `selectSafeRoute` (the fund-safety calldata extractor) is stubbed so these
 * tests reach the broadcast at all — it has its own dedicated suites
 * (`calldata*.test.ts`), and re-deriving real Router calldata for six methods
 * here would test the extractor, not the failure path under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { keccak256, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../../../errors.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockBuildAssetMap = vi.fn();
const mockResolveMarketByPt = vi.fn();
const mockResolveMarketByYt = vi.fn();
const mockResolveMarketByAddress = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: (...a: unknown[]) => mockResolveMarketByPt(...a),
  resolveMarketByYt: (...a: unknown[]) => mockResolveMarketByYt(...a),
  resolveMarketByAddress: (...a: unknown[]) => mockResolveMarketByAddress(...a),
  buildAssetMap: (...a: unknown[]) => mockBuildAssetMap(...a),
  priceUsdFor: () => null,
}));

// R5b: the exit actions (pt.redeem, lp.remove, claim) resolve through the
// matured-capable lane. Delegates to the SAME market doubles this suite
// already sets up, wrapped in the {market, maturity} envelope.
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByPt: async (...a: unknown[]) => {
    const m = await mockResolveMarketByPt(...a);
    return m ? { market: m, maturity: "active" } : null;
  },
  resolveExitMarketByAddress: async (...a: unknown[]) => {
    const m = await mockResolveMarketByAddress(...a);
    return m ? { market: m, maturity: "active" } : null;
  },
  resolveExitYtForPt: async (...a: unknown[]) => (await mockResolveMarketByPt(...a))?.yt ?? null,
}));

const mockConvert = vi.fn();
const mockConvertMulti = vi.fn();
const mockRedeemInterests = vi.fn();
vi.mock("@tools/pendle/client.js", () => ({
  getPendleClient: () => ({
    convert: (...a: unknown[]) => mockConvert(...a),
    convertMulti: (...a: unknown[]) => mockConvertMulti(...a),
    redeemInterestsAndRewards: (...a: unknown[]) => mockRedeemInterests(...a),
  }),
}));

const SERIALIZED = "0x02f8b10101" as Hex;
const TX_HASH = keccak256(SERIALIZED);
const WALLET = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

/** Flips the staged broadcast between its three real endings. */
let submitOutcome: "ambiguous" | "reverted" | "confirmed" = "ambiguous";
const mockSendRawTransaction = vi.fn();

vi.mock("@tools/pendle/evm-client.js", () => ({
  // Serves BOTH `resolveInputToken`'s on-chain decimals read and
  // `lp.remove`'s LP balanceOf read.
  getPendlePublicClient: () => ({ readContract: async () => 6 }),
  getPendleEvmClients: () => ({
    publicClient: {
      readContract: async () => 6,
      estimateGas: async () => 1_000_000n,
      sendRawTransaction: (...a: unknown[]) => mockSendRawTransaction(...a),
      waitForTransactionReceipt: async () => {
        if (submitOutcome === "reverted") return { status: "reverted", logs: [], blockNumber: 1n };
        // "confirmed" here means the node returned success; the receipt carries
        // NO decodable transfer, which is the mined-but-unprovable shape.
        return { status: "success", logs: [], blockNumber: 1n };
      },
    },
    walletClient: {
      account: { address: WALLET },
      chain: { id: 1 },
      prepareTransactionRequest: async (r: Record<string, unknown>) => ({ ...r, nonce: 11 }),
      signTransaction: async () => SERIALIZED,
    },
  }),
}));

vi.mock("@tools/pendle/erc20.js", () => ({
  ensurePendleAllowanceExact: vi.fn(async () => undefined),
}));
vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn(async () => undefined),
}));

const mockCreateIntent = vi.fn();
const mockPreBroadcastFailure = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...a: unknown[]) => mockCreateIntent(...a),
  createAgentActivityPreBroadcastFailure: (...a: unknown[]) => mockPreBroadcastFailure(...a),
  markActivityBroadcast: vi.fn(async () => ({ applied: true, row: {} })),
  markBroadcastAccepted: vi.fn(async () => ({ applied: true, row: {} })),
  confirmActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  failActivityEvent: vi.fn(async () => ({ applied: true, row: {} })),
  // Real export since migration 067. Without it the handler's best-effort
  // `noteHandlerPendingReason` throws inside its own catch and the pending-reason
  // path is silently skipped instead of exercised.
  notePendingReason: vi.fn(async () => ({ applied: true })),
}));
vi.mock("@vex-agent/sync/pendle-acquisition-pin.js", () => ({
  pinConfirmedPendleAcquisition: vi.fn(async () => undefined),
}));

const PRIVATE_KEY = `0x${"1".repeat(64)}`;
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
  resolveSigningWallet: () => ({ family: "eip155", address: WALLET, privateKey: PRIVATE_KEY }),
  walletScopeErrorToResult: () => ({ success: false, output: "wallet scope error" }),
}));

const mockSelectSafeRoute = vi.fn();
const mockAssertClaimSafe = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/calldata.js", () => ({
  selectSafeRoute: (...a: unknown[]) => mockSelectSafeRoute(...a),
  assertClaimSafe: (...a: unknown[]) => mockAssertClaimSafe(...a),
}));

vi.mock("@vex-agent/tools/protocols/pendle/claim-targets.js", () => ({
  buildPendleClaimTargets: async () => ({
    intendedYts: new Map([[YT.toLowerCase(), { tokenRedeemSy: USDC, sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc" }]]),
    intendedMarkets: new Set([MARKET_ADDR.toLowerCase()]),
    eligibleMarketCount: 1,
    selectedMarketCount: 1,
    marketCap: 10,
    skipped: [],
  }),
  describePendleClaimSkips: () => null,
}));

const { PENDLE_PT_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/pt.js");
const { PENDLE_YT_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/yt.js");
const { PENDLE_PY_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/py.js");
const { PENDLE_LP_HANDLERS } = await import("@vex-agent/tools/protocols/pendle/handlers/lp.js");

// ── Fixtures ─────────────────────────────────────────────────────────

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PT = "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb";
const YT = "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2";
const MARKET_ADDR = "0x177768caf9d0e036725a51d3f60d7e20f2d4d194";
const ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";

const MARKET = {
  address: MARKET_ADDR,
  name: "sUSDe",
  expiry: "2026-08-13T00:00:00.000Z",
  pt: PT,
  yt: YT,
  sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
  underlyingAsset: "0x9d39a5de30e57443bff2a8307a4256c8797a3497",
  details: { liquidity: 8_000_000, impliedApy: 0.1, pendleApy: null, aggregatedApy: null, maxBoostedApy: null, feeRate: null },
  categoryIds: [],
  isNew: false,
  isPrime: false,
};

/** A stubbed safe route — the extractor's own suites cover its real behaviour. */
const ROUTE = {
  contractParamInfo: { method: "swapExactTokenForPt", contractCallParams: [] },
  tx: { to: ROUTER, data: "0x1234", from: null, value: null },
  outputs: [{ token: PT, amount: "1000000" }],
  data: { aggregatorType: "KYBERSWAP", priceImpact: 0.0001, feeUsd: null },
};

function convertResponse(action: string, approvals: { token: string; amount: string }[] = []) {
  return { action, inputs: [], requiredApprovals: approvals, routes: [ROUTE], tokenApprovals: [], tx: ROUTE.tx };
}

/** H-1's dominant PRE-broadcast failure: the catalogue is unreadable. */
const CATALOGUE_UNREADABLE = new VexError(
  ErrorCodes.PENDLE_INVALID_RESPONSE,
  "Pendle asset catalogue for chain 1 is unreadable.",
  "Retry shortly; do not treat this as an empty catalogue.",
);

const ctx = { walletResolution: {}, walletPolicy: {}, sessionId: "session-1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  submitOutcome = "ambiguous";
  mockResolveMarketByPt.mockResolvedValue(MARKET);
  mockResolveMarketByYt.mockResolvedValue(MARKET);
  mockResolveMarketByAddress.mockResolvedValue(MARKET);
  mockSelectSafeRoute.mockReturnValue(ROUTE);
  mockAssertClaimSafe.mockReturnValue({ yts: [{ yt: YT, tokenRedeemSy: USDC }], markets: [MARKET_ADDR], pendleSwap: ROUTER });
  mockBuildAssetMap.mockResolvedValue(new Map());
  mockRedeemInterests.mockResolvedValue(convertResponse("claim"));
  mockCreateIntent.mockResolvedValue({ executionId: 7, events: [{ id: 99 }] });
  mockPreBroadcastFailure.mockResolvedValue({ executionId: 8, event: {} });
  mockSendRawTransaction.mockImplementation(async () => {
    if (submitOutcome === "ambiguous") throw new Error("rpc unavailable");
    return TX_HASH;
  });
});

// ── The shared contract ──────────────────────────────────────────────

type Res = { success: boolean; output: string; data?: Record<string, unknown> };

/**
 * An UNPROVEN broadcast: the transaction may be (or is) on-chain, but Vex
 * cannot state the outcome. The agent must get the hash, a refusal to retry,
 * and `success: false` — asserted on behaviour, never on an internal shape.
 */
function expectUnprovenBroadcast(res: Res, toolId: string): void {
  // Never success — the on-chain outcome is not proven.
  expect(res.success).toBe(false);
  // The hash itself, so the agent can surface it.
  expect(res.output).toContain(TX_HASH);
  // Do not retry — the funds may already be committed.
  expect(res.output).toMatch(/do not retry/i);
  // The tool is named so the agent knows which leg is in doubt.
  expect(res.output.startsWith(toolId)).toBe(true);
  // The durable row is threaded back so capture reuses the SAME execution.
  expect(res.data?._executionId).toBe(7);
  expect(res.data?.txHash).toBe(TX_HASH);
}

/**
 * A PRE-broadcast refusal: nothing was signed, so the message must be the
 * byte-identical legacy one and must NEVER mention a broadcast or a hash. This
 * boundary is what tells an agent a retry is safe.
 */
function expectPreBroadcastRefusal(res: Res, expected: string): void {
  expect(res.success).toBe(false);
  expect(res.output).toBe(expected);
  expect(res.output).not.toContain("broadcast");
  expect(res.output).not.toContain(TX_HASH);
  expect(mockSendRawTransaction).not.toHaveBeenCalled();
}

/** Every mutating tool, with params that reach its broadcast. */
const MUTATING_TOOLS: Array<{
  toolId: string;
  run: (p: Record<string, unknown>) => Promise<unknown>;
  params: Record<string, unknown>;
  setup?: () => void;
}> = [
  {
    toolId: "pendle.pt.buy",
    run: (p) => PENDLE_PT_HANDLERS["pendle.pt.buy"]!(p, ctx),
    params: { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" },
    setup: () => mockConvert.mockResolvedValue(convertResponse("swap")),
  },
  {
    toolId: "pendle.pt.sell",
    run: (p) => PENDLE_PT_HANDLERS["pendle.pt.sell"]!(p, ctx),
    params: { chain: "ethereum", tokenIn: PT, tokenOut: USDC, amountIn: "100" },
    setup: () => mockConvert.mockResolvedValue(convertResponse("swap")),
  },
  {
    toolId: "pendle.pt.redeem",
    run: (p) => PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(p, ctx),
    params: { chain: "ethereum", tokenIn: PT, amountIn: "100" },
    setup: () => mockConvert.mockResolvedValue(convertResponse("redeem-py", [{ token: PT, amount: "100000000" }])),
  },
  {
    toolId: "pendle.yt.buy",
    run: (p) => PENDLE_YT_HANDLERS["pendle.yt.buy"]!(p, ctx),
    params: { chain: "ethereum", tokenIn: USDC, tokenOut: YT, amountIn: "100" },
    setup: () => mockConvert.mockResolvedValue(convertResponse("swap")),
  },
  {
    toolId: "pendle.yt.sell",
    run: (p) => PENDLE_YT_HANDLERS["pendle.yt.sell"]!(p, ctx),
    params: { chain: "ethereum", tokenIn: YT, tokenOut: USDC, amountIn: "100" },
    setup: () => mockConvert.mockResolvedValue(convertResponse("swap")),
  },
  {
    toolId: "pendle.claim",
    run: (p) => PENDLE_YT_HANDLERS["pendle.claim"]!(p, ctx),
    params: { chain: "ethereum" },
  },
  {
    toolId: "pendle.py.mint",
    run: (p) => PENDLE_PY_HANDLERS["pendle.py.mint"]!(p, ctx),
    params: { chain: "ethereum", pt: PT, tokenIn: USDC, amountIn: "100" },
    setup: () => mockConvertMulti.mockResolvedValue(convertResponse("mint-py")),
  },
  {
    toolId: "pendle.py.redeem",
    run: (p) => PENDLE_PY_HANDLERS["pendle.py.redeem"]!(p, ctx),
    params: { chain: "ethereum", pt: PT, amountIn: "100" },
    setup: () => mockConvertMulti.mockResolvedValue(convertResponse("redeem-py", [{ token: PT, amount: "1" }])),
  },
  {
    toolId: "pendle.lp.add",
    run: (p) => PENDLE_LP_HANDLERS["pendle.lp.add"]!(p, ctx),
    params: { chain: "ethereum", market: MARKET_ADDR, tokenIn: USDC, amountIn: "100" },
    setup: () => mockConvertMulti.mockResolvedValue(convertResponse("add-liquidity")),
  },
  {
    toolId: "pendle.lp.remove",
    run: (p) => PENDLE_LP_HANDLERS["pendle.lp.remove"]!(p, ctx),
    params: { chain: "ethereum", market: MARKET_ADDR, amountIn: "100" },
    setup: () => mockConvertMulti.mockResolvedValue(convertResponse("remove-liquidity", [{ token: MARKET_ADDR, amount: "1" }])),
  },
];

// ── 1. Unproven outcomes, per tool ───────────────────────────────────

describe.each(MUTATING_TOOLS)("$toolId — unproven broadcast", ({ toolId, run, params, setup }) => {
  beforeEach(() => setup?.());

  it("an AMBIGUOUS submit surfaces the hash and forbids a retry", async () => {
    submitOutcome = "ambiguous";
    const res = (await run(params)) as Res;
    expectUnprovenBroadcast(res, toolId);
    // The exact sentence the card fixes — ambiguity resolves automatically.
    expect(res.output).toContain(
      "Cannot prove whether this broadcast landed — do not retry; this attempt is recorded as pending and resolves automatically.",
    );
  });

  it("a MINED REVERT is reported as a revert, not as an unknown outcome", async () => {
    submitOutcome = "reverted";
    const res = (await run(params)) as Res;
    expect(res.success).toBe(false);
    expect(res.output).toContain(TX_HASH);
    expect(res.output).toContain("reverted on-chain");
    expect(res.data?.status).toBe("reverted");
  });

  it("a mined-but-UNDECODABLE receipt never confirms a quoted amount", async () => {
    submitOutcome = "confirmed"; // node says success; receipt proves no transfer
    const res = (await run(params)) as Res;
    expect(res.success).toBe(false);
    expect(res.output).toContain(TX_HASH);
    expect(res.output).toMatch(/do not retry/i);
    // Whatever the wording, it must never assert a fill it cannot prove.
    expect(res.output).not.toMatch(/executedAmount/);
  });
});

// ── 2. Pre-broadcast refusals keep the legacy wording ────────────────

describe("a PRE-broadcast refusal never mentions a broadcast", () => {
  it("pendle.pt.buy keeps its byte-identical legacy message", async () => {
    mockConvert.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = (await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" }, ctx,
    )) as Res;
    expectPreBroadcastRefusal(
      res,
      // The pinned wording now also carries the REAL cause (owner decree
      // 2026-08-02, Codex blocker 4): a code + hint alone hid what actually
      // went wrong. The property this test exists to protect is UNCHANGED and
      // still asserted by `expectPreBroadcastRefusal` — no broadcast, no hash,
      // nothing signed.
      `Pendle buy failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.`
      + ` — Pendle asset catalogue for chain 1 is unreadable.)`,
    );
  });

  it("pendle.pt.redeem keeps its byte-identical legacy message", async () => {
    mockBuildAssetMap.mockRejectedValue(CATALOGUE_UNREADABLE);
    const res = (await PENDLE_PT_HANDLERS["pendle.pt.redeem"]!(
      { chain: "ethereum", tokenIn: PT, amountIn: "100" }, ctx,
    )) as Res;
    expectPreBroadcastRefusal(
      res,
      // The pinned wording now also carries the REAL cause (owner decree
      // 2026-08-02, Codex blocker 4): a code + hint alone hid what actually
      // went wrong. The property this test exists to protect is UNCHANGED and
      // still asserted by `expectPreBroadcastRefusal` — no broadcast, no hash,
      // nothing signed.
      `Pendle redeem failed (${ErrorCodes.PENDLE_INVALID_RESPONSE}: Retry shortly; do not treat this as an empty catalogue.`
      + ` — Pendle asset catalogue for chain 1 is unreadable.)`,
    );
  });

  // Owner decree (2026-08-02, rules/04): a plain (non-Vex) throw on a WRITE
  // path must reach the model as its REAL cause. Until now `failureDetail`
  // answered "unexpected error" for every one of the ~40 Pendle write sites,
  // so the agent could not tell "the wallet cannot pay" (only the user can fix
  // it) from a transient RPC blip (retrying is correct) — and retried blind.
  it("a plain Error on the write path surfaces the REAL cause, never 'unexpected error'", async () => {
    mockConvert.mockRejectedValue(
      new Error(
        "The total cost (gas * gas fee + value) of executing this transaction "
        + "exceeds the balance of the account.",
      ),
    );
    const res = (await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" }, ctx,
    )) as Res;

    expect(res.success).toBe(false);
    expect(res.output).not.toContain("unexpected error");
    expect(res.output).toContain("exceeds the balance");
    // Classified, so the agent is told the remedy instead of guessing one.
    expect(res.output).toContain("top up the wallet");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  // Codex blocker 4: the WRAPPED case. `tools/pendle/erc20.ts` turns a failed
  // approval into `VexError(APPROVAL_FAILED, "Failed to reset allowance: <the
  // node's real words>")` — and the old code+hint-only rendering threw those
  // words away, so an unpayable wallet reached the agent as a bare code it
  // could only retry. Code and hint still LEAD; the real cause follows.
  it("a WRAPPED VexError surfaces the cause buried in its message", async () => {
    mockConvert.mockRejectedValue(
      new VexError(
        ErrorCodes.APPROVAL_FAILED,
        "Failed to reset allowance: The total cost (gas * gas fee + value) of "
        + "executing this transaction exceeds the balance of the account.",
        "Check the transaction hash before retrying.",
      ),
    );
    const res = (await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" }, ctx,
    )) as Res;

    expect(res.success).toBe(false);
    expect(res.output).toContain(ErrorCodes.APPROVAL_FAILED);
    expect(res.output).toContain("Check the transaction hash before retrying.");
    expect(res.output).toContain("exceeds the balance");
    expect(res.output).toContain("top up the wallet");
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  it("a no-route refusal is RECORDED as a hashless definitively_failed row", async () => {
    // A refusal must be as visible in Agent Scan as a fill — "nothing happened"
    // was previously indistinguishable from "nothing was recorded".
    mockConvert.mockResolvedValue(null);
    const res = (await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" }, ctx,
    )) as Res;

    expect(res.success).toBe(false);
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
    expect(mockPreBroadcastFailure).toHaveBeenCalledTimes(1);
    const recorded = mockPreBroadcastFailure.mock.calls[0]![0] as { event: Record<string, unknown> };
    expect(recorded.event).toMatchObject({ kind: "yield", eventRole: "yield_pt", failureCode: "route_not_found" });
  });

  it("a mutation without a session refuses before creating any row", async () => {
    const res = (await PENDLE_PT_HANDLERS["pendle.pt.buy"]!(
      { chain: "ethereum", tokenIn: USDC, tokenOut: PT, amountIn: "100" },
      { walletResolution: {}, walletPolicy: {} } as never,
    )) as Res;
    expect(res.success).toBe(false);
    expect(res.output).toContain("requires an active session");
    expect(mockCreateIntent).not.toHaveBeenCalled();
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });
});

// ── 3. The intent always precedes the signature ──────────────────────

describe("the durable intent is created BEFORE anything is signed", () => {
  it.each(MUTATING_TOOLS)("$toolId stages a yield row first", async ({ run, params, setup }) => {
    setup?.();
    submitOutcome = "ambiguous";
    await run(params);
    expect(mockCreateIntent).toHaveBeenCalledTimes(1);
    const intent = mockCreateIntent.mock.calls[0]![0] as { namespace: string; events: Record<string, unknown>[] };
    expect(intent.namespace).toBe("pendle");
    expect(intent.events[0]).toMatchObject({ kind: "yield", protocol: "pendle", sessionId: "session-1" });
    expect(String(intent.events[0]!.eventRole)).toMatch(/^yield_/);
  });
});
