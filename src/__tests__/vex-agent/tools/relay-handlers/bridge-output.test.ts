/**
 * Relay bridge output projection (W3b, §4) — the m6 unit-confusion guard.
 *
 * A raw smallest-unit value is NEVER printed as a human amount: when Relay gives
 * no `amountFormatted` and the raw value cannot be `formatUnits`-converted (no
 * decimals), the human `amount` stays null and the raw value is preserved
 * verbatim in `amountRaw` — a consumer labels it "<raw> (raw units)" explicitly.
 */
import { describe, it, expect } from "vitest";

import { bridgeSideDisplay, bridgeSummaryLine } from "@vex-agent/tools/protocols/relay/handlers/bridge-output.js";
import type { RelayQuoteSide } from "@tools/relay/quote.js";
import type { RelayChain } from "@tools/relay/types.js";

const ERC20 = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const CHAINS: readonly RelayChain[] = [];

function side(overrides: Partial<RelayQuoteSide> = {}): RelayQuoteSide {
  return {
    symbol: "USDC",
    decimals: null,
    currencyAddress: ERC20,
    amountRaw: null,
    amountFormatted: null,
    amountUsd: null,
    minimumAmountRaw: null,
    ...overrides,
  };
}

describe("bridgeSideDisplay — human amount vs raw smallest-unit (m6)", () => {
  it("uses Relay's amountFormatted as the human amount and keeps the raw verbatim", () => {
    const result = bridgeSideDisplay(side({ amountFormatted: "0.001", amountRaw: "1000000000000000", decimals: 18 }), ERC20, 8453, CHAINS);
    expect(result.amount).toBe("0.001");
    expect(result.amountRaw).toBe("1000000000000000");
  });

  it("formats amountRaw with decimals when amountFormatted is absent", () => {
    const result = bridgeSideDisplay(side({ amountFormatted: null, amountRaw: "1000000", decimals: 6 }), ERC20, 8453, CHAINS);
    expect(result.amount).toBe("1"); // 1000000 / 10^6
    expect(result.amountRaw).toBe("1000000");
  });

  it("NEVER promotes a raw fallback into the human amount when decimals are unknown (m6 bug)", () => {
    const result = bridgeSideDisplay(side({ amountFormatted: null, amountRaw: null, decimals: null }), ERC20, 8453, CHAINS, "1000000");
    // The human amount stays null — the raw value must not masquerade as human.
    expect(result.amount).toBeNull();
    // ...but the raw value is preserved verbatim so nothing is lost (OWNER RULE).
    expect(result.amountRaw).toBe("1000000");
  });

  it("prefers side.amountRaw over the caller's rawFallback for the raw field", () => {
    const result = bridgeSideDisplay(side({ amountFormatted: null, amountRaw: "42", decimals: null }), ERC20, 8453, CHAINS, "999");
    expect(result.amount).toBeNull(); // no decimals → not human-convertible
    expect(result.amountRaw).toBe("42");
  });

  it("carries a null raw when neither the side nor the caller has one", () => {
    const result = bridgeSideDisplay(side({ amountFormatted: null, amountRaw: null, decimals: null }), ERC20, 8453, CHAINS);
    expect(result.amount).toBeNull();
    expect(result.amountRaw).toBeNull();
  });
});

describe("bridgeSummaryLine — labels raw units, never silent confusion (m6)", () => {
  const from = { id: 8453, name: "Base" };
  const to = { id: 4663, name: "Robinhood Chain" };

  it("shows the human amount when present", () => {
    const line = bridgeSummaryLine({ token: "ETH", tokenAddress: ERC20, amount: "0.001", amountRaw: "1000000000000000", usd: "2.94" }, from, to);
    expect(line).toContain("0.001 ETH");
    expect(line).not.toContain("raw units");
    expect(line).toContain("(~$2.94 in, est.)");
  });

  it("labels the raw value explicitly when no human amount is available", () => {
    const line = bridgeSummaryLine({ token: "USDC", tokenAddress: ERC20, amount: null, amountRaw: "1000000", usd: null }, from, to);
    expect(line).toContain("1000000 (raw units) USDC");
  });

  it("omits the amount gracefully when neither human nor raw is available", () => {
    const line = bridgeSummaryLine({ token: "USDC", tokenAddress: ERC20, amount: null, amountRaw: null, usd: null }, from, to);
    expect(line).toContain("the requested amount USDC");
    expect(line).not.toContain("raw units");
  });
});
