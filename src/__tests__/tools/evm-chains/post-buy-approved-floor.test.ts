/**
 * The post-settlement assessment of a confirmed fill against the floor its
 * quote was approved at.
 *
 * DETECTION, never prevention: the execute already refuses to sign calldata
 * carrying any other floor. This runs after the funds moved, so its only job is
 * to say - by name - when a fill still landed short, and to stay silent when it
 * cannot know. It never touches a settlement status, which is why the truth
 * table below has a `not_assessable` row rather than a default verdict.
 *
 * The 1-raw-unit allowance is not a fudge factor: KyberSwap's `/route/build`
 * derives its own `minAmountOut` and lands one wei under the value rederived
 * from the same summary (measured 2026-08-27), and the build guard on that lane
 * already accepts that. An assessment without the same allowance would call a
 * build the guard accepted "materially short".
 */

import { describe, it, expect } from "vitest";

import {
  APPROVED_FLOOR_ALLOWANCE_RAW,
  assessApprovedFloor,
} from "@tools/evm-chains/post-buy-delivery.js";

function assess(executed: unknown, floor: unknown) {
  return assessApprovedFloor({
    executedAmountOutRaw: executed,
    approvedMinOutRaw: floor,
    tokenOutSymbol: "CCF",
  });
}

describe("assessApprovedFloor", () => {
  it("the allowance is exactly one raw unit", () => {
    expect(APPROVED_FLOOR_ALLOWANCE_RAW).toBe(1n);
  });

  it.each([
    ["above the floor", 1_000n, 900n, "met"],
    ["exactly at the floor", 900n, 900n, "met"],
    ["one raw unit under, the measured build allowance", 899n, 900n, "met"],
    ["two raw units under, past the allowance", 898n, 900n, "materially_short"],
    ["the 2026-08-27 incident shape: 263x short", 1_190n, 313_879n, "materially_short"],
    ["a zero fill against a real floor", 0n, 900n, "materially_short"],
    ["a zero floor, which nothing can miss", 0n, 0n, "met"],
  ])("%s", (_case, executed, floor, expected) => {
    expect(assess(executed, floor).kind).toBe(expected);
  });

  it("accepts the raw digit strings the durable row actually stores", () => {
    expect(assess("1190145000000000000000", "298185715000000000000000").kind).toBe("materially_short");
    expect(assess("298185715000000000000000", "298185715000000000000000").kind).toBe("met");
  });

  it.each([
    ["a row written before the floor was recorded", 900n, undefined],
    ["an undecoded output", undefined, 900n],
    ["a non-numeric string", "not-a-number", "900"],
    ["a negative figure", -1n, 900n],
    ["a floating spelling", "900.5", "900"],
  ])("stays silent on %s", (_case, executed, floor) => {
    expect(assess(executed, floor).kind).toBe("not_assessable");
  });

  it("names the shortfall, the token and what the agent should believe", () => {
    const verdict = assess(1_190n, 313_879n);

    expect(verdict.kind).toBe("materially_short");
    if (verdict.kind !== "materially_short") return;
    expect(verdict.shortfallRaw).toBe(312_689n);
    expect(verdict.verdict).toContain("1190");
    expect(verdict.verdict).toContain("313879");
    expect(verdict.verdict).toContain("CCF");
    // It must not read as "the swap failed": the funds have moved.
    expect(verdict.verdict).toContain("confirmed and the funds have moved");
  });
});
