/**
 * Unit tests for the launch dialog's display arithmetic (Lane D).
 *
 * These pin the rule-90 invariants of a SPEND-CONSENT surface, not formatting
 * taste. The number these functions print is the number the user's Deploy click
 * authorizes, so each case below is an amount that must not be able to render
 * wrongly:
 *   - full 18-decimal precision survives (no float path anywhere);
 *   - an unreadable amount is an em-dash, never a zero;
 *   - the estimated total DOES include gas and is null unless every term reads;
 *   - the prebuy field validates but NEVER converts — main owns decimal → wei;
 *   - a fee-drift refusal classifies as re-review, never as a generic error.
 */

import { describe, expect, it } from "vitest";
import {
  classifyLaunchOutcome,
  classifyLaunchRefusal,
  formatWeiEth,
  formatWeiEthWithUnit,
  estimatedTotalCostWei,
  isAcceptableLaunchLink,
  normalizeEthInput,
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

describe("estimatedTotalCostWei", () => {
  it("sums msg.value + vexFee + network fee - the whole cost of launching", () => {
    // 0.051 + 0.0001275 + 0.001634838
    expect(
      estimatedTotalCostWei("51000000000000000", "127500000000000", "1634838000000000"),
    ).toBe("52762338000000000");
  });

  it("returns null when any term is unreadable, never a partial total", () => {
    expect(estimatedTotalCostWei("nope", "0", "0")).toBeNull();
    expect(estimatedTotalCostWei("1", "nope", "0")).toBeNull();
    expect(estimatedTotalCostWei("1", "0", null)).toBeNull();
  });
});

describe("normalizeEthInput", () => {
  it("returns the typed decimal unchanged - it validates, it does not convert", () => {
    expect(normalizeEthInput("0.001")).toBe("0.001");
    expect(normalizeEthInput("1")).toBe("1");
    expect(normalizeEthInput(" 1.234567890123456789 ")).toBe("1.234567890123456789");
  });

  it("treats an unfilled field as the documented zero default", () => {
    expect(normalizeEthInput("")).toBe("0");
    expect(normalizeEthInput("   ")).toBe("0");
    expect(normalizeEthInput("0")).toBe("0");
  });

  it("REFUSES more than 18 fractional digits rather than truncating them", () => {
    expect(normalizeEthInput("1.1234567890123456789")).toBeNull();
  });

  it("refuses forms the IPC contract does not accept, instead of repairing them", () => {
    // The shared schema is `^\\d+(\\.\\d+)?$`: a leading or trailing dot is not
    // an amount there, and quietly rewriting a money field is not ours to do.
    for (const bad of [".5", "2.", "-1", "1e18", "1,5", "abc", ".", "0x1", "1 2"]) {
      expect(normalizeEthInput(bad)).toBeNull();
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

/**
 * The auto-dismiss decision, over the full matrix. This is the rule that lets a
 * modal close itself after a REAL SPEND, so every cell is stated rather than
 * inferred: four statuses × four hash shapes. A blank hash is not a receipt —
 * `z.string().nullable()` admits `""` and `"   "` alike, and neither is
 * something the user could look up after the dialog is gone.
 */
describe("classifyLaunchOutcome", () => {
  const HASH = `0x${"a".repeat(64)}`;

  it.each([
    ["confirmed", "success", true],
    ["confirmed_pending_identity", "success", true],
    // Dismissible since B-PRE: the agent's resumed turn no longer claims the
    // launch is done, so the receipt and the transcript agree.
    ["pending", "caution", true],
    // A failed spend the user must see. Never dismissed.
    ["reverted", "failure", false],
  ])("with a real hash, %s is %s and autoDismiss=%s", (status, tone, autoDismiss) => {
    expect(classifyLaunchOutcome({ status, txHash: HASH } as never)).toEqual({
      tone,
      autoDismiss,
    });
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace only", "   "],
  ])("HOLDS every status when the hash is %s", (_label, txHash) => {
    for (const status of [
      "confirmed",
      "confirmed_pending_identity",
      "pending",
      "reverted",
    ]) {
      const presentation = classifyLaunchOutcome({ status, txHash } as never);
      expect(presentation.autoDismiss).toBe(false);
      // A hashless broadcast is never painted as a success.
      expect(presentation.tone).toBe(status === "reverted" ? "failure" : "caution");
    }
  });
});
