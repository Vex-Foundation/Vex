/**
 * `kyberswap.swap.execute` — a mined revert must be explained PER LEG ROLE.
 *
 * The staged-broadcast loop signs up to three legs (allowance_reset, allowance,
 * swap) and records `failure_code = 'mined_revert'` for whichever one the chain
 * reverted. The persisted `failure_reason` was `"<role> transaction 0x… reverted
 * on-chain."` for every one of them: it named the role but explained nothing,
 * and the obvious next step — the swap leg's price-guard remedy — is FALSE for
 * an approve. An ERC-20 `approve` has no minimum-output guard, so raising
 * `slippageBps` after an allowance revert changes nothing and burns another
 * approval's worth of gas.
 *
 * The row's reason is what the agent reads back through the transactions
 * inspect view, so it is the text that decides the retry. It must therefore be
 * true FOR THE LEG THAT REVERTED:
 *   - swap leg  → price-guard remedy (re-quote with a higher slippageBps),
 *   - approve leg → NOT a price guard; retry once, then treat the token's
 *     approval path as broken.
 *
 * The tx hash is deliberately no longer repeated in the reason — the row's own
 * `tx_hash` column carries it, and the repo boundary masks hash-shaped text
 * anyway (`sanitizeFailureReason`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SESSION_EVM = {
  family: "eip155" as const,
  // Already EIP-55 checksummed: the handler re-derives it with `getAddress()`.
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

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: (...args: unknown[]) => mockPlanKyberAllowance(...args),
  buildApproveCalldata: vi.fn(() => "0xapprove"),
  signStageBroadcast: (...args: unknown[]) => mockSignStageBroadcast(...args),
  decodeKyberSwapSettlement: vi.fn(() => null),
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
const mockFailActivityEvent = vi.fn().mockResolvedValue({ applied: true, row: {} });

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: (...args: unknown[]) => mockCreateAgentActivityIntent(...args),
  createAgentActivityPreBroadcastFailure: vi.fn().mockResolvedValue({ executionId: 1, event: { id: 1 } }),
  markActivityBroadcast: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  markBroadcastAccepted: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  confirmActivityEvent: vi.fn().mockResolvedValue({ applied: true, row: {} }),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  abortPlannedEvents: vi.fn().mockResolvedValue(undefined),
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

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-mined-revert",
  };
}

function execute() {
  const handler = KYBERSWAP_HANDLERS["kyberswap.swap.execute"];
  if (!handler) throw new Error("kyberswap.swap.execute is not registered");
  return handler({ chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" }, ctx());
}

/** The reason recorded on the row `failActivityEvent` was called for. */
function recordedReason(eventId: number): string {
  const call = mockFailActivityEvent.mock.calls.find((c) => c[0] === eventId);
  if (!call) throw new Error(`failActivityEvent was not called for event ${eventId}`);
  return (call[1] as { failureReason: string }).failureReason;
}

const REVERTED = (txHash: string) => ({ kind: "reverted", txHash, receipt: { blockNumber: 900n } });

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
  mockFailActivityEvent.mockResolvedValue({ applied: true, row: {} });
});

describe("kyberswap.swap.execute — the SWAP leg's mined-revert reason", () => {
  beforeEach(() => {
    mockCreateAgentActivityIntent.mockResolvedValue({ executionId: 214, events: [{ id: 100 }] });
    mockSignStageBroadcast.mockResolvedValueOnce(REVERTED("0xswap"));
  });

  it("explains that gas was spent and nothing was swapped", async () => {
    await execute();

    const reason = recordedReason(100);
    expect(reason).toContain("mined revert: the transaction was included on-chain and reverted");
    expect(reason).toContain("gas was spent and nothing was swapped");
  });

  it("names the price guard and the parameter that answers it", async () => {
    await execute();

    const reason = recordedReason(100);
    expect(reason).toContain("the price guard");
    expect(reason).toContain("re-quote and retry with a higher slippageBps");
  });

  it("says the node returned no decoded reason rather than inventing one", async () => {
    await execute();

    expect(recordedReason(100)).toContain("The node returned no decoded reason.");
  });
});

describe("kyberswap.swap.execute — an APPROVE leg's mined-revert reason is not the swap's", () => {
  beforeEach(() => {
    // A USDT-style reset-then-approve plan: allowance_reset, allowance, swap.
    mockPlanKyberAllowance.mockResolvedValue({ needsReset: true, needsApprove: true });
    mockCreateAgentActivityIntent.mockResolvedValue({
      executionId: 215, events: [{ id: 200 }, { id: 201 }, { id: 202 }],
    });
    // The FIRST leg (allowance_reset) reverts; nothing after it is attempted.
    mockSignStageBroadcast.mockResolvedValueOnce(REVERTED("0xreset"));
  });

  it("names the reverting role and says the approval did not take effect", async () => {
    await execute();

    const reason = recordedReason(200);
    expect(reason).toContain("mined revert: the allowance_reset transaction was included on-chain and reverted");
    expect(reason).toContain("the approval did not take effect");
  });

  it("REFUSES the price-guard remedy — raising slippage cannot fix an approve", async () => {
    await execute();

    const reason = recordedReason(200);
    expect(reason).toContain("This is not a price guard");
    expect(reason).toContain("rather than raising slippage");
    expect(reason).not.toContain("re-quote and retry with a higher slippageBps");
    expect(reason).not.toContain("nothing was swapped");
  });

  it("tells the agent when to stop retrying the approval instead of looping", async () => {
    await execute();

    const reason = recordedReason(200);
    expect(reason).toContain("re-estimate and retry once");
    expect(reason).toContain("treat the token's approval path as broken");
  });
});
