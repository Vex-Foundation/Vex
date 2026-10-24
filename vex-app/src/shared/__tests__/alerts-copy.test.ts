import { describe, expect, it } from "vitest";
import {
  alertChainName,
  alertConditionWords,
  firedAlertSentence,
  formatAlertPrice,
} from "../alerts-copy.js";

describe("alerts copy", () => {
  it("cuts long fractions without rounding and keeps small prices visible", () => {
    expect(formatAlertPrice("4000")).toBe("4000");
    expect(formatAlertPrice("3500.123456789")).toBe("3500.123456");
    expect(formatAlertPrice("4012.500")).toBe("4012.5");
    expect(formatAlertPrice("0.000012345678901")).toBe("0.0000123456");
  });

  it("names chains as people say them", () => {
    expect(alertChainName("solana")).toBe("Solana");
    expect(alertChainName("base")).toBe("Base");
  });

  it("words every condition", () => {
    expect(alertConditionWords("above", "4000")).toBe("above $4000");
    expect(alertConditionWords("below", "2.5")).toBe("below $2.5");
    expect(alertConditionWords("rises_pct", "5")).toBe("rises 5%");
    expect(alertConditionWords("falls_pct", "12.5")).toBe("falls 12.5%");
  });

  it("writes one sentence per fired alert, with the note after it", () => {
    const base = { label: "WETH", chain: "base", value: "5", triggeredPrice: "3675", note: null };
    expect(firedAlertSentence({ ...base, condition: "rises_pct" })).toBe("WETH on Base rose 5%, at $3675.");
    expect(firedAlertSentence({ ...base, condition: "falls_pct", note: "  check it  " })).toBe(
      "WETH on Base fell 5%, at $3675. Note: check it",
    );
  });
});
