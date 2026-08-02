/**
 * Launch boundary validation.
 *
 * The load-bearing guard here is the FORBIDDEN-PARAM REJECTION. Rule 90: fee,
 * limit and destination parameters must never originate from model input, and a
 * caller-supplied one is rejected BY NAME — a silent drop would hide an
 * attempted overcharge instead of surfacing it.
 *
 * On a launch the forbidden set is wider than on a trade, because `msg.value`
 * itself is composed by Vex: `value` and `fee` would let a model set the spend
 * directly, and `min`/`minOut`/`deadline`/`recipient` are the same trading
 * levers the trade path already refuses.
 */

import { describe, it, expect } from "vitest";

import {
  FORBIDDEN_LAUNCH_PARAMS,
  validateLaunchRequest,
} from "@vex-agent/tools/protocols/trench/handlers/launch/validate.js";

const VALID = {
  name: "Vex x Trench",
  symbol: "VEXTE",
  description: "a launch",
  links: "https://vex.example",
  imageId: "img_01",
};

describe("forbidden params — rejected BY NAME, never dropped", () => {
  it("names every forbidden param it refuses", () => {
    for (const key of FORBIDDEN_LAUNCH_PARAMS) {
      const result = validateLaunchRequest({ ...VALID, [key]: "1" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // BY NAME — the message must say which one, so an attempted overcharge is
      // visible rather than silently ignored.
      expect(result.reason).toContain(key);
    }
  });

  it("covers value and fee — a launch composes its own msg.value", () => {
    expect(FORBIDDEN_LAUNCH_PARAMS).toContain("value");
    expect(FORBIDDEN_LAUNCH_PARAMS).toContain("fee");
    expect(FORBIDDEN_LAUNCH_PARAMS).toContain("min");
    expect(FORBIDDEN_LAUNCH_PARAMS).toContain("minOut");
    expect(FORBIDDEN_LAUNCH_PARAMS).toContain("deadline");
    expect(FORBIDDEN_LAUNCH_PARAMS).toContain("recipient");
  });

  it("refuses even when the forbidden param is null, zero or empty", () => {
    // A falsy forbidden param is still an attempt to reach the money path.
    for (const value of [null, 0, "", false]) {
      expect(validateLaunchRequest({ ...VALID, fee: value }).ok).toBe(false);
    }
  });

  it("names ALL of them when several are supplied at once", () => {
    const result = validateLaunchRequest({ ...VALID, fee: "1", recipient: "0xabc" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("fee");
    expect(result.reason).toContain("recipient");
  });
});

describe("field validation", () => {
  it("accepts a well-formed request", () => {
    const result = validateLaunchRequest(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.name).toBe("Vex x Trench");
    expect(result.value.links).toEqual(["https://vex.example"]);
    expect(result.value.prebuyWei).toBe(0n);
  });

  it("requires name and symbol", () => {
    expect(validateLaunchRequest({ ...VALID, name: "" }).ok).toBe(false);
    expect(validateLaunchRequest({ ...VALID, symbol: "  " }).ok).toBe(false);
  });

  it("requires an imageId — a Vex launch refuses without an image", () => {
    const result = validateLaunchRequest({ ...VALID, imageId: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The message must point at the locker, per the product rule.
    expect(result.reason).toMatch(/image/i);
  });

  it("caps name, symbol, description and links", () => {
    expect(validateLaunchRequest({ ...VALID, name: "x".repeat(65) }).ok).toBe(false);
    expect(validateLaunchRequest({ ...VALID, symbol: "x".repeat(17) }).ok).toBe(false);
    expect(validateLaunchRequest({ ...VALID, description: "x".repeat(513) }).ok).toBe(false);
    expect(validateLaunchRequest({ ...VALID, links: "https://a,https://b,https://c,https://d,https://e" }).ok).toBe(false);
  });

  it("accepts zero links — the contract accepts an empty array (proven live)", () => {
    const result = validateLaunchRequest({ ...VALID, links: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.links).toEqual([]);
  });

  it("requires https links and refuses anything else", () => {
    expect(validateLaunchRequest({ ...VALID, links: "http://insecure.example" }).ok).toBe(false);
    expect(validateLaunchRequest({ ...VALID, links: "javascript:alert(1)" }).ok).toBe(false);
  });
});

describe("prebuy — raw amounts travel with their decimals", () => {
  it("parses a human prebuy into wei at 18 decimals", () => {
    const result = validateLaunchRequest({ ...VALID, prebuy: "0.0003" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.prebuyWei).toBe(300_000_000_000_000n);
  });

  it("treats an absent prebuy as zero, not as unset", () => {
    const result = validateLaunchRequest(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.prebuyWei).toBe(0n);
  });

  it("refuses a negative or unparseable prebuy rather than coercing it", () => {
    for (const prebuy of ["-1", "abc", "1e18", ""]) {
      expect(validateLaunchRequest({ ...VALID, prebuy }).ok).toBe(false);
    }
  });

  it("refuses a prebuy above the sanity cap instead of signing it", () => {
    // An unbounded prebuy from model input is a spend with no ceiling of its
    // own; the mission ceiling is the real gate, but this refuses obvious
    // fat-finger magnitudes before any of that runs.
    expect(validateLaunchRequest({ ...VALID, prebuy: "1000000" }).ok).toBe(false);
  });
});
