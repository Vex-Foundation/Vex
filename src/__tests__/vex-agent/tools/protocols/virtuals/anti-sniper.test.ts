/**
 * The anti-sniper window, types 0-5.
 *
 * This suite replaces `tools/virtuals-anti-sniper.test.ts`, whose expectations
 * encoded a contract that the contracts contradict. The change is deliberate
 * and is stated here so the diff is readable as a corrected fact rather than a
 * weakened test:
 *
 *   OLD: the window was a POST-GRADUATION buy tax on the Uniswap pool,
 *        anchored on `lpCreatedAt`, applicable only once graduated, with three
 *        types (0/1/2) and an `estBuyTaxPct` of `99 * remaining/duration + 1`
 *        computed in floating point.
 *   NEW: the window is a BONDING-CURVE tax charged by FRouterV3, anchored on
 *        the bonding pair's start (`launchedAt`), applicable only while the
 *        agent is still on the curve, with six types and side-specific
 *        arithmetic that floors the way the contract's integer division does.
 *
 * Every number below is transcribed from the contract sources in
 * `agents-colab/protocol-contracts/contracts/launchpadv2/`:
 * `BondingConfig.sol:30-35` (the six constants), `:412-429` (the durations),
 * `:386-405` (which side each type taxes), and `FRouterV3.sol:309-355` (the
 * decay), `:161-163` and `:211-213` (the 99 percent clamp).
 */

import { describe, expect, it } from "vitest";
import {
  ANTI_SNIPER_START_TAX_PCT,
  ANTI_SNIPER_TYPES,
  FLAT_CURVE_TAX_PCT,
  computeAntiSniper,
} from "@vex-agent/tools/protocols/virtuals/anti-sniper.js";

const LAUNCH = "2026-09-04T12:00:00.000Z";
const LAUNCH_MS = Date.parse(LAUNCH);

function at(secondsAfterLaunch: number) {
  return computeAntiSniper({
    antiSniperTaxType: 1,
    launchedAtIso: LAUNCH,
    graduated: false,
    nowMs: LAUNCH_MS + secondsAfterLaunch * 1000,
  });
}

describe("the six contract types", () => {
  // A table test, because the six rows ARE the contract: a wrong duration or a
  // wrong side is a silently mispriced trade, not a cosmetic defect.
  const TABLE = [
    { type: 0, name: "ANTI_SNIPER_NONE", duration: 0, buy: false, sell: false },
    { type: 1, name: "ANTI_SNIPER_60S", duration: 60, buy: true, sell: false },
    { type: 2, name: "ANTI_SNIPER_98M", duration: 5880, buy: true, sell: false },
    { type: 3, name: "ANTI_SNIPER_98M_SELL", duration: 5880, buy: false, sell: true },
    { type: 4, name: "ANTI_SNIPER_98M_BOTH", duration: 5880, buy: true, sell: true },
    { type: 5, name: "ANTI_SNIPER_10M", duration: 600, buy: true, sell: false },
  ] as const;

  it.each(TABLE)("type $type ($name) taxes buy=$buy sell=$sell for $duration s", (row) => {
    expect(ANTI_SNIPER_TYPES[row.type]).toEqual({
      durationSeconds: row.duration,
      appliesOnBuy: row.buy,
      appliesOnSell: row.sell,
      name: row.name,
    });
  });

  it.each(TABLE)("type $type applies its taxes to exactly the declared sides at t=1s", (row) => {
    const status = computeAntiSniper({
      antiSniperTaxType: row.type,
      launchedAtIso: LAUNCH,
      graduated: false,
      nowMs: LAUNCH_MS + 1000,
    });
    expect(status.typeName).toBe(row.name);
    expect(status.buy.applies).toBe(row.buy);
    expect(status.sell.applies).toBe(row.sell);
    expect(status.windowActive).toBe(row.buy || row.sell);
  });

  it("has exactly six types and no seventh", () => {
    expect(Object.keys(ANTI_SNIPER_TYPES).sort()).toEqual(["0", "1", "2", "3", "4", "5"]);
  });
});

describe("the decay is the contract's integer arithmetic, not a float", () => {
  it("starts at the clamped 99 percent start value at t=0", () => {
    const status = at(0);
    // startTax is 99 and the flat tax is 1, so the router's clamp
    // (normalTax + antiSniperTax > 99) pins the anti-sniper component at 98.
    expect(status.buy.antiSniperTaxPct).toBe(ANTI_SNIPER_START_TAX_PCT - FLAT_CURVE_TAX_PCT);
    expect(status.buy.totalTaxPct).toBe(99);
    expect(status.remainingSeconds).toBe(60);
  });

  it("floors the way `startTax * (duration - elapsed) / duration` does on chain", () => {
    // 30 s into a 60 s window: 99 * 30 / 60 = 49.5, and the contract's uint
    // division truncates to 49 - not 50, and not 49.5.
    expect(at(30).buy.antiSniperTaxPct).toBe(49);
    // 59 s in: 99 * 1 / 60 = 1.65 -> 1.
    expect(at(59).buy.antiSniperTaxPct).toBe(1);
  });

  it("is closed at the exact boundary, not one tick later", () => {
    const boundary = at(60);
    expect(boundary.windowActive).toBe(false);
    expect(boundary.buy.antiSniperTaxPct).toBe(0);
    expect(boundary.buy.totalTaxPct).toBe(FLAT_CURVE_TAX_PCT);
    expect(boundary.remainingSeconds).toBe(0);
  });

  it("still reports the flat protocol tax once the window is over", () => {
    const later = at(10_000);
    expect(later.applicable).toBe(true);
    expect(later.windowActive).toBe(false);
    expect(later.buy.flatTaxPct).toBe(FLAT_CURVE_TAX_PCT);
    expect(later.buy.totalTaxPct).toBe(FLAT_CURVE_TAX_PCT);
  });

  it("taxes only the sell side for type 3, leaving buys at the flat tax", () => {
    const status = computeAntiSniper({
      antiSniperTaxType: 3,
      launchedAtIso: LAUNCH,
      graduated: false,
      nowMs: LAUNCH_MS + 2940 * 1000, // halfway through 5880 s
    });
    expect(status.sell.antiSniperTaxPct).toBe(49);
    expect(status.buy.applies).toBe(false);
    expect(status.buy.totalTaxPct).toBe(FLAT_CURVE_TAX_PCT);
  });
});

describe("it refuses to guess", () => {
  it("is NOT applicable for a graduated agent, and says why", () => {
    const status = computeAntiSniper({
      antiSniperTaxType: 1,
      launchedAtIso: LAUNCH,
      graduated: true,
      nowMs: LAUNCH_MS + 1000,
    });
    expect(status.applicable).toBe(false);
    expect(status.windowActive).toBe(false);
    expect(status.note).toMatch(/BONDING-CURVE trades only/);
    expect(status.note).toMatch(/graduated/);
  });

  it("treats an unknown type as UNKNOWN, never as zero tax", () => {
    for (const unknown of [7, -1, 2.5, null, undefined, Number.NaN]) {
      const status = computeAntiSniper({
        antiSniperTaxType: unknown as number | null,
        launchedAtIso: LAUNCH,
        graduated: false,
        nowMs: LAUNCH_MS + 1000,
      });
      expect(status.applicable).toBe(false);
      expect(status.type).toBeNull();
      expect(status.typeName).toBeNull();
      expect(status.note).toMatch(/UNKNOWN - not zero/);
    }
  });

  it("treats a missing clock as UNKNOWN, never as an expired window", () => {
    const status = computeAntiSniper({
      antiSniperTaxType: 1,
      launchedAtIso: null,
      graduated: false,
      nowMs: LAUNCH_MS,
    });
    expect(status.applicable).toBe(false);
    expect(status.note).toMatch(/UNKNOWN - not expired/);
  });

  it("always labels the answer an estimate that an on-chain read supersedes", () => {
    expect(at(10).note).toMatch(/ESTIMATE/);
    expect(at(10).note).toMatch(/Re-read on chain/);
  });
});
