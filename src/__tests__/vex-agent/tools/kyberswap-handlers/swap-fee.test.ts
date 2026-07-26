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
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");
import { KYBERSWAP_FEE_RECEIVER } from "@tools/kyberswap/constants.js";

const SESSION_EVM = {
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

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
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

vi.mock("@tools/kyberswap/aggregator/client.js", () => ({
  getKyberAggregatorClient: () => ({
    getRoute: (...args: unknown[]) => mockGetRoute(...args),
    buildRoute: vi.fn(),
  }),
}));

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

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

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
    mockGetRoute.mockResolvedValue({
      data: {
        routeSummary: {
          amountIn: "1000000",
          amountInUsd: "1.00",
          amountOut: "999000",
          amountOutUsd: "0.99",
          gasUsd: "0.5",
          route: [[{ pool: "0xpool1" }]],
        },
        routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
      },
    });
    mockReadErc20Metadata.mockReset();
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
    mockVerifyRouterAddress.mockReset();
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

  it("execute handler's route call sends the SAME four fee fields (stopped right after getRoute)", async () => {
    // Force a stop right after getRoute — proves the fee params without
    // needing the full staged-broadcast path mocked.
    mockVerifyRouterAddress.mockImplementation(() => {
      throw new Error("stop-after-getRoute (test boundary)");
    });

    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(mockGetRoute).toHaveBeenCalledTimes(1);
    const params = mockGetRoute.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toMatchObject(EXPECTED_FEE);
    expect(params.feeReceiver).toBe(KYBERSWAP_FEE_RECEIVER);
  });

  it("quote and execute send IDENTICAL fee fields (same route the user saw executes)", async () => {
    await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx({ sessionPermission: "restricted", approved: false }),
    );
    const quoteParams = mockGetRoute.mock.calls[0]![1] as Record<string, unknown>;

    mockGetRoute.mockClear();
    mockVerifyRouterAddress.mockImplementation(() => {
      throw new Error("stop-after-getRoute (test boundary)");
    });
    await KYBERSWAP_HANDLERS["kyberswap.swap.execute"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
      ctx(),
    );
    const execParams = mockGetRoute.mock.calls[0]![1] as Record<string, unknown>;

    const feeOf = (p: Record<string, unknown>) => ({
      feeAmount: p.feeAmount,
      isInBps: p.isInBps,
      chargeFeeBy: p.chargeFeeBy,
      feeReceiver: p.feeReceiver,
    });
    expect(feeOf(quoteParams)).toEqual(feeOf(execParams));
    expect(feeOf(quoteParams)).toEqual(EXPECTED_FEE);
  });
});
