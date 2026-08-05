/**
 * W2c — the quote signals an agent needs in order to DECLINE a bad bridge, and
 * the `/chains` health signal that predicts a hanging fill.
 *
 * Live probe 2026-08-03 (Base 8453 → Robinhood 4663, 0.0001 ETH, slippage
 * "100"): `details.currencyOut.minimumAmount` = "87581903292038" (the worst-case
 * received amount — the number `slippageBps` actually controls),
 * `details.totalImpact.percent` = "-11.53", and
 * `details.slippageTolerance.destination.percent` = "0.99". All three were
 * parsed away before this wave. The same probe shows every chain carrying
 * `blockProductionLagging`, which is precisely the condition under which a fill
 * hangs.
 */

import { describe, it, expect } from "vitest";

import { adaptRelayQuote } from "@tools/relay/quote.js";
import { evaluateRelayRouteHealth } from "@tools/relay/health.js";
import { RelayQuoteResponseSchema, type RelayChain } from "@tools/relay/types.js";

/** The live probe's `details{}`, verbatim apart from the sanitized identities. */
const LIVE_QUOTE = RelayQuoteResponseSchema.parse({
  steps: [{
    id: "deposit", kind: "transaction", requestId: "0xreq",
    items: [{ data: { to: "0x2222222222222222222222222222222222222222", value: "100000000000000", data: "0x", chainId: 8453 } }],
  }],
  fees: { relayer: { amountUsd: "0.02" } },
  details: {
    operation: "swap",
    currencyIn: {
      currency: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      amount: "100000000000000", amountFormatted: "0.0001", amountUsd: "0.184091",
      minimumAmount: "100000000000000",
    },
    currencyOut: {
      currency: { symbol: "ETH", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
      amount: "88466568981856", amountFormatted: "0.000088466568981856", amountUsd: "0.162859",
      minimumAmount: "87581903292038",
    },
    totalImpact: { usd: "-0.021232", percent: "-11.53" },
    slippageTolerance: {
      origin: { usd: "0.000000", value: "0", percent: "0.00" },
      destination: { usd: "0.001612", value: "884665689818", percent: "0.99" },
    },
    rate: "0.88466568981856",
    timeEstimate: 2,
    isFixedRate: false,
  },
});

describe("adaptRelayQuote — worst-case out, total impact, applied tolerance", () => {
  it("projects the guaranteed floor and the impact an agent needs to decline", () => {
    const adapted = adaptRelayQuote(LIVE_QUOTE);
    expect(adapted.currencyOut.minimumAmountRaw).toBe("87581903292038");
    expect(adapted.currencyIn.minimumAmountRaw).toBe("100000000000000");
    expect(adapted.totalImpactPercent).toBe("-11.53");
    expect(adapted.destinationSlippagePercent).toBe("0.99");
  });

  it("degrades every new field to null rather than rejecting a quote that omits them", () => {
    const adapted = adaptRelayQuote(RelayQuoteResponseSchema.parse({ steps: [], details: {} }));
    expect(adapted.currencyOut.minimumAmountRaw).toBeNull();
    expect(adapted.totalImpactPercent).toBeNull();
    expect(adapted.destinationSlippagePercent).toBeNull();
  });
});

function chain(id: number, extra: Record<string, unknown> = {}): RelayChain {
  return { id, name: `chain-${id}`, vmType: "evm", depositEnabled: true, disabled: false, ...extra } as RelayChain;
}

describe("evaluateRelayRouteHealth — blockProductionLagging", () => {
  it("names the lagging side WITHOUT making the route unserviceable", () => {
    const health = evaluateRelayRouteHealth(
      [chain(8453), chain(4663, { blockProductionLagging: true })],
      8453,
      4663,
    );
    expect(health.serviceable).toBe(true);
    if (!health.serviceable) return;
    expect(health.blockProductionLagging).toEqual(["destination"]);
  });

  it("reports no lag when neither side is lagging or the field is absent", () => {
    const health = evaluateRelayRouteHealth([chain(8453), chain(4663, { blockProductionLagging: false })], 8453, 4663);
    expect(health.serviceable).toBe(true);
    if (!health.serviceable) return;
    expect(health.blockProductionLagging).toEqual([]);
  });
});
