/**
 * missionSummaryModel — the summary card's money strings, without React.
 *
 * The card is a thin map over these, so this is where the null-guarding and
 * the sign rules are pinned. The theme running through every case: a missing
 * input prints an em dash, never a fabricated figure — a summary card that
 * invents a number is worse than one that admits it does not know.
 */

import { describe, expect, it } from "vitest";
import {
  formatPnlEth,
  formatPnlPct,
  formatPnlUsd,
  formatTrades,
  pnlToneClass,
} from "../missionSummaryModel.js";

describe("formatPnlUsd", () => {
  it("values the ETH PnL at the run's close price", () => {
    // Mission #9's actual row: -0.00031936869485788 x 1782.65 = -$0.5693.
    expect(formatPnlUsd(-0.00031936869485788, 1782.65)).toBe("-$0.57");
  });

  it("signs a gain", () => {
    expect(formatPnlUsd(0.002, 1800)).toBe("+$3.60");
  });

  it("em-dashes when there is no close price to value it with", () => {
    expect(formatPnlUsd(0.002, null)).toBe("—");
  });

  it("em-dashes when the PnL itself is unknown", () => {
    expect(formatPnlUsd(null, 1800)).toBe("—");
  });
});

describe("formatPnlEth", () => {
  it("signs and suffixes the native figure", () => {
    expect(formatPnlEth(0.0012)).toBe("+0.0012 ETH");
    expect(formatPnlEth(-0.0034)).toBe("-0.0034 ETH");
  });

  it("drops the suffix rather than labelling a missing figure as ETH", () => {
    expect(formatPnlEth(null)).toBe("—");
  });
});

describe("formatPnlPct", () => {
  it("signs the percent", () => {
    expect(formatPnlPct(1.2)).toBe("+1.20%");
    expect(formatPnlPct(-3.4)).toBe("-3.40%");
  });

  it("returns empty string when unknown, so the headline drops it entirely", () => {
    // A dash beside a real PnL would read as a value; nothing reads as nothing.
    expect(formatPnlPct(null)).toBe("");
    expect(formatPnlPct(Number.NaN)).toBe("");
  });
});

describe("formatTrades", () => {
  it("pluralises", () => {
    expect(formatTrades(0)).toBe("0 trades");
    expect(formatTrades(1)).toBe("1 trade");
    expect(formatTrades(2)).toBe("2 trades");
  });
});

describe("pnlToneClass", () => {
  it("tones a gain as success and a loss as destructive", () => {
    expect(pnlToneClass(0.01)).toContain("success");
    expect(pnlToneClass(-0.01)).toContain("destructive");
  });

  it("stays muted for flat and for unknown", () => {
    expect(pnlToneClass(0)).toBe("text-[var(--vex-text-2)]");
    expect(pnlToneClass(null)).toBe("text-[var(--vex-text-3)]");
  });
});
