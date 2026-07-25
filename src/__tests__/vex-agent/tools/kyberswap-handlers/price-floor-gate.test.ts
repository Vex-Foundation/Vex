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
 * The load-bearing property in every refusal case: `signStageBroadcast` is
 * never called. Nothing is signed, so nothing can be broadcast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import capture from "../../../kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };

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
vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
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

const mockFindFreshMatchedSwapPrequote = vi.fn();

vi.mock("@vex-agent/tools/protocols/swap-prequote.js", () => ({
  findFreshMatchedSwapPrequote: (...args: unknown[]) => mockFindFreshMatchedSwapPrequote(...args),
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

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { KYBERSWAP_HANDLERS } from "@vex-agent/tools/protocols/kyberswap/handlers.js";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { computeApprovedMinOut, toRouteRef } from "@tools/kyberswap/swap-price-floor.js";

const TOKEN_IN = getAddress(capture.request.tokenIn);
const TOKEN_OUT = capture.request.tokenOut;
const ROUTE_OUT = capture.routeSummary.amountOut;
/** 10 USDC at 6 decimals — matches the capture's `amountIn` of 10000000. */
const AMOUNT_IN_HUMAN = "10";

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

/** A persisted prequote row carrying the floor Vex approved at quote time. */
function prequoteWithFloor(slippageBps: number, quotedNetOutRaw: string = ROUTE_OUT) {
  return {
    prequoteId: "prequote-1",
    routeRef: toRouteRef({
      quotedNetOutRaw,
      slippageBps,
      approvedMinOutRaw: computeApprovedMinOut(quotedNetOutRaw, slippageBps).toString(),
    }),
  };
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

function buildResponse(calldata: Hex = capture.build.data as Hex) {
  return {
    data: {
      routerAddress: capture.routerAddress,
      data: calldata,
      transactionValue: capture.build.transactionValue,
      amountIn: capture.build.amountIn,
      amountOut: capture.build.amountOut,
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

describe("kyberswap.swap.execute — approved price floor", () => {
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
        },
        routerAddress: capture.routerAddress,
      },
    });
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(prequoteWithFloor(50));
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

  it("refuses when the calldata floor is below the APPROVED floor — nothing signed, recorded as slippage", async () => {
    // The market moved: the persisted floor was set against a materially
    // higher quoted output than the build now promises.
    const richerQuote = (BigInt(ROUTE_OUT) * 110n / 100n).toString();
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(prequoteWithFloor(50, richerQuote));

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
    const failure = recordedFailure();
    expect(failure.failureCode).toBe("slippage");
    expect(result.output).toContain("Refused before signing");
    expect(result.output).toContain("fresh kyberswap.swap.quote");
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

  it("refuses when no approved floor is on record — never signs an unprotected build", async () => {
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(null);

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
    // Refused before the provider was even asked for a route.
    expect(mockGetRoute).not.toHaveBeenCalled();
    expect(recordedFailure().failureCode).toBe("slippage");
    expect(result.output).toContain("kyberswap.swap.quote");
  });

  it("refuses when the persisted prequote carries no price floor (a pre-upgrade quote)", async () => {
    mockFindFreshMatchedSwapPrequote.mockResolvedValue({ prequoteId: "prequote-1", routeRef: null });

    const result = await execute();

    expect(result.success).toBe(false);
    expectNothingSigned();
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
        },
        routerAddress: capture.routerAddress,
      },
    });
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }] });
    mockCreateAgentActivityPreBroadcastFailure.mockResolvedValue({ executionId: 7, event: { id: 7 } });
    mockSignStageBroadcast.mockReset();
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReset();
    mockDecodeKyberSwapSettlement.mockReturnValue({ amountInRaw: "10000000", amountOutRaw: capture.build.amountOut });
  });

  it("accepts 1000 bps — exactly the owner-pinned ceiling", async () => {
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(prequoteWithFloor(1000));

    const result = await execute({ slippageBps: 1000 });

    expect(result.success).toBe(true);
    expect(mockSignStageBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBuildRoute.mock.calls[0]![1]).toMatchObject({ slippageTolerance: 1000 });
  });

  it("rejects 1001 bps — one basis point over the ceiling, never clamped down to it", async () => {
    mockFindFreshMatchedSwapPrequote.mockResolvedValue(prequoteWithFloor(1001));

    const result = await execute({ slippageBps: 1001 });

    expect(result.success).toBe(false);
    expectNothingSigned();
    expect(mockGetRoute).not.toHaveBeenCalled();
    expect(mockBuildRoute).not.toHaveBeenCalled();
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
