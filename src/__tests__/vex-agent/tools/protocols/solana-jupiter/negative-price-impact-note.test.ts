/**
 * A NEGATIVE price impact on a Jupiter swap quote must explain itself where the
 * number is printed - the same note `kyberswap.swap.quote` already carries.
 *
 * SIGN CONVENTION (the precondition for reusing that note): Jupiter's
 * `priceImpactPct` is a decimal FRACTION and is COST-POSITIVE, pinned by a live
 * three-run capture in `solana-jupiter/swap-route-projector.ts` (sign settled
 * 2026-08-03): "0" at small size, positive and growing as size moves the pool,
 * so a NEGATIVE value is the anomaly (output supposedly worth more than input) -
 * identical semantics to KyberSwap's Vex-derived (inUsd - outUsd) / inUsd.
 *
 * Cases mirror `kyberswap-handlers/negative-price-impact-note.test.ts` one for
 * one, in the FRACTION unit the provider reports.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const SESSION_ADDRESS = "So11111111111111111111111111111111111111112";

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => SESSION_ADDRESS,
  resolveSigningWallet: vi.fn(),
  walletScopeErrorToResult: (err: unknown) => ({
    success: false,
    output: err instanceof Error ? err.message : String(err),
  }),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedTokenWithSafety: async (raw: string) => ({
    token: { address: raw, symbol: raw === "SOL" ? "SOL" : "USDC", name: raw, decimals: 9 },
    safety: null,
  }),
}));

vi.mock("@tools/solana-ecosystem/shared/solana-transaction.js", () => ({
  getSolanaConnection: () => ({}),
}));

const mockPrepare = vi.fn();

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareFeeBearingJupiterSwap: (...args: unknown[]) => mockPrepare(...args),
  buildJupiterFeePreview: () => ({ bps: 25 }),
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { swapQuoteHandler } from "@vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-quote-handler.js";
import { NEGATIVE_PRICE_IMPACT_NOTE } from "@vex-agent/tools/protocols/price-impact-note.js";

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

/** `priceImpactPct` is the provider's FRACTION string; `null` = provider gave nothing readable. */
function mockQuote(priceImpactPct: string | null): void {
  mockPrepare.mockResolvedValue({
    raw: {
      inAmount: "1000000000",
      outAmount: "1000000000",
      otherAmountThreshold: "990000000",
      ...(priceImpactPct === null ? {} : { priceImpactPct }),
      routePlan: [],
    },
  });
}

async function quoteSummary(): Promise<string> {
  const result = await swapQuoteHandler(
    { tokenIn: "SOL", tokenOut: "USDC", amountIn: "1" },
    ctx(),
  );
  expect(result.success).toBe(true);
  return String((JSON.parse(result.output) as { summary: string }).summary);
}

describe("solana.swap.quote - negative price impact carries its meaning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains a materially negative impact right after the number", async () => {
    mockQuote("-0.02");
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact -2.00%.");
    expect(summary).toContain(NEGATIVE_PRICE_IMPACT_NOTE);
    // The note follows the number it explains, never replaces it.
    expect(summary.indexOf(NEGATIVE_PRICE_IMPACT_NOTE)).toBeGreaterThan(summary.indexOf("Price impact"));
  });

  it("says nothing extra on a positive impact - the ordinary case", async () => {
    mockQuote("0.01");
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact 1.00%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("says nothing extra on a zero impact", async () => {
    mockQuote("0");
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact 0.00%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("stays quiet on a tiny negative impact - rounding noise is not a warning", async () => {
    mockQuote("-0.0005");
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact -0.05%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("stays quiet at exactly the epsilon - the threshold is strictly below", async () => {
    mockQuote("-0.001");
    const summary = await quoteSummary();

    expect(summary).toContain("Price impact -0.10%.");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });

  it("says nothing when the impact could not be derived at all", async () => {
    mockQuote(null);
    const summary = await quoteSummary();

    expect(summary).not.toContain("Price impact");
    expect(summary).not.toContain(NEGATIVE_PRICE_IMPACT_NOTE);
  });
});
