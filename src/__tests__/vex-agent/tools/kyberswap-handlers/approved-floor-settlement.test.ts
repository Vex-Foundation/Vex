/**
 * `kyberswap.swap.execute` - the confirmed fill, assessed against the floor the
 * human approved.
 *
 * DETECTION, after the funds have moved. Prevention lives at the execute, which
 * refuses to sign calldata carrying any floor but the approved one; this is the
 * layer that catches what signing cannot - a fee-on-transfer output, a router
 * that under-delivers, or a settlement recorded for a transaction this process
 * never watched. It must never change the settlement status or any attested
 * field, so the tests pin `status: "confirmed"` and the recorded executed
 * amounts on BOTH the short and the met paths.
 *
 * The floor read is the leg's own `route_provenance.approvedMinOutRaw` - the
 * non-attested duplicate written at intent time - so this exercises the
 * persisted number, not a second in-memory copy.
 *
 * Mock wiring is the `post-buy-delivery.test.ts` scaffold (same handler, same
 * seams); the contract pinned here is the floor assessment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";
import { APPROVED_FLOOR_ALLOWANCE_RAW } from "@tools/evm-chains/post-buy-delivery.js";
import { formatUnits } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890AbcdEF1234567890aBcdef12345678" as `0x${string}`,
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};

const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_EVM.address);
const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => SESSION_EVM);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  walletScopeErrorToResult: (err: unknown) => ({ success: false, output: String(err) }),
}));

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));
const mockPlanKyberAllowance = vi.fn();
const mockSignStageBroadcast = vi.fn();
const mockDecodeSettlement = vi.fn();

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: (...args: unknown[]) => mockDecodeSettlement(...args),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
}));

const mockReadErc20Balance = vi.fn();
vi.mock("@tools/evm-chains/erc20-reads.js", () => ({
  ERC20_READ_ABI: [],
  readErc20Balance: (...args: unknown[]) => mockReadErc20Balance(...args),
  readErc20Decimals: vi.fn(),
}));

const mockGetLocalChain = vi.fn();
vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: (...args: unknown[]) => mockGetLocalChain(...args),
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
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/tools/protocols/runtime/pending-provenance.js", () => ({
  noteHandlerPendingReason: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/tracked-tokens.js", () => ({
  pinTrackedToken: vi.fn().mockResolvedValue({ inserted: true }),
}));

// The execute CLAIMS the approved quote instead of fetching a route (the
// 2026-08-27 quote-binding change). The claim's own behaviour is covered by
// `quote-bound-execute.test.ts` and the Postgres claim suite; here it hands
// back a real snapshot of this file's own route so the handler reaches the
// behaviour under test.
const mockClaim = vi.fn();
vi.mock("@vex-agent/tools/protocols/prequote/claim.js", () => ({
  commitPrequoteClaim: vi.fn(async () => ({ ok: true })),
  readSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@utils/logger.js", () => {
  const stub = { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { KYBERSWAP_HANDLERS } = await import("@vex-agent/tools/protocols/kyberswap/handlers.js");
const { compliantSwapCalldata, compliantRoutePaths } = await import(
  "../../../kyberswap/fixtures/route-build/compliant-swap-build.js"
);

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const ZERO_VERDICT = "balanceOf returned zero immediately after the confirmed buy";

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-approved-floor",
  };
}

function execute(params: Record<string, unknown> = {}) {
  const handler = KYBERSWAP_HANDLERS["kyberswap.swap.execute"];
  if (!handler) throw new Error("kyberswap.swap.execute is not registered");
  return handler(
    { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", ...params },
    ctx(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSelectedAddress.mockReturnValue(SESSION_EVM.address);
  mockResolveSigningWallet.mockReturnValue(SESSION_EVM);
  mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
    address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
  }));
  mockPlanKyberAllowance.mockResolvedValue({ needsReset: false, needsApprove: false });
  const routeResponse = {
    data: {
      routeSummary: {
        amountIn: "1000000", amountOut: "999000", gasUsd: "0.5", routeID: "r1", checksum: "c1",
        route: compliantRoutePaths({
          srcToken: TOKEN_A, dstToken: TOKEN_B, amountIn: 10n ** 18n, quotedNetOutRaw: "999000",
        }),
      },
      routerAddress: ROUTER,
    },
  };
  mockGetRoute.mockResolvedValue(routeResponse);
  mockClaim.mockImplementation(
    async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) =>
      approvedClaim(
        routeResponse.data.routeSummary,
        typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
        { amountInRaw: 10n ** 18n },
      ),
  );
  mockBuildRoute.mockResolvedValue({
    data: {
      routerAddress: ROUTER,
      data: compliantSwapCalldata({
        srcToken: TOKEN_A, dstToken: TOKEN_B, dstReceiver: SESSION_EVM.address,
        amountIn: 10n ** 18n, quotedNetOutRaw: "999000", slippageBps: 50,
      }),
      // The provider's own gas figure for the swap leg. MEASURED live on Base
      // 2026-08-31: `/route/build` answered `gas: "287581"` for a real USDC route.
      gas: "287581",
      transactionValue: "0",
      amountIn: "1000000", amountOut: "999000",
      amountInUsd: "1", amountOutUsd: "1", gasUsd: "0.1",
    },
  });
  mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 300, events: [{ id: 100 }] });
  mockSignStageBroadcast.mockResolvedValue({
    kind: "confirmed",
    txHash: "0xswap",
    receipt: { blockNumber: 900n, logs: [] },
  });
  mockDecodeSettlement.mockReturnValue({ amountInRaw: "1000000", amountOutRaw: "999000" });
  mockGetLocalChain.mockReturnValue({ id: 1, name: "Local" });
  mockReadErc20Balance.mockResolvedValue(999000n);
});


/** The floor the fixture's approved quote implies at the default tolerance. */
const APPROVED_FLOOR = computeApprovedMinOut("999000", VEX_DEFAULT_SLIPPAGE_BPS);

/** The `route_provenance` the intent actually recorded for the swap leg. */
function recordedRouteProvenance(): Record<string, unknown> {
  const call = mockCreateAgentActivityIntent.mock.calls[0];
  if (call === undefined) throw new Error("test expected an intent to be created");
  const created = call[0] as {
    events: readonly { eventRole: string; routeProvenance?: Record<string, unknown> }[];
  };
  const swapEvent = created.events.find((e) => e.eventRole === "swap");
  if (swapEvent?.routeProvenance === undefined) {
    throw new Error("test expected the swap leg to carry route provenance");
  }
  return swapEvent.routeProvenance;
}

describe("kyberswap.swap.execute - the confirmed fill against the approved floor", () => {
  it("names a fill BELOW the approved floor, in the summary and as a machine field", async () => {
    // One raw unit past the allowance: short by more than the provider's own
    // rederivation slack can explain.
    const short = APPROVED_FLOOR - APPROVED_FLOOR_ALLOWANCE_RAW - 1n;
    mockDecodeSettlement.mockReturnValue({ amountInRaw: "1000000", amountOutRaw: short.toString() });

    const result = await execute();
    const data = JSON.parse(result.output ?? "") as {
      approvedFloorCheck?: string;
      summary: string;
      status: string;
      amountOut: string;
    };

    expect(data.approvedFloorCheck).toContain("Fill below the approved floor");
    expect(data.approvedFloorCheck).toContain(short.toString());
    expect(data.approvedFloorCheck).toContain(APPROVED_FLOOR.toString());
    // The agent reads the first line, so the warning is in it too.
    expect(data.summary).toContain("Fill below the approved floor");

    // DETECTION ONLY: the settlement is still a confirmed swap, and the
    // reported output is still the DECODED executed amount.
    expect(result.success).toBe(true);
    expect(data.status).toBe("confirmed");
    expect(data.amountOut).toBe(formatUnits(short, 18));
  });

  it("emits ONE structured warn naming the shortfall, never the raw amounts as prose", async () => {
    const short = APPROVED_FLOOR - APPROVED_FLOOR_ALLOWANCE_RAW - 5n;
    mockDecodeSettlement.mockReturnValue({ amountInRaw: "1000000", amountOutRaw: short.toString() });

    await execute();

    const warns = mockLoggerWarn.mock.calls.filter(
      (c) => c[0] === "kyberswap.swap.execute.fill_below_approved_floor",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.[1]).toMatchObject({
      txHash: "0xswap",
      shortfallRaw: (APPROVED_FLOOR - short).toString(),
    });
  });

  it("says NOTHING when the fill is exactly one raw unit under the floor - the measured build slack", async () => {
    // MEASURED (live 2026-08-27 and 2026-08-28): `/route/build` echoes the
    // quoted amountOut minus exactly one raw unit, so a floor derived from the
    // quote sits one unit above what an honest build can deliver. That single
    // unit is the granularity of the arithmetic, never a percentage.
    const atFloorMinusOne = APPROVED_FLOOR - APPROVED_FLOOR_ALLOWANCE_RAW;
    mockDecodeSettlement.mockReturnValue({
      amountInRaw: "1000000",
      amountOutRaw: atFloorMinusOne.toString(),
    });

    const result = await execute();
    const data = JSON.parse(result.output ?? "") as { approvedFloorCheck?: string; status: string };

    expect(data.approvedFloorCheck).toBeUndefined();
    expect(data.status).toBe("confirmed");
    expect(
      mockLoggerWarn.mock.calls.filter((c) => c[0] === "kyberswap.swap.execute.fill_below_approved_floor"),
    ).toHaveLength(0);
  });

  it("says nothing about the floor on an ordinary fill at the quoted amount", async () => {
    const result = await execute();
    const data = JSON.parse(result.output ?? "") as { approvedFloorCheck?: string; summary: string };

    expect(data.approvedFloorCheck).toBeUndefined();
    expect(data.summary).not.toContain("approved floor");
  });

  it("assesses the floor the INTENT recorded, not a second in-memory copy", async () => {
    await execute();

    expect(recordedRouteProvenance().approvedMinOutRaw).toBe(APPROVED_FLOOR.toString());
  });

  it("stays silent when the row carries no recorded floor - an absent number proves nothing", async () => {
    // A settlement for an intent written before the floor was recorded. The
    // assessment must decline rather than invent a verdict from `undefined`.
    mockCreateAgentActivityIntent.mockImplementation(async (input: unknown) => {
      const typed = input as { events: { eventRole: string; routeProvenance?: Record<string, unknown> }[] };
      for (const event of typed.events) {
        if (event.routeProvenance) delete event.routeProvenance.approvedMinOutRaw;
      }
      return { executionId: 300, events: [{ id: 100 }] };
    });
    mockDecodeSettlement.mockReturnValue({ amountInRaw: "1000000", amountOutRaw: "1" });

    const result = await execute();
    const data = JSON.parse(result.output ?? "") as { approvedFloorCheck?: string; status: string };

    expect(data.approvedFloorCheck).toBeUndefined();
    expect(data.status).toBe("confirmed");
  });
});
