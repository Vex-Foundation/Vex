/**
 * §C6b — the SECOND mission ceiling, and the fee-inclusive charge base.
 *
 * `maxLaunchValueRaw` alone is not enough: a loop that stays under the
 * per-launch value cap could still mint dozens of tokens. So a mission carries
 * two numbers and BOTH must be present for an autonomous launch.
 *
 * What this file pins, all of it fail-closed by design:
 *   1. The chargeable figure is `msg.value + Vex's 25 bps fee`, EXCLUDING
 *      network gas (coordinator ruling 2026-08-02).
 *   2. `maxLaunchCount` absent ⇒ REFUSE, exactly like the value ceiling.
 *      Nothing has authored one yet, so this is TODAY's live behavior.
 *   3. In-flight launches COUNT. Two concurrent launches must not race past the
 *      cap by both counting only `confirmed` rows.
 *   4. Both refusals name BOTH numbers and never clamp.
 */

import { describe, it, expect } from "vitest";

import {
  LAUNCH_COUNT_CEILING_STATUSES,
  enforceAutonomousLaunchCeilings,
  enforceLaunchCountCeiling,
  enforceLaunchValueCeiling,
  launchChargeableWei,
} from "@vex-agent/engine/mission/launch-ceiling.js";

const FEE = 1_000_000_000_000_000n; // 0.001 ETH creation fee
const BOTH_SET = {
  maxLaunchValueRaw: "10000000000000000", // 0.01 ETH
  maxLaunchValueDecimals: 18,
  maxLaunchCount: 3,
};

describe("launchChargeableWei — what the ceiling actually compares", () => {
  it("is msg.value PLUS the Vex fee", () => {
    expect(launchChargeableWei(1_000n, 25n)).toBe(1_025n);
  });

  it("equals msg.value exactly when the fee floored to dust (no leg is charged)", () => {
    expect(launchChargeableWei(1_000n, 0n)).toBe(1_000n);
  });

  it("EXCLUDES network gas — gas is the network's, and it is an estimate", () => {
    // There is deliberately no gas parameter. A ceiling that moved with a gas
    // estimate would refuse or allow a launch for reasons the user never set.
    expect(launchChargeableWei.length).toBe(2);
  });
});

describe("enforceLaunchValueCeiling — fee-inclusive charge", () => {
  it("refuses when msg.value alone fits but msg.value + the Vex fee does not", () => {
    // The user said 'do not spend more than X on a launch'. A ceiling that
    // ignored a charge Vex itself imposes would be misleading.
    const msgValue = 10_000_000_000_000_000n; // exactly the ceiling
    const vexFee = 25_000_000_000_000n; // 25 bps of it
    expect(enforceLaunchValueCeiling(BOTH_SET, msgValue).ok).toBe(true);
    const result = enforceLaunchValueCeiling(BOTH_SET, launchChargeableWei(msgValue, vexFee));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("10025000000000000");
    expect(result.reason).toContain("10000000000000000");
  });
});

describe("enforceLaunchCountCeiling", () => {
  it("REFUSES when maxLaunchCount is null — today's live Path-2 behavior", () => {
    const result = enforceLaunchCountCeiling({ maxLaunchCount: null }, 0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("maxLaunchCount");
    expect(result.reason).toContain("not unlimited");
  });

  it("refuses a negative or non-integer cap rather than coercing it", () => {
    for (const cap of [-1, 1.5, Number.NaN]) {
      expect(enforceLaunchCountCeiling({ maxLaunchCount: cap }, 0).ok).toBe(false);
    }
  });

  it("allows the launch that reaches the cap, and refuses the one after it", () => {
    expect(enforceLaunchCountCeiling({ maxLaunchCount: 3 }, 2).ok).toBe(true);
    const result = enforceLaunchCountCeiling({ maxLaunchCount: 3 }, 3);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // BOTH numbers, used and allowed.
    expect(result.reason).toContain("3");
    expect(result.reason).toContain("already");
  });

  it("a cap of 0 refuses every launch", () => {
    expect(enforceLaunchCountCeiling({ maxLaunchCount: 0 }, 0).ok).toBe(false);
  });

  it("counts IN-FLIGHT rows, not just confirmed ones", () => {
    // Two concurrent launches would otherwise both see 0 confirmed and both sign.
    expect([...LAUNCH_COUNT_CEILING_STATUSES].sort()).toEqual([
      "authorized",
      "broadcast_pending",
      "confirmed",
      "consuming",
    ]);
    // cancelled / expired never spent; terminal_failure minted no token.
    expect(LAUNCH_COUNT_CEILING_STATUSES).not.toContain("cancelled");
    expect(LAUNCH_COUNT_CEILING_STATUSES).not.toContain("expired");
    expect(LAUNCH_COUNT_CEILING_STATUSES).not.toContain("terminal_failure");
  });
});

describe("enforceAutonomousLaunchCeilings — BOTH must be present", () => {
  const chargeable = launchChargeableWei(FEE, 0n);

  it("passes only when both ceilings are set and both are satisfied", () => {
    expect(enforceAutonomousLaunchCeilings(BOTH_SET, chargeable, 0)).toEqual({ ok: true });
  });

  it("REFUSES when only the value ceiling is set", () => {
    const result = enforceAutonomousLaunchCeilings(
      { maxLaunchValueRaw: "10000000000000000", maxLaunchValueDecimals: 18, maxLaunchCount: null },
      chargeable,
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("maxLaunchCount");
  });

  it("REFUSES when only the count ceiling is set", () => {
    const result = enforceAutonomousLaunchCeilings(
      { maxLaunchValueRaw: null, maxLaunchValueDecimals: null, maxLaunchCount: 3 },
      chargeable,
      0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("maxLaunchValue");
  });

  it("REFUSES a mission with neither — a 'watch my portfolio' mission cannot mint", () => {
    const result = enforceAutonomousLaunchCeilings(
      { maxLaunchValueRaw: null, maxLaunchValueDecimals: null, maxLaunchCount: null },
      chargeable,
      0,
    );
    expect(result.ok).toBe(false);
  });

  it("reports the VALUE breach first when both are breached — the money is the headline", () => {
    const result = enforceAutonomousLaunchCeilings(
      { ...BOTH_SET, maxLaunchValueRaw: "1" },
      chargeable,
      99,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("exceeds the mission's authorized ceiling");
  });
});
