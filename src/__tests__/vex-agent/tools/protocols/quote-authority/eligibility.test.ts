/**
 * The quote-eligibility truth table.
 *
 * This union is what decides whether a quote may authorize a swap at all, so
 * every row is enumerated rather than sampled - including the ones a provider
 * only produces occasionally (a negative USD leg, a zero input value) and the
 * one that produced the 2026-08-27 pathology (`amountOutUsd: "0"` against a
 * real input value, which the old derivation reported as a precise 100% price
 * impact instead of "not priced").
 *
 * Pure function, no boundary: a table test is the whole contract.
 */

import { describe, it, expect } from "vitest";

import {
  classifyQuoteEligibility,
  parseProviderUsd,
  isExecutable,
  PRICE_IMPACT_WARN_FRACTION,
  PRICE_IMPACT_EXCESSIVE_FRACTION,
  USD_DUST,
  type QuoteEligibility,
} from "@vex-agent/tools/protocols/quote-authority/eligibility.js";

describe("parseProviderUsd", () => {
  const usable: readonly [string, number][] = [
    ["0", 0],
    ["0.0", 0],
    ["1", 1],
    ["30.27887792044092", 30.27887792044092],
    ["  12.5  ", 12.5],
    ["1e3", 1000],
  ];
  for (const [input, value] of usable) {
    it(`accepts ${JSON.stringify(input)} as ${value}`, () => {
      expect(parseProviderUsd(input)).toEqual({ ok: true, value });
    });
  }

  const unusable: readonly unknown[] = [
    undefined, null, 12.5, {}, [], "", "   ", "abc", "12abc", "NaN", "Infinity", "-Infinity",
    // The signed rejection is the load-bearing one: it runs BEFORE any impact
    // arithmetic, so a negative leg can never become an impact figure.
    "-1", "-0.0001", "-30.27",
  ];
  for (const input of unusable) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(parseProviderUsd(input)).toEqual({ ok: false });
    });
  }
});

describe("classifyQuoteEligibility truth table", () => {
  const rows: readonly {
    readonly name: string;
    readonly amountInUsd: unknown;
    readonly amountOutUsd: unknown;
    readonly snapshotOversize?: { measuredBytes: number; limitBytes: number };
    readonly expected: QuoteEligibility;
  }[] = [
    {
      name: "a flat, well-priced route is executable and not adverse",
      amountInUsd: "100", amountOutUsd: "99.9",
      expected: { kind: "executable", priceImpactFraction: (100 - 99.9) / 100, adverse: false },
    },
    {
      name: "an output priced ABOVE the input is executable with a negative impact",
      amountInUsd: "100", amountOutUsd: "101",
      expected: { kind: "executable", priceImpactFraction: -0.01, adverse: false },
    },
    {
      name: "exactly the warn line is adverse but still executable",
      amountInUsd: "100", amountOutUsd: "95",
      expected: { kind: "executable", priceImpactFraction: PRICE_IMPACT_WARN_FRACTION, adverse: true },
    },
    {
      name: "just under the ceiling is still executable",
      amountInUsd: "1000", amountOutUsd: "851",
      expected: { kind: "executable", priceImpactFraction: 0.149, adverse: true },
    },
    {
      name: "exactly the ceiling is excessive_impact",
      amountInUsd: "100", amountOutUsd: "85",
      expected: {
        kind: "excessive_impact",
        priceImpactFraction: PRICE_IMPACT_EXCESSIVE_FRACTION,
        ceilingFraction: PRICE_IMPACT_EXCESSIVE_FRACTION,
      },
    },
    {
      name: "THE 2026-08-27 PATHOLOGY: real input value, provider prices no output",
      amountInUsd: "30.27887792044092", amountOutUsd: "0",
      expected: { kind: "unpriceable_output", amountInUsd: 30.27887792044092 },
    },
    {
      name: "USD_DUST is 0, so the smallest positive input value still counts as priced",
      amountInUsd: "0.000001", amountOutUsd: "0",
      expected: { kind: "unpriceable_output", amountInUsd: 0.000001 },
    },
    {
      name: "both legs unpriced is a provider-shape refusal, not an impact number",
      amountInUsd: "0", amountOutUsd: "0",
      expected: { kind: "provider_usd_invalid", leg: "both" },
    },
    {
      name: "a zero input value with a priced output has no denominator to divide by",
      amountInUsd: "0", amountOutUsd: "12",
      expected: { kind: "provider_usd_invalid", leg: "input" },
    },
    {
      name: "a missing input leg",
      amountInUsd: undefined, amountOutUsd: "12",
      expected: { kind: "provider_usd_invalid", leg: "input" },
    },
    {
      name: "a missing output leg",
      amountInUsd: "12", amountOutUsd: undefined,
      expected: { kind: "provider_usd_invalid", leg: "output" },
    },
    {
      name: "a NEGATIVE output leg never reaches the impact arithmetic",
      amountInUsd: "100", amountOutUsd: "-100",
      expected: { kind: "provider_usd_invalid", leg: "output" },
    },
    {
      name: "a NEGATIVE input leg never reaches the impact arithmetic",
      amountInUsd: "-100", amountOutUsd: "100",
      expected: { kind: "provider_usd_invalid", leg: "input" },
    },
    {
      name: "both legs malformed",
      amountInUsd: "abc", amountOutUsd: "",
      expected: { kind: "provider_usd_invalid", leg: "both" },
    },
    {
      name: "an oversize snapshot pre-empts a perfectly good price",
      amountInUsd: "100", amountOutUsd: "99.9",
      snapshotOversize: { measuredBytes: 999_999, limitBytes: 262_144 },
      expected: { kind: "oversize_snapshot", measuredBytes: 999_999, limitBytes: 262_144 },
    },
    {
      name: "an oversize snapshot pre-empts a provider-shape refusal too",
      amountInUsd: "-1", amountOutUsd: "-1",
      snapshotOversize: { measuredBytes: 999_999, limitBytes: 262_144 },
      expected: { kind: "oversize_snapshot", measuredBytes: 999_999, limitBytes: 262_144 },
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const verdict = classifyQuoteEligibility({
        amountInUsd: row.amountInUsd,
        amountOutUsd: row.amountOutUsd,
        ...(row.snapshotOversize === undefined ? {} : { snapshotOversize: row.snapshotOversize }),
      });
      if (verdict.kind === "executable" && row.expected.kind === "executable") {
        expect(verdict.adverse).toBe(row.expected.adverse);
        expect(verdict.priceImpactFraction).toBeCloseTo(row.expected.priceImpactFraction, 12);
        return;
      }
      expect(verdict).toEqual(row.expected);
    });
  }

  it("ONLY executable authorizes a swap - every other member is refused by `isExecutable`", () => {
    const ineligible = rows.filter((r) => r.expected.kind !== "executable");
    // Guards against a future member being added to the union and silently
    // treated as executable: the table above must keep covering every kind.
    expect(new Set(ineligible.map((r) => r.expected.kind))).toEqual(
      new Set(["unpriceable_output", "excessive_impact", "oversize_snapshot", "provider_usd_invalid"]),
    );
    for (const row of ineligible) {
      const verdict = classifyQuoteEligibility({ amountInUsd: row.amountInUsd, amountOutUsd: row.amountOutUsd, ...(row.snapshotOversize === undefined ? {} : { snapshotOversize: row.snapshotOversize }) });
      expect(isExecutable(verdict)).toBe(false);
    }
  });

  it("the thresholds are the owner-pinned numbers, not incidental constants", () => {
    expect(PRICE_IMPACT_WARN_FRACTION).toBe(0.05);
    expect(PRICE_IMPACT_EXCESSIVE_FRACTION).toBe(0.15);
    expect(USD_DUST).toBe(0);
  });
});
