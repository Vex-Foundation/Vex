/**
 * `kyberswap.swap.execute` - post-buy delivery verification (Phase A1).
 *
 * Live incident 2026-08-10 (Robinhood Chain 4663): the agent bought 43,932 TOM,
 * the transaction confirmed, and `decodeKyberSwapSettlement` read a Transfer of
 * 43,932 TOM to the wallet from the receipt logs. `balanceOf(wallet)` was zero -
 * the logs were contract-authored theatre. Every exit attempt then failed for
 * five minutes while the agent blamed indexer lag and retried blind.
 *
 * Mock wiring follows `mined-revert-role-wording.test.ts` (same handler, same
 * seams); the contract pinned here is the delivery check itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

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
  claimSwapExecutionSnapshot: (...args: unknown[]) => mockClaim(...args),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
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
    sessionId: "session-post-buy-delivery",
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

describe("kyberswap.swap.execute - post-buy delivery verification", () => {
  it("reads balanceOf for the ACQUIRED token and the buying wallet, once", async () => {
    await execute();

    expect(mockReadErc20Balance).toHaveBeenCalledTimes(1);
    const call = mockReadErc20Balance.mock.calls[0] ?? [];
    expect(call[1]).toBe(TOKEN_B);
    expect(call[2]).toBe(SESSION_EVM.address);
  });

  it("appends the zero-delivery verdict to a confirmed buy that delivered nothing", async () => {
    mockReadErc20Balance.mockResolvedValue(0n);

    const result = await execute();

    expect(result.success).toBe(true);
    expect(result.output).toContain(ZERO_VERDICT);
    expect(result.output).toContain("do not retry the sale on this evidence");
  });

  it("says nothing when the wallet actually holds the acquired token", async () => {
    const result = await execute();

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(ZERO_VERDICT);
  });

  it("says nothing, and does not fail the swap, when the read itself fails", async () => {
    mockReadErc20Balance.mockRejectedValue(new Error("rpc down"));

    const result = await execute();

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(ZERO_VERDICT);
  });

  it("still verifies delivery when the settlement was undecodable", async () => {
    mockDecodeSettlement.mockReturnValue(null);
    mockReadErc20Balance.mockResolvedValue(0n);

    const result = await execute();

    expect(result.success).toBe(true);
    expect(result.output).toContain(ZERO_VERDICT);
  });

  it("never reads on a non-local chain", async () => {
    mockGetLocalChain.mockReturnValue(undefined);

    await execute();

    expect(mockReadErc20Balance).not.toHaveBeenCalled();
  });
});
