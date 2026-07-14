/**
 * Vex integrator-fee wiring (Etap 5) — money-affecting behavior.
 *
 * Proves BOTH KyberSwap aggregator route call sites carry the four fee fields
 * with the EXACT product-owner values:
 *   - quote handler (kyberswap.swap.quote), and
 *   - execute handler's internal re-quote (kyberswap.swap.sell, driven via the
 *     dryRun path so it stops before broadcast but still fetches the fee'd route).
 *
 * The fee must be IDENTICAL on both so the route the user saw and the route that
 * executes carry the same fee line. The fee is NOT a tool param — it can never
 * be model-controlled — so these assert on the client mock's received params.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { KYBERSWAP_FEE_RECEIVER } from "@tools/kyberswap/constants.js";

const SESSION_EVM = {
  family: "eip155" as const,
  address: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const mockResolveSigningWallet = vi.fn(() => SESSION_EVM);
const mockResolveSelectedAddress = vi.fn(() => SESSION_EVM.address);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: (...args: unknown[]) => mockResolveSigningWallet(...args),
  resolveSelectedAddress: (...args: unknown[]) => mockResolveSelectedAddress(...args),
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

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  ensureKyberAllowance: vi.fn().mockResolvedValue(undefined),
  sendKyberTransaction: vi.fn().mockResolvedValue("0xmockhash"),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
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
  }),
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

  it("execute handler's route call sends the SAME four fee fields", async () => {
    const result = await KYBERSWAP_HANDLERS["kyberswap.swap.sell"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", dryRun: true },
      ctx(),
    );
    expect(result.success).toBe(true);
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
    await KYBERSWAP_HANDLERS["kyberswap.swap.sell"]!(
      { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1", dryRun: true },
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
