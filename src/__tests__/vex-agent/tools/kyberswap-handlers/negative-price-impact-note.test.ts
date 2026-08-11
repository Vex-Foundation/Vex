/**
 * A NEGATIVE price impact on a KyberSwap quote must explain itself where the
 * number is printed.
 *
 * WHY THIS FILE EXISTS - live 2026-08-10: in a day-trading mission the agent
 * spent four separate reasoning passes re-deriving what a negative
 * `priceImpact` means. Vex derives it as (inUsd - outUsd) / inUsd
 * (`kyberswap/helpers.ts`), so negative = the quoted output is priced ABOVE the
 * reference input value - on thin or fresh pools a stale/fragmented pricing
 * signal, not free money. The semantic is universal, so the note is not
 * chain-gated.
 *
 * Scaffold mirrors `quote-safety.test.ts` (read-only quote template).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

type WalletResolveModule = typeof import("@vex-agent/tools/internal/wallet/resolve.js");

const SESSION_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as const;
const mockResolveSelectedAddress = vi.fn<WalletResolveModule["resolveSelectedAddress"]>(() => SESSION_ADDRESS);

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (...args: Parameters<WalletResolveModule["resolveSelectedAddress"]>) => mockResolveSelectedAddress(...args),
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

const mockReadErc20Metadata = vi.fn(async (_slug: string, address: string) => ({
  address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
}));

vi.mock("@tools/kyberswap/evm-utils.js", () => ({
  getKyberEvmClients: () => ({ publicClient: {}, walletClient: {} }),
  readErc20Metadata: (...args: [string, string]) => mockReadErc20Metadata(...args),
  verifyRouterAddress: vi.fn(),
  planKyberAllowance: vi.fn(),
  buildApproveCalldata: vi.fn(),
  signStageBroadcast: vi.fn(),
  decodeKyberSwapSettlement: vi.fn(),
}));

vi.mock("@tools/kyberswap/token-api/client.js", () => ({
  getKyberTokenApiClient: () => ({
    searchTokens: vi.fn().mockResolvedValue([]),
    getHoneypotFotInfo: vi.fn().mockResolvedValue({ isHoneypot: false, isFOT: false, tax: 0 }),
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
import { NEGATIVE_PRICE_IMPACT_NOTE } from "@vex-agent/tools/protocols/kyberswap/handlers/swap/price-impact-note.js";

const TOKEN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

/**
 * Drive the derived impact by the USD legs: impact = (inUsd - outUsd) / inUsd.
 * `amountOutUsd: null` makes the impact unparseable, i.e. the null case.
 */
function mockRoute(amountInUsd: string, amountOutUsd: string | null): void {
  mockGetRoute.mockResolvedValue({
    data: {
      routeSummary: {
        amountIn: "1000000000000000000",
        amountInUsd,
        amountOut: "1000000000000000000",
        ...(amountOutUsd === null ? {} : { amountOutUsd }),
        gasUsd: "0.5",
        route: [[{ pool: "0xpool1", exchange: "uniswapv3", swapAmount: "1000000000000000000" }]],
      },
      routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    },
  });
}

async function quoteSummary(): Promise<string> {
  const result = await KYBERSWAP_HANDLERS["kyberswap.swap.quote"]!(
    { chain: "ethereum", tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: "1" },
    ctx(),
  );
  expect(result.success).toBe(true);
  return String((JSON.parse(result.output) as { summary: string }).summary);
}

describe("kyberswap.swap.quote - negative price impact carries its meaning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSelectedAddress.mockReturnValue(SESSION_ADDRESS);
    mockReadErc20Metadata.mockImplementation(async (_slug: string, address: string) => ({
      address, symbol: "TKN", name: "Token", decimals: 18, isNative: false as const,
    }));
  });

  it("explains a materially negative impact right after the number", async () => {
    mockRoute("100", "102"); // impact = -0.02
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact -2.00%.");
    expect(summary).toContain(NEGATIVE_PRICE_IMPACT_NOTE);
    // The note follows the number it explains, never replaces it.
    expect(summary.indexOf(NEGATIVE_PRICE_IMPACT_NOTE)).toBeGreaterThan(summary.indexOf("Price impact"));
  });

  it("says nothing extra on a positive impact - the ordinary case", async () => {
    mockRoute("100", "99"); // impact = +0.01
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact 1.00%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("says nothing extra on a zero impact", async () => {
    mockRoute("100", "100");
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact 0.00%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("stays quiet on a tiny negative impact - rounding noise is not a warning", async () => {
    mockRoute("100", "100.05"); // impact = -0.0005, inside the epsilon
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact -0.05%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("stays quiet at exactly the epsilon - the threshold is strictly below", async () => {
    mockRoute("100", "100.1"); // impact = exactly -0.001, the epsilon itself
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact -0.10%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("says nothing when the impact could not be derived at all", async () => {
    mockRoute("100", null);
    const summary = await quoteSummary();

    expect(summary).not.toContain("Price impact");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });
});
