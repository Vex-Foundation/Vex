/**
 * Unit tests for the launch dialog's display arithmetic (Lane D).
 *
 * These pin the rule-90 invariants of a SPEND-CONSENT surface, not formatting
 * taste. The number these functions print is the number the user's Deploy click
 * authorizes, so each case below is an amount that must not be able to render
 * wrongly:
 *   - full 18-decimal precision survives (no float path anywhere);
 *   - an unreadable amount is an em-dash, never a zero;
 *   - the ceiling sum is msg.value + vexFee and CANNOT include gas;
 *   - a fee-drift refusal classifies as re-review, never as a generic error.
 */

import { describe, expect, it } from "vitest";
import {
  ceilingCheckedWei,
  classifyLaunchRefusal,
  formatWeiEth,
  formatWeiEthWithUnit,
  isAcceptableLaunchLink,
  parseEthInputToWei,
  parseWei,
  UNKNOWN_AMOUNT,
} from "../token-launch/launch-display.js";

describe("formatWeiEth", () => {
  it("renders the anchored creation fee exactly", () => {
    expect(formatWeiEth("1000000000000000")).toBe("0.001");
  });

  it("renders a whole-ETH prebuy without a fraction", () => {
    expect(formatWeiEth("2000000000000000000")).toBe("2");
  });

  it("renders zero as zero, not an em-dash", () => {
    // The default prebuy is 0 and that is a real, authorized value.
    expect(formatWeiEth("0")).toBe("0");
  });

  it("keeps the eighteenth decimal place (no float rounding)", () => {
    // 1 wei. Any parseFloat/Number path loses this digit entirely.
    expect(formatWeiEth("1")).toBe("0.000000000000000001");
  });

  it("keeps every digit of a value far past Number.MAX_SAFE_INTEGER", () => {
    // 1.234567890123456789 ETH — the low digits are exactly what a float drops.
    expect(formatWeiEth("1234567890123456789")).toBe("1.234567890123456789");
  });

  it("does not confuse trailing zeros inside the fraction", () => {
    expect(formatWeiEth("1001000000000000000")).toBe("1.001");
  });

  it("renders an em-dash for anything unreadable rather than a zero", () => {
    for (const bad of ["", "0x10", "-1", "1.5", " 1", "abc", null, undefined]) {
      expect(formatWeiEth(bad)).toBe(UNKNOWN_AMOUNT);
    }
  });

  it("appends the unit only when the value is real", () => {
    expect(formatWeiEthWithUnit("1000000000000000")).toBe("0.001 ETH");
    expect(formatWeiEthWithUnit(undefined)).toBe(UNKNOWN_AMOUNT);
  });
});

describe("parseWei", () => {
  it("accepts an unsigned digit run and nothing else", () => {
    expect(parseWei("42")).toBe(42n);
    expect(parseWei("+42")).toBeNull();
    expect(parseWei("4 2")).toBeNull();
  });
});

describe("ceilingCheckedWei", () => {
  it("sums msg.value and the Vex fee exactly", () => {
    // 0.001 ETH msg.value, 25 bps = 2500000000000 wei.
    expect(ceilingCheckedWei("1000000000000000", "2500000000000")).toBe(
      "1002500000000000",
    );
  });

  it("is msg.value alone when the DTO carries no Vex fee", () => {
    expect(ceilingCheckedWei("1000000000000000", undefined)).toBe(
      "1000000000000000",
    );
  });

  it("refuses to produce a partial sum when either term is unreadable", () => {
    expect(ceilingCheckedWei("nope", "2500000000000")).toBeNull();
    expect(ceilingCheckedWei("1000000000000000", "nope")).toBeNull();
  });
});

describe("parseEthInputToWei", () => {
  it("converts a typed ETH amount to exact wei without a float path", () => {
    expect(parseEthInputToWei("0.001")).toBe("1000000000000000");
    expect(parseEthInputToWei("1")).toBe("1000000000000000000");
    expect(parseEthInputToWei("1.234567890123456789")).toBe(
      "1234567890123456789",
    );
  });

  it("treats an unfilled field as the documented zero default", () => {
    expect(parseEthInputToWei("")).toBe("0");
    expect(parseEthInputToWei("   ")).toBe("0");
    expect(parseEthInputToWei("0")).toBe("0");
  });

  it("accepts the leading-dot and trailing-dot forms a user types mid-edit", () => {
    expect(parseEthInputToWei(".5")).toBe("500000000000000000");
    expect(parseEthInputToWei("2.")).toBe("2000000000000000000");
  });

  it("REFUSES more than 18 fractional digits rather than truncating them", () => {
    // Truncating the 19th digit would spend a different amount than the one
    // rendered on the consent line.
    expect(parseEthInputToWei("1.1234567890123456789")).toBeNull();
  });

  it("refuses anything that is not an unsigned decimal", () => {
    for (const bad of ["-1", "1e18", "1,5", "abc", ".", "0x1", "1 2"]) {
      expect(parseEthInputToWei(bad)).toBeNull();
    }
  });
});

describe("classifyLaunchRefusal", () => {
  it("routes every stale-preview refusal to re-review, never to a generic error", () => {
    expect(classifyLaunchRefusal("tokenLaunch.preview_stale")).toBe("re_review");
    expect(classifyLaunchRefusal("tokenLaunch.preview_expired")).toBe("re_review");
    expect(classifyLaunchRefusal("tokenLaunch.preview_unknown")).toBe("re_review");
  });

  it("routes both mission ceilings to the honest ceiling affordance", () => {
    expect(classifyLaunchRefusal("tokenLaunch.value_ceiling_exceeded")).toBe(
      "ceiling",
    );
    expect(classifyLaunchRefusal("tokenLaunch.launch_count_exceeded")).toBe(
      "ceiling",
    );
    expect(classifyLaunchRefusal("tokenLaunch.ceiling_not_set")).toBe("ceiling");
  });

  it("separates 'our side is not ready' from 'you did something wrong'", () => {
    expect(classifyLaunchRefusal("tokenLaunch.image_unavailable")).toBe(
      "unavailable",
    );
    expect(classifyLaunchRefusal("tokenLaunch.image_required")).toBe("image");
  });

  it("falls back to blocked for an unknown code instead of throwing", () => {
    expect(classifyLaunchRefusal("something.entirely.new")).toBe("blocked");
  });
});

describe("isAcceptableLaunchLink", () => {
  it("accepts https and an unfilled row", () => {
    expect(isAcceptableLaunchLink("https://vex.example/token")).toBe(true);
    expect(isAcceptableLaunchLink("")).toBe(true);
  });

  it("refuses http, javascript, data and unparseable values at the field", () => {
    expect(isAcceptableLaunchLink("http://vex.example")).toBe(false);
    expect(isAcceptableLaunchLink("javascript:alert(1)")).toBe(false);
    expect(isAcceptableLaunchLink("data:text/html,x")).toBe(false);
    expect(isAcceptableLaunchLink("vex.example")).toBe(false);
  });
});
