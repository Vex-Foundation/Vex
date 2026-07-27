/**
 * A filter must name the field it reads — the silent-wrong-number fix.
 *
 * THE MEASURED DEFECT, ranked [high] in the persona gate
 *
 * `minQuoteDepthTokens` reads the output field `liquidityQuoteTokens`. Nothing
 * said so. The auditor persona guessed the field name FROM THE FILTER NAME
 * (`quoteDepthTokens`), was rejected (914 B, `call-records.json`), guessed
 * `priceInQuoteToken` next — and that one was ACCEPTED, returning a PRICE where
 * a DEPTH was wanted. Three calls for one number, and the middle one produced a
 * plausible wrong answer rather than an error.
 *
 * So two things have to hold, and neither is prose-only:
 *
 * 1. Every `min*`/`max*` filter's param text NAMES the field it compares. The
 *    map below is the machine-checkable source, asserted against the real
 *    manifests and against the real projector.
 * 2. A `fields` guess named after a filter is caught and REDIRECTED, not merely
 *    refused — the whole failure was a plausible second guess.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_PAIR_FIELDS,
  PAIR_FIELD_GROUPS,
  PAIR_FILTERS_WITHOUT_ONE_FIELD,
  PAIR_FILTER_FIELD_READS,
  resolvePairFields,
} from "@vex-agent/tools/protocols/dexscreener/pair-list/index.js";
import { PAIR_LIST_PARAMS } from "@vex-agent/tools/protocols/dexscreener/manifests/pair-list-params.js";
import { NARRATIVE_LIST_PARAMS } from "@vex-agent/tools/protocols/dexscreener/manifests/narrative-list-params.js";

function rejectionFor(requested: string[]): string {
  const outcome = resolvePairFields(requested, false);
  expect(outcome.ok, `expected rejection for ${requested.join(",")}`).toBe(false);
  return outcome.ok ? "" : outcome.reason;
}

describe("every filter names the output field it reads", () => {
  it("the map covers EVERY min*/max* filter in the shared pair vocabulary", () => {
    const thresholds = PAIR_LIST_PARAMS.filter((param) => /^(min|max)[A-Z]/.test(param.key)).map(
      (param) => param.key,
    );
    expect(thresholds.length).toBeGreaterThan(10);
    const accounted = new Set([
      ...Object.keys(PAIR_FILTER_FIELD_READS),
      ...PAIR_FILTERS_WITHOUT_ONE_FIELD,
    ]);
    expect(thresholds.filter((key) => !accounted.has(key))).toEqual([]);
  });

  it("every mapped field is a field the projector actually emits", () => {
    for (const [filter, field] of Object.entries(PAIR_FILTER_FIELD_READS)) {
      expect(ALL_PAIR_FIELDS, `${filter} → ${field}`).toContain(field);
    }
  });

  it("every mapped filter's PARAM TEXT names that field", () => {
    for (const [filter, field] of Object.entries(PAIR_FILTER_FIELD_READS)) {
      const param = PAIR_LIST_PARAMS.find((candidate) => candidate.key === filter);
      expect(param, filter).toBeDefined();
      expect(param?.description, `${filter} must name ${field}`).toContain(field);
    }
  });

  it("the filters WITHOUT a single emitted field say what they are computed from", () => {
    // These read a number Vex derives per selected window and never emits as one
    // field. Silence would recreate the exact defect: a plausible guess.
    expect([...PAIR_FILTERS_WITHOUT_ONE_FIELD].sort()).toEqual([
      "maxBuySellRatio",
      "minBuySellRatio",
      "minTxnCount",
    ]);
    for (const filter of PAIR_FILTERS_WITHOUT_ONE_FIELD) {
      const param = PAIR_LIST_PARAMS.find((candidate) => candidate.key === filter);
      expect(param?.description, filter).toMatch(/txnBuyCount|txnSellCount|buySellRatio</);
    }
  });

  it("the narrative filters name their fields too", () => {
    const expected: Readonly<Record<string, string>> = {
      minTokenCount: "narrativeTokenCount",
      minMarketCapUsd: "marketCapUsd",
      minLiquidityUsd: "liquidityUsd",
      minVolumeUsd: "volumeUsdH24",
    };
    for (const [filter, field] of Object.entries(expected)) {
      const param = NARRATIVE_LIST_PARAMS.find((candidate) => candidate.key === filter);
      expect(param, filter).toBeDefined();
      expect(param?.description, `${filter} must name ${field}`).toContain(field);
    }
  });
});

describe("the `fields` rejection redirects a filter-shaped guess", () => {
  it("points `quoteDepthTokens` at liquidityQuoteTokens — the exact live miss", () => {
    const reason = rejectionFor(["quoteDepthTokens"]);
    expect(reason).toContain("quoteDepthTokens");
    expect(reason).toContain("liquidityQuoteTokens");
    expect(reason).toMatch(/did you mean/i);
  });

  it("points a filter name itself at the field it reads", () => {
    expect(rejectionFor(["minLiquidityUsd"])).toContain("liquidityUsd");
    expect(rejectionFor(["maxPriceChangePct"])).toContain("priceChangePctSelected");
    expect(rejectionFor(["minPairAgeSeconds"])).toContain("pairAgeSeconds");
  });

  it("carries the filter → field mapping, so the NEXT guess is informed too", () => {
    const reason = rejectionFor(["nonsense"]);
    expect(reason).toContain("minQuoteDepthTokens");
    expect(reason).toContain("liquidityQuoteTokens");
    expect(reason).toContain("minTurnoverRatio");
    expect(reason).toContain("turnoverRatioH24");
  });

  it("still names the offending value and still offers `full`", () => {
    const reason = rejectionFor(["nonsense", "alsoNonsense"]);
    expect(reason).toContain("nonsense");
    expect(reason).toContain("alsoNonsense");
    expect(reason).toContain("full");
  });
});

describe("the `fields` list is GROUPED, not a flat wall of 40 names", () => {
  it("the groups partition the whole vocabulary exactly", () => {
    const grouped = Object.values(PAIR_FIELD_GROUPS).flatMap((fields) => [...fields]);
    expect([...grouped].sort()).toEqual([...ALL_PAIR_FIELDS].sort());
    // Disjoint: a name in two groups would make "which group owns this?" ambiguous.
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("names the four groups the agent has to choose between", () => {
    expect(Object.keys(PAIR_FIELD_GROUPS)).toEqual(["identity", "depth", "flow", "windows"]);
  });

  it("the rejection message renders every group with its label", () => {
    const reason = rejectionFor(["nonsense"]);
    for (const group of Object.keys(PAIR_FIELD_GROUPS)) {
      expect(reason, group).toContain(group);
    }
    // The grouping is a presentation of the SAME vocabulary — every name still
    // has to be discoverable from the rejection, which is how `full` is found.
    for (const field of ALL_PAIR_FIELDS) {
      expect(reason, field).toContain(field);
    }
  });

  it("puts the depth fields together, which is the group the live miss needed", () => {
    expect(PAIR_FIELD_GROUPS.depth).toContain("liquidityQuoteTokens");
    expect(PAIR_FIELD_GROUPS.depth).toContain("liquidityBaseTokens");
    expect(PAIR_FIELD_GROUPS.depth).toContain("liquidityUsd");
    expect(PAIR_FIELD_GROUPS.identity).toContain("quoteAddress");
  });
});
