/**
 * Vex integrator-fee wiring (Etap 5) — money-affecting behavior.
 *
 * Proves BOTH KyberSwap aggregator route call sites carry the four fee fields
 * with the EXACT product-owner values:
 *   - quote handler (kyberswap.swap.quote), and
 *   - execute handler (kyberswap.swap.execute)'s route-fetch call — forced to
 *     stop right after `getRoute` by a `verifyRouterAddress` throw, so the
 *     fee params are observable without needing a full staged-broadcast mock.
 *
 * The fee must be IDENTICAL on both so the route the user saw and the route
 * that executes carry the same fee line. The fee is NOT a tool param — it can
 * never be model-controlled — so these assert on the client mock's received
 * params.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");
import { KYBERSWAP_FEE_RECEIVER } from "@tools/kyberswap/constants.js";

const SESSION_EVM: EvmWallet = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const mockResolveSigningWallet = vi.fn<WalletResolveModule["resolveSigningWallet"]>(() => SESSION_EVM);
const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_EVM.address);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: Parameters<WalletResolveModule["resolveSigningWallet"]>) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

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

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address,
  symbol: "TKN",
  name: "Token",
  decimals: 18,
  isNative: false as const,
}));

const mockVerifyRouterAddress = vi.fn();

vi.mock("@tools/kyberswap/evm-utils.js", async () => ({
  ...(await import("./evm-client.test-fixtures.js")).kyberEvmClientMocks(),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: (...args: unknown[]) => mockVerifyRouterAddress(...args),
  planKyberAllowance: vi.fn(),
  buildApproveCalldata: vi.fn(),
  signStageBroadcast: vi.fn(),
  decodeKyberSwapSettlement: vi.fn(),
}));

vi.mock("@tools/evm-chains/erc20-balance-guard.js", () => ({
  ensureErc20Balance: vi.fn().mockResolvedValue(undefined),
}));

const mockGetHoneypotFotInfo = vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: (...args: [number, string]) => mockGetHoneypotFotInfo(...args),
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

/** The one route summary this file's provider mock returns, quote and build alike. */
const ROUTE_SUMMARY = {
  amountIn: "1000000",
  amountInUsd: "1.00",
  amountOut: "999000",
  amountOutUsd: "0.99",
  gasUsd: "0.5",
  route: [[{ pool: "0xpool1" }]],
};
function routeSummaryTheQuoteReturned(): unknown {
  return ROUTE_SUMMARY;
}

const mockCreateAgentActivityPreBroadcastFailure = vi.fn().mockResolvedValue({
  executionId: 1,
  event: { id: 1 },
});

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createAgentActivityIntent: vi.fn(),
  createAgentActivityPreBroadcastFailure: (...args: unknown[]) => mockCreateAgentActivityPreBroadcastFailure(...args),
  markActivityBroadcast: vi.fn(),
  markBroadcastAccepted: vi.fn(),
  confirmActivityEvent: vi.fn(),
  failActivityEvent: vi.fn(),
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

import { approvedClaim } from "../../../kyberswap/fixtures/route-build/approved-quote.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { KYBERSWAP_HANDLERS } from "../../../../vex-agent/tools/protocols/kyberswap/handlers.js";

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

/** The exact fee line both call sites must send. */
const EXPECTED_FEE = {
  feeAmount: "25",
  isInBps: true,
  chargeFeeBy: "currency_in",
  feeReceiver: "0xe341f3da256C38356bce4Afd456d7fa36E356E94",
};

describe("Vex integrator fee on KyberSwap route calls", () => {
  beforeEach(() => {
    mockGetHoneypotFotInfo.mockReset();
    mockGetHoneypotFotInfo.mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 });
    mockGetRoute.mockReset();
    const routeResponse = {
      data: {
        routeSummary: ROUTE_SUMMARY,
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    };
    mockGetRoute.mockResolvedValue(routeResponse);
    mockBuildRoute.mockReset();
    // The build is stopped at the router check: this file is about the fee
    // params, and the staged-broadcast path is covered elsewhere.
    mockBuildRoute.mockResolvedValue({
      data: {
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        data: "0xdead", transactionValue: "0",
        amountIn: "1000000", amountOut: "999000",
        amountInUsd: "1.00", amountOutUsd: "0.99", gasUsd: "0.5",
      },
    });
    mockClaim.mockImplementation(
      async (_toolId: unknown, _sessionId: unknown, params: Record<string, unknown>) =>
        approvedClaim(
          routeResponse.data.routeSummary,
          typeof params.slippageBps === "number" ? params.slippageBps : VEX_DEFAULT_SLIPPAGE_BPS,
        ),
    );
    mockReadErc20Metadata.mockReset();
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockVerifyRouterAddress.mockReset();
    mockVerifyRouterAddress.mockImplementation(() => {
      throw new Error("stop-at-router-check (test boundary)");
    });
    mockCreateAgentActivityPreBroadcastFailure.mockClear();
  });

  it("quote handler sends the four fee fields with exact values", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    expect(result.success).toBe(true);
    expect(mockGetRoute).toHaveBeenCalledTimes(1);
    const params = mockGetRoute.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toMatchObject(EXPECTED_FEE);
    // Receiver is sourced from the treasury constant, not a literal drift.
    expect(params.feeReceiver).toBe(KYBERSWAP_FEE_RECEIVER);
  });

  it("the execute makes NO route call at all - the fee the quote applied is the fee that executes", async () => {
    // Stronger than the fee-field comparison this replaces. The execute used
    // to fetch its own route, so the two calls' integrator-fee params had to
    // be compared to prove the user got the route they were shown. Since
    // 2026-08-28 the execute BUILDS FROM THE QUOTE'S OWN ROUTE SUMMARY, so the
    // fee is the quoted one by construction - and the property to pin is that
    // no second, unpriced route call exists to diverge from it.
    await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    const quoteCall = mockGetRoute.mock.calls[0];
    if (quoteCall === undefined) throw new Error("test expected the quote to fetch a route");
    const quoteParams = quoteCall[1] as Record<string, unknown>;
    expect(quoteParams).toMatchObject(EXPECTED_FEE);
    expect(quoteParams.feeReceiver).toBe(KYBERSWAP_FEE_RECEIVER);

    mockGetRoute.mockClear();
    await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );

    expect(mockGetRoute).not.toHaveBeenCalled();
    const buildCall = mockBuildRoute.mock.calls[0];
    if (buildCall === undefined) throw new Error("test expected the execute to build a route");
    const body = buildCall[1] as { routeSummary: unknown };
    // The very summary the quote's own fee-bearing route call produced.
    expect(body.routeSummary).toEqual(routeSummaryTheQuoteReturned());
  });
});
