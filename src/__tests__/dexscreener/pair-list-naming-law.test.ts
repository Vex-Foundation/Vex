/**
 * The naming law: every numeric field an agent reads carries its unit.
 *
 * WHY THIS IS A MECHANICAL TEST AND NOT A REVIEW HABIT
 *
 * The shape this replaces emitted `pairCreatedAt` (a bare millisecond epoch the
 * agent could not distinguish from seconds), `priceNative` (which reads as "the
 * chain's gas token" and is actually the quote asset — live WETH/USDC was
 * `"1892.5670"`, USDC-denominated), and `fdv` / `marketCap` with no unit at all.
 * A sibling namespace shipped `paymentTimestamp` in milliseconds while our own
 * module map said seconds and prescribed x1000, which lands in the year 57,460.
 *
 * Every one of those passed review. None would pass this test. It runs over the
 * EMITTED payload, not a hand-maintained list, so a field added tomorrow is
 * checked tomorrow.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_PAIR_FIELDS,
  LEAN_PAIR_FIELDS,
  RICH_PAIR_FIELDS,
  computePairMetrics,
  projectAgentPair,
} from "@vex-agent/tools/protocols/dexscreener/pair-list/index.js";

import { UNIT_SUFFIX } from "./_naming-law.js";
import { tokenPairsWeth } from "./_pair-captures.js";

/**
 * Fields exempt because they are not numbers the agent does arithmetic on.
 *
 * Strings and booleans state their own type when read, and identity fields carry
 * no unit by nature. Each entry here is a decision, not an oversight — which is
 * why the list is explicit and asserted to be exhaustive below.
 */
const NON_NUMERIC_FIELDS = new Set([
  "chainId",
  "dexId",
  "pairAddress",
  "baseAddress",
  "baseSymbol",
  "baseName",
  "quoteAddress",
  "quoteSymbol",
  "quoteName",
  // Exact-decimal money strings. `priceUsd` carries its unit anyway;
  // `priceInQuoteToken` names the asset it is denominated in, which is the unit.
  "priceUsd",
  "priceInQuoteToken",
  "labels",
  "marketCapEqualsFdv",
  "hasWebsite",
  "hasSocials",
  "socialPlatforms",
  "imageUrl",
  "dexScreenerUrl",
  "decimalsAvailable",
  "priceSanity",
  // The window the `*Selected` values were resolved against — a timeframe label
  // ("h24"), not a quantity. It carries no unit because it IS one.
  "windowSelected",
]);

/** Project one real row with every field turned on. */
function fullRow(): Record<string, unknown> {
  const pair = tokenPairsWeth()[0];
  if (pair === undefined) throw new Error("fixture has no rows");
  const asOfMs = Date.UTC(2026, 6, 27);
  const row = projectAgentPair(
    { pair, metrics: computePairMetrics(pair, asOfMs) },
    { fields: new Set(ALL_PAIR_FIELDS), window: "h24", priceSanity: "ok" },
  );
  return { ...row };
}

describe("AgentDexPair naming law", () => {
  it("every emitted field name is either declared non-numeric or carries a unit suffix", () => {
    const offenders = Object.keys(fullRow()).filter(
      (field) => !NON_NUMERIC_FIELDS.has(field) && !UNIT_SUFFIX.test(field),
    );
    expect(offenders).toEqual([]);
  });

  it("every field declared non-numeric really is non-numeric in the payload", () => {
    const row = fullRow();
    const lying = Object.entries(row).filter(
      ([field, value]) => NON_NUMERIC_FIELDS.has(field) && typeof value === "number",
    );
    expect(lying).toEqual([]);
  });

  it("every field carrying a unit suffix really is a number or null", () => {
    const row = fullRow();
    const lying = Object.entries(row).filter(
      ([field, value]) =>
        !NON_NUMERIC_FIELDS.has(field)
        && UNIT_SUFFIX.test(field)
        && value !== null
        && typeof value !== "number",
    );
    expect(lying).toEqual([]);
  });

  // A field added to the projector but not to the vocabulary would be
  // unrequestable and invisible to the law above; a field in the vocabulary but
  // never projected would be silently accepted in `fields` and then absent.
  it("the field vocabulary matches what the projector actually emits", () => {
    const emitted = new Set(Object.keys(fullRow()));
    // `priceSanity` is attached per-tool by `tokenPairs`, not selected via `fields`.
    emitted.delete("priceSanity");
    // `windowSelected` is an unconditional ECHO of the resolved `window` param,
    // not a selectable field: it is always emitted, so offering it in `fields`
    // would be a selector that can only ever be a no-op.
    emitted.delete("windowSelected");
    expect([...emitted].sort()).toEqual([...ALL_PAIR_FIELDS].sort());
  });

  it("lean and rich sets are disjoint and together are the whole vocabulary", () => {
    const overlap = LEAN_PAIR_FIELDS.filter((field) => RICH_PAIR_FIELDS.includes(field));
    expect(overlap).toEqual([]);
    expect(LEAN_PAIR_FIELDS.length + RICH_PAIR_FIELDS.length).toBe(ALL_PAIR_FIELDS.length);
  });

  it("the lean set includes both token addresses for unambiguous identity", () => {
    expect([...LEAN_PAIR_FIELDS]).toEqual([
      "chainId",
      "dexId",
      "pairAddress",
      "baseAddress",
      "baseSymbol",
      "quoteAddress",
      "quoteSymbol",
      "priceUsd",
      "liquidityUsd",
      "volumeUsdSelected",
      "priceChangePctSelected",
      "turnoverRatioH24",
      "pairAgeSeconds",
      "labels",
    ]);
  });

  // The single most expensive field in this API. If it ever lands in the lean
  // set, every default `search` call carries up to 34,090 characters of
  // issuer-authored text it did not ask for.
  it("baseName is NOT in the lean set", () => {
    expect(LEAN_PAIR_FIELDS).not.toContain("baseName");
    expect(RICH_PAIR_FIELDS).toContain("baseName");
  });
});
