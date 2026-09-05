/**
 * `kyberswap.swap.execute` — the Vex-computed price floor and the slippage
 * ceiling, end to end through the handler.
 *
 * KyberSwap builds the swap calldata and embeds its own `minReturnAmount` in
 * an opaque blob; before this gate existed the handler verified only the
 * router address and signed the blob unread. These tests drive the REAL
 * calldata guard (never mocked) against a REAL captured `/route/build`
 * response, so "the build was refused" means the actual decoder rejected
 * actual provider bytes.
 *
 * The floor the build is held to is the APPROVED one: derived once, at quote
 * time, from the output the agent was shown, at the caller's own
 * `slippageBps`. It is NOT rederived from a fresh route at execute time - that
 * rederivation made the floor follow the market instead of bounding it and
 * produced the 2026-08-27 incident (a 313,879.7 CCF quote filling at 1,190.145
 * CCF without a revert). The incident itself is reproduced in
 * `quote-bound-execute.test.ts`; this file keeps the BUILD-INTEGRITY half -
 * what the provider's opaque calldata may and may not contain - plus the
 * slippage ceiling.
 *
 * There is still no zero-tolerance comparison anywhere: movement within the
 * approved slippage signs, which `quote-bound-execute.test.ts` pins.
 *
 * The load-bearing property in every refusal case: `signStageBroadcast` is
 * never called. Nothing is signed, so nothing can be broadcast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import capture from "../../../kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import { compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";
import { fixtureVexFeeBlock } from "../../../kyberswap/fixtures/route-build/approved-quote.js";

const SESSION_EVM = {
  family: "eip155" as const,
  // Must equal the fixture's `recipient` — the guard asserts the build sends
  // the output to the wallet Vex approved.
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const mockResolveSelectedAddress = vi.fn((..._args: unknown[]) => SESSION_EVM.address);
const mockResolveSigningWallet = vi.fn((..._args: unknown[]) => SESSION_EVM);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
}));
const mockSignStageBroadcast = vi.fn();
const mockDecodeKyberSwapSettlement = vi.fn(() => null as { amountInRaw: string; amountOutRaw: string } | null);

// NOTE: only the evm-utils BARREL is mocked. `evm/swap-calldata-guard.js` is
// imported directly by the handler and stays REAL — it is the unit under test.
vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn().mockResolvedValue({ needsReset: false, needsApprove: false }),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: (...args: unknown[]) => mockDecodeKyberSwapSettlement(...(args as [])),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 }),
  }),
}));

const mockGetRoute = vi.fn();
const mockBuildRoute = vi.fn();

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
    buildRoute: (...args: unknown[]) => mockBuildRoute(...args),
  }),
}));

const mockCreateAgentActivityIntent = vi.fn();
const mockCreateAgentActivityPreBroadcastFailure = vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } });

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: { id: 100 } }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

// The execute claims its approved quote instead of re-quoting. The claim's DB
// half is exercised against real Postgres in
// `integration/repos/swap-prequotes-claim.int.test.ts`; here it hands back the
// snapshot for the route each test set up, so the build-integrity cases below
// drive the real handler unchanged.
const mockClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
  readSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";

/**
 * The transaction set this suite's quote bound, matching the allowance plan its
 * own mocks produce - the execute refuses a set that is not the approved one
 * (WP2-B). The ceiling is high enough that no prepared request here is above it;
 * the ceiling itself is the subject of its own suite.
 */
const APPROVED_PLAN = buildBoundDebitPlan({
  legs: [{ role: "swap" as const, pricing: "measured" as const }],
  feeCap: { mode: "eip1559", maxFeePerGasWei: 10n ** 15n, maxPriorityFeePerGasWei: 10n ** 15n },
});

const TOKEN_IN = getAddress(capture.request.tokenIn);
const TOKEN_OUT = capture.request.tokenOut;
const ROUTE_OUT = capture.routeSummary.amountOut;
/**
 * The captured `routeSummary` was trimmed to the two fields the harness needed
 * in 2026-07-25, so its paths are reconstructed here. A real summary always
 * carries them, and the pre-sign guard reads them to decide which pools the
 * build may fund.
 */
const ROUTE_PATHS = compliantRoutePaths({
  srcToken: TOKEN_IN, dstToken: TOKEN_OUT, amountIn: BigInt(capture.routeSummary.amountIn), quotedNetOutRaw: ROUTE_OUT,
});
/** 10 USDC at 6 decimals — matches the capture's `amountIn` of 10000000. */
const AMOUNT_IN_HUMAN = "10";

/**
 * The claim result for a quote of `amountOut` at `slippageBps`.
 *
 * The tolerance defaults to the repo default because `execute()` below omits
 * `slippageBps`, and the handler refuses a snapshot priced at a different one:
 * the quote and the execute must agree on the number the floor was derived at.
 */
function claimed(amountOut: string = ROUTE_OUT, slippageBps = VEX_DEFAULT_SLIPPAGE_BPS) {
  const summary = {
    amountIn: capture.routeSummary.amountIn,
    amountOut,
    amountInUsd: "10", amountOutUsd: "9.99",
    gasUsd: "0.01", routeID: "r1", checksum: "c1",
    route: ROUTE_PATHS,
  };
  const encoded = encodeRouteSnapshotRaw(summary);
  if (!encoded.ok) throw new Error("fixture route must encode");
  return {
    ok: true as const,
    prequoteId: "prequote-1",
    // The Vex fee statement the row carries. The execute re-derives its own and
    // refuses before signing if the two disagree, so a claim without one is a
    // claim no fee-bearing execute may run on.
    vexFee: fixtureVexFeeBlock(BigInt(capture.routeSummary.amountIn)),
    routeSummary: summary,
    snapshot: sealRouteSnapshot({
      v: ROUTE_SNAPSHOT_VERSION,
      provider: "kyberswap" as const,
      raw: encoded.raw,
      approvedAmountOutRaw: amountOut,
      approvedMinOutRaw: computeApprovedMinOut(amountOut, slippageBps).toString(),
      approvedAmountOutHuman: "0.005376",
      approvedMinOutHuman: "0.005349",
      tokenOutSymbol: "NATIVE (ETH)",
      effectiveSlippageBps: slippageBps,
      expiresAt: "2026-08-28T10:00:00.000Z",
      eligibility: { kind: "executable" as const, priceImpactFraction: 0.001, adverse: false },
      debitPlan: APPROVED_PLAN,
    }),
  };
}

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...over,
  };
}

function execute(params: Record<string, unknown> = {}) {
  return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
    { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, ...params },
    ctx(),
  );
}

/** Re-encode the captured build with one patched `SwapDescriptionV2` field. */
function patchedCalldata(patch: Record<string, unknown>): Hex {
  const decoded = decodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    data: capture.build.data as Hex,
  });
  const execution = decoded.args[0] as unknown as Record<string, unknown>;
  const desc = execution.desc as Record<string, unknown>;
  return encodeFunctionData({
    abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
    functionName: "swap",
    args: [{ ...execution, desc: { ...desc, ...patch } }],
  } as never);
}

function buildResponse(calldata: Hex = capture.build.data as Hex, amountOut = capture.build.amountOut) {
  return {
    data: {
      routerAddress: capture.routerAddress,
      data: calldata,
      // The provider's own gas figure for the swap leg. MEASURED live on Base
      // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
      gas: "287581",
      transactionValue: capture.build.transactionValue,
      amountIn: capture.build.amountIn,
      amountOut,
      amountInUsd: "10", amountOutUsd: "10", gasUsd: "0.01",
    },
  };
}

/** The single fact every refusal must satisfy: nothing reached the signer. */
function expectNothingSigned() {
  expect(mockSignStageBroadcast).not.toHaveBeenCalled();
  expect(mockCreateAgentActivityIntent).not.toHaveBeenCalled();
}

function recordedFailure(): { failureCode: string; failureReason: string } {
  expect(mockCreateAgentActivityPreBroadcastFailure).toHaveBeenCalledTimes(1);
  const call = mockCreateAgentActivityPreBroadcastFailure.mock.calls[0]![0] as {
    event: { failureCode: string; failureReason: string };
  };
  return call.event;
}

describe("kyberswap.swap.execute — build calldata price floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
    }));
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: capture.routeSummary.amountIn,
          amountOut: ROUTE_OUT,
          gasUsd: "0.01", routeID: "r1", checksum: "c1",
          route: ROUTE_PATHS,
        },
        routerAddress: capture.routerAddress,
      },
    });
    mockClaim.mockResolvedValue(claimed());
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 7, event: { id: 7 } });
    mockSignStageBroadcast.mockReset();
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue({ amountInRaw: "10000000", amountOutRaw: capture.build.amountOut });
  });

  it("a compliant real build signs — the gate does not refuse honest traffic", async () => {
    const result = await execute();

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("confirmed");
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
  });

  it("a market that repriced WITHIN the approved slippage still signs - the floor is the quote's, not the market's", async () => {
    // 20 bps against the user since the quote, inside the 50 bps authorized.
    // The build is honest about the movement; the approved floor still admits
    // it, so this must reach the signer. A guard that refused here would strand
    // an autonomous agent on every pair that moves at all.
    const movedOut = ((BigInt(ROUTE_OUT) * 9980n) / 10000n).toString();
    mockBuildRoute.mockResolvedValue(
      buildResponse(patchedCalldata({ minReturnAmount: computeApprovedMinOut(ROUTE_OUT, 50) }), movedOut),
    );

    const result = await execute();

    expect(result.success).toBe(true);
    expect(mockCreateAgentActivityPreBroadcastFailure).not.toHaveBeenCalled();
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
  });

  it("refuses a build whose embedded floor was widened to a 50% tolerance", async () => {
    mockBuildRoute.mockResolvedValue(
      buildResponse(patchedCalldata({ minReturnAmount: computeApprovedMinOut(capture.build.amountOut, 5000) })),
    );

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(recordedFailure().failureCode).toBe("slippage");
  });

  it("refuses a fee-field mismatch — nothing signed, recorded as route_not_found", async () => {
    mockBuildRoute.mockResolvedValue(
      buildResponse(patchedCalldata({ feeReceivers: ["0x00000000000000000000000000000000DeaDBeef"] })),
    );

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(recordedFailure().failureCode).toBe("route_not_found");
    expect(result.output).toContain("Refused before signing");
  });

  it("refuses a build with _PARTIAL_FILL set — the fee would hit unswapped funds", async () => {
    const decoded = decodeFunctionData({
      abi: META_AGGREGATION_ROUTER_V2_SWAP_ABI,
      data: capture.build.data as Hex,
    });
    const flags = ((decoded.args[0] as unknown as { desc: { flags: bigint } }).desc.flags) | 0x01n;
    mockBuildRoute.mockResolvedValue(buildResponse(patchedCalldata({ flags })));

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(recordedFailure().failureCode).toBe("route_not_found");
  });

});

describe("kyberswap.swap.execute — slippage ceiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
    }));
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: capture.routeSummary.amountIn,
          amountOut: ROUTE_OUT,
          gasUsd: "0.01", routeID: "r1", checksum: "c1",
          route: ROUTE_PATHS,
        },
        routerAddress: capture.routerAddress,
      },
    });
    mockClaim.mockResolvedValue(claimed());
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 7, event: { id: 7 } });
    mockSignStageBroadcast.mockReset();
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue({ amountInRaw: "10000000", amountOutRaw: capture.build.amountOut });
  });

  it("accepts 1000 bps — exactly the owner-pinned ceiling", async () => {
    mockClaim.mockResolvedValue(claimed(ROUTE_OUT, 1000));
    const result = await execute({ slippageBps: 1000 });

    expect(result.success).toBe(true);
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBuildRoute.mock.calls[0]![1]).toMatchObject({ slippageTolerance: 1000 });
  });

  it("rejects 1001 bps — one basis point over the ceiling, never clamped down to it", async () => {
    const result = await execute({ slippageBps: 1001 });

    expect(result.success).toBe(false);
    expectNothingSigned();
    // The execute never fetches a route at all now; the load-bearing half is
    // that the tolerance is refused before the BUILD, so nothing was priced.
    expect(mockBuildRoute).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(result.output).toContain("must not exceed 1000");
  });

  it("rejects 5000 bps — the provider accepts it, Vex does not", async () => {
    const result = await execute({ slippageBps: 5000 });

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(mockBuildRoute).not.toHaveBeenCalled();
  });

  it("rejects a non-integer slippage rather than truncating it", async () => {
    const result = await execute({ slippageBps: 50.5 });

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(result.output).toContain("whole number of basis points");
    // Names the value the caller most plausibly meant, without choosing it.
    expect(result.output).toContain("pass 5050");
  });

  it("rejects 0.5 — the percentage-into-a-bps-field mistake, never read as 0", async () => {
    const result = await execute({ slippageBps: 0.5 });

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(result.output).toContain("pass 50");
  });

  it("rejects a negative slippage", async () => {
    const result = await execute({ slippageBps: -1 });

    expect(result.success).toBe(false);
    expectNothingSigned();
  });
});

describe("kyberswap.swap.quote — slippage ceiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: { amountIn: capture.routeSummary.amountIn, amountOut: ROUTE_OUT, amountInUsd: "10", amountOutUsd: "10", gasUsd: "0.01", route: [], routeID: "r1", checksum: "c1" },
        routerAddress: capture.routerAddress,
      },
    });
  });

  it("rejects an over-ceiling slippage before any provider call — no quote, so no floor to authorize it", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, slippageBps: 2000 },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("must not exceed 1000");
    expect(mockGetRoute).not.toHaveBeenCalled();
  });
});
