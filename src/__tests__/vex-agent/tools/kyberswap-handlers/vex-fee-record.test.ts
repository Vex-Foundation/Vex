/**
 * `kyberswap.swap.execute` — what the durable row records about VEX'S OWN FEE
 * (migration 050 Part 2).
 *
 * The fee Vex charges is taken inside the swap transaction, so it has no row of
 * its own the way a bridge fee does. Before these columns existed the only
 * trace was `usd_vex_fee_est`, an ESTIMATE that is NULL whenever no USD price
 * is available — indistinguishable, to the agent reading the row back, from
 * "Vex charged nothing".
 *
 * These tests pin the fix as behaviour, against the REAL captured
 * `/route/build` bytes (the calldata guard is not mocked, so the handler only
 * reaches the intent write if the actual decoder accepted actual provider
 * bytes):
 *
 *   - the swap leg records the exact amount, its token, and its decimals;
 *   - it records them even when the USD estimate is unavailable — the whole
 *     point of the column;
 *   - a leg that charges NO Vex fee (an allowance approve) leaves every fee
 *     column unset, so "all null" is a positive statement of "no fee".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress, formatUnits, type Hex } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import capture from "../../../kyberswap/fixtures/route-build/base-usdc-to-native-50bps.json" with { type: "json" };
import { compliantRoutePaths } from "../../../kyberswap/fixtures/route-build/compliant-swap-build.js";

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
const mockPlanKyberAllowance = vi.fn();
const mockSignStageBroadcast = vi.fn();
const mockDecodeKyberSwapSettlement = vi.fn(() => null as { amountInRaw: string; amountOutRaw: string } | null);

// Only the evm-utils BARREL is mocked; `evm/swap-calldata-guard.js` stays REAL,
// so the fee line in the captured calldata is genuinely verified before the
// handler records anything.
vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
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

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } }),
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
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";

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
const AMOUNT_IN_RAW = BigInt(capture.routeSummary.amountIn);
/** 25 bps of 10 USDC = 0.025 USDC = 25000 atomic units at 6 decimals. */
const EXPECTED_FEE_RAW = (AMOUNT_IN_RAW * BigInt(KYBERSWAP_FEE_BPS)) / 10_000n;

interface RecordedVexFee {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals: number;
  amountRaw: string;
  amountHuman: string;
}

interface RecordedEvent {
  eventRole: string;
  vexFee?: RecordedVexFee;
  usdVexFeeEst?: string;
}

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
  };
}

function execute(params: Record<string, unknown> = {}) {
  return KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
    { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT_IN_HUMAN, ...params },
    ctx(),
  );
}

function buildResponse(over: Record<string, unknown> = {}) {
  return {
    data: {
      routerAddress: capture.routerAddress,
      data: capture.build.data as Hex,
      transactionValue: capture.build.transactionValue,
      amountIn: capture.build.amountIn,
      amountOut: capture.build.amountOut,
      amountInUsd: "10", amountOutUsd: "10", gasUsd: "0.01",
      ...over,
    },
  };
}

/** The event rows the handler asked the repo to create, in plan order. */
function recordedEvents(): RecordedEvent[] {
  expect(mockCreateAgentActivityIntent).toHaveBeenCalledTimes(1);
  const call = mockCreateAgentActivityIntent.mock.calls[0]![0] as { events: RecordedEvent[] };
  return call.events;
}

function swapLeg(): RecordedEvent {
  const leg = recordedEvents().find((e) => e.eventRole === "swap");
  expect(leg).toBeDefined();
  return leg!;
}

describe("kyberswap.swap.execute — the Vex fee recorded as a token amount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
    mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "USDC", name: "USD Coin", decimals: 6, isNative: false as const,
    }));
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });
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
    mockBuildRoute.mockResolvedValue(buildResponse());
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 42, events: [{ id: 100 }, { id: 101 }] });
    mockSignStageBroadcast.mockResolvedValue({ kind: "confirmed", txHash: "0xswap", receipt: { logs: [] } });
    mockDecodeKyberSwapSettlement.mockReturnValue({
      amountInRaw: capture.routeSummary.amountIn,
      amountOutRaw: capture.build.amountOut,
    });
  });

  it("records the exact fee the router keeps, with its token and decimals", async () => {
    const result = await execute();
    expect(result.success).toBe(true);

    const { vexFee } = swapLeg();
    expect(vexFee).toEqual({
      tokenAddress: TOKEN_IN,
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      amountRaw: EXPECTED_FEE_RAW.toString(),
      amountHuman: formatUnits(EXPECTED_FEE_RAW, 6),
    });
    // Stated absolutely, not just relative to the constant: 25 bps of 10 USDC.
    expect(vexFee!.amountRaw).toBe("25000");
    expect(vexFee!.amountHuman).toBe("0.025");
  });

  it("the recorded fee is a COMPONENT of the input amount, never an extra debit", async () => {
    await execute();

    const leg = swapLeg() as RecordedEvent & { tokenIn: { amountRaw: string } };
    // The user is debited `amountIn`; the router keeps the fee out of it and
    // swaps the rest. Adding the two would double-count the fee.
    expect(BigInt(leg.vexFee!.amountRaw)).toBeLessThan(BigInt(leg.tokenIn.amountRaw));
    expect(leg.tokenIn.amountRaw).toBe(AMOUNT_IN_RAW.toString());
  });

  it("records the fee amount even when NO USD estimate can be derived", async () => {
    // The provider returned an unusable input-side USD figure, so the USD
    // estimate is impossible. The fee itself is still a known fact.
    mockBuildRoute.mockResolvedValue(buildResponse({ amountInUsd: "" }));

    const result = await execute();
    expect(result.success).toBe(true);

    const leg = swapLeg();
    expect(leg.usdVexFeeEst).toBeUndefined();
    expect(leg.vexFee?.amountRaw).toBe("25000");
    expect(leg.vexFee?.tokenDecimals).toBe(6);
  });

  it("leaves every fee field unset on an allowance leg, which charges no Vex fee", async () => {
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: true, needsApprove: true });

    await execute();

    const events = recordedEvents();
    const allowanceLegs = events.filter((e) => e.eventRole.startsWith("allowance"));
    expect(allowanceLegs).toHaveLength(2);
    for (const leg of allowanceLegs) {
      expect(leg.vexFee).toBeUndefined();
      expect(leg.usdVexFeeEst).toBeUndefined();
    }
    // ...while the swap leg in the SAME execution still carries the fee, so the
    // difference is a real signal and not a blanket omission.
    expect(swapLeg().vexFee?.amountRaw).toBe("25000");
  });
});
