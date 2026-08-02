/**
 * C6 — the enforceable autonomous-launch spend ceiling.
 *
 * Real funds, irreversible. Three properties are pinned here:
 *   1. NO CEILING ⇒ REFUSE (null is zero authority, not unlimited).
 *   2. decimals !== 18 ⇒ REFUSE BY NAME, never rescale.
 *   3. Over the ceiling ⇒ REFUSE with BOTH numbers, never clamp.
 */

import { describe, it, expect } from "vitest";

import {
  REQUIRED_MAX_LAUNCH_VALUE_DECIMALS,
  enforceLaunchValueCeiling,
  resolveLaunchValueCeilingWei,
} from "@vex-agent/engine/mission/launch-ceiling.js";

const ONE_FINNEY = 1_000_000_000_000_000n; // 0.001 ETH, the creation fee

describe("resolveLaunchValueCeilingWei", () => {
  it("refuses when no ceiling is set — absent is NOT unlimited", () => {
    const result = resolveLaunchValueCeilingWei({
      maxLaunchValueRaw: null,
      maxLaunchValueDecimals: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("no maxLaunchValue ceiling set");
    expect(result.reason).toContain("not unlimited");
  });

  it("refuses a half-written pair (raw without decimals)", () => {
    expect(
      resolveLaunchValueCeilingWei({ maxLaunchValueRaw: "1000", maxLaunchValueDecimals: null }).ok,
    ).toBe(false);
  });

  it("refuses non-18 decimals BY NAME and does not rescale", () => {
    const result = resolveLaunchValueCeilingWei({
      maxLaunchValueRaw: "1000000",
      maxLaunchValueDecimals: 6,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("maxLaunchValueDecimals is 6");
    expect(result.reason).toContain(String(REQUIRED_MAX_LAUNCH_VALUE_DECIMALS));
    expect(result.reason).toContain("NOT rescaled");
  });

  it("refuses a raw amount that is not a non-negative integer", () => {
    for (const raw of ["0.001", "-1", "1e18", "1_000", "abc", ""]) {
      expect(
        resolveLaunchValueCeilingWei({ maxLaunchValueRaw: raw, maxLaunchValueDecimals: 18 }).ok,
      ).toBe(false);
    }
  });

  it("resolves an 18-decimal raw ceiling to exact wei, beyond MAX_SAFE_INTEGER", () => {
    const raw = "123456789012345678901234567890";
    const result = resolveLaunchValueCeilingWei({
      maxLaunchValueRaw: raw,
      maxLaunchValueDecimals: 18,
    });
    expect(result).toEqual({ ok: true, ceilingWei: BigInt(raw) });
  });
});

describe("enforceLaunchValueCeiling", () => {
  const ceiling = { maxLaunchValueRaw: "10000000000000000", maxLaunchValueDecimals: 18 }; // 0.01 ETH

  it("allows a launch at exactly the ceiling (inclusive bound)", () => {
    expect(enforceLaunchValueCeiling(ceiling, 10_000_000_000_000_000n)).toEqual({ ok: true });
  });

  it("allows fee + prebuy under the ceiling", () => {
    expect(enforceLaunchValueCeiling(ceiling, ONE_FINNEY + 5_000_000_000_000_000n)).toEqual({
      ok: true,
    });
  });

  it("refuses one wei over the ceiling and names BOTH numbers", () => {
    const result = enforceLaunchValueCeiling(ceiling, 10_000_000_000_000_001n);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("10000000000000001");
    expect(result.reason).toContain("10000000000000000");
    expect(result.reason).toContain("NOT clamped");
  });

  it("compares the FULL msg.value (fee + prebuy), not the prebuy alone", () => {
    // A prebuy of exactly the ceiling is over budget once the fee is added —
    // the fee is a real, irreversible spend and must count.
    const prebuyAtCeiling = 10_000_000_000_000_000n;
    expect(enforceLaunchValueCeiling(ceiling, prebuyAtCeiling).ok).toBe(true);
    expect(enforceLaunchValueCeiling(ceiling, prebuyAtCeiling + ONE_FINNEY).ok).toBe(false);
  });

  it("refuses before comparing when the mission has no ceiling at all", () => {
    const result = enforceLaunchValueCeiling(
      { maxLaunchValueRaw: null, maxLaunchValueDecimals: null },
      1n,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("no maxLaunchValue ceiling set");
  });
});
