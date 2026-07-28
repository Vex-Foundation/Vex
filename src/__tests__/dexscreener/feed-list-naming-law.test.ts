/**
 * The naming law on the feed and narrative rows: every numeric field an agent
 * reads carries its unit.
 *
 * Same law and the same shared registry as `./pair-list-naming-law.test.ts`,
 * applied to the two row shapes this card introduced. It runs over the EMITTED
 * payload rather than a hand-maintained list, so a field added tomorrow is checked
 * tomorrow.
 *
 * These rows are where the law earns its keep. The provider ships `amount` and
 * `totalAmount` (counts of promotion packs, which read as currency),
 * `durationHours` and `impressions` (bare numbers), `marketCapChange` and
 * `marketCapDelta` (two identically-shaped maps, one in percent and one in
 * absolute USD, neither named), and `claimDate` next to `date` next to `updatedAt`
 * for three different events.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_FEED_FIELDS,
  LEAN_FEED_FIELDS,
  RICH_FEED_FIELDS,
  computeFeedRowMetrics,
  projectAgentFeedRow,
  toAdFeedRow,
  toBoostFeedRow,
  toProfileFeedRow,
  toTakeoverFeedRow,
  type FeedSourceRow,
} from "@vex-agent/tools/protocols/dexscreener/feed-list/index.js";
import {
  ALL_NARRATIVE_FIELDS,
  LEAN_NARRATIVE_FIELDS,
  RICH_NARRATIVE_FIELDS,
  computeNarrativeMetrics,
  projectAgentNarrative,
} from "@vex-agent/tools/protocols/dexscreener/narrative-list/index.js";

import { UNIT_SUFFIX } from "./_naming-law.js";
import {
  adsLatest,
  boostsLatest,
  communityTakeovers,
  metasTrending,
  profilesLatest,
} from "./_feed-captures.js";

/**
 * Fields exempt because they are not numbers the agent does arithmetic on.
 *
 * Each entry is a decision, not an oversight — which is why the list is explicit
 * and asserted to be truthful below.
 */
const NON_NUMERIC_FEED_FIELDS = new Set([
  "chainId",
  "tokenAddress",
  "description",
  // ISO 8601 strings. `*At` is the timestamp, `eventAgeSeconds` is the number
  // derived from it — the pair is deliberate so the agent never has to subtract
  // two dates to answer "how fresh".
  "updatedAt",
  "claimedAt",
  "adPlacedAt",
  "adType",
  "communityTakeover",
  "hasProfile",
  "dexScreenerUrl",
  "iconUrl",
  "headerUrl",
  "links",
]);

const NON_NUMERIC_NARRATIVE_FIELDS = new Set([
  "slug",
  "name",
  "iconEmoji",
  "description",
  // The window `marketCapChangePctSelected` was resolved against — a timeframe
  // label ("h24"), not a quantity. It carries no unit because it IS one.
  "windowSelected",
]);

const ASOF_MS = Date.UTC(2026, 6, 28);

function projectFull(source: FeedSourceRow): Record<string, unknown> {
  return {
    ...projectAgentFeedRow(
      { source, metrics: computeFeedRowMetrics(source, ASOF_MS) },
      new Set(ALL_FEED_FIELDS),
    ),
  };
}

/** One real row of each kind, every field enabled. */
function everyFeedRow(): Array<[string, Record<string, unknown>]> {
  const profile = profilesLatest()[0];
  const boost = boostsLatest().boosts[0];
  const takeover = communityTakeovers()[0];
  const ad = adsLatest()[0];
  if (profile === undefined || boost === undefined || takeover === undefined || ad === undefined) {
    throw new Error("a capture has no rows");
  }
  return [
    ["profile", projectFull(toProfileFeedRow(profile))],
    ["boost", projectFull(toBoostFeedRow(boost))],
    ["takeover", projectFull(toTakeoverFeedRow(takeover))],
    ["ad", projectFull(toAdFeedRow(ad))],
  ];
}

function fullNarrativeRow(): Record<string, unknown> {
  const meta = metasTrending()[0];
  if (meta === undefined) throw new Error("fixture has no narratives");
  return {
    ...projectAgentNarrative(
      { meta, metrics: computeNarrativeMetrics(meta) },
      new Set(ALL_NARRATIVE_FIELDS),
      "h24",
    ),
  };
}

describe("AgentDexFeedRow naming law", () => {
  it("every emitted field name is either declared non-numeric or carries a unit suffix", () => {
    for (const [kind, row] of everyFeedRow()) {
      const offenders = Object.keys(row).filter(
        (field) => !NON_NUMERIC_FEED_FIELDS.has(field) && !UNIT_SUFFIX.test(field),
      );
      expect(offenders, `${kind} row`).toEqual([]);
    }
  });

  it("every field declared non-numeric really is non-numeric in the payload", () => {
    for (const [kind, row] of everyFeedRow()) {
      const lying = Object.entries(row).filter(
        ([field, value]) => NON_NUMERIC_FEED_FIELDS.has(field) && typeof value === "number",
      );
      expect(lying, `${kind} row`).toEqual([]);
    }
  });

  it("every field carrying a unit suffix really is a number or null", () => {
    for (const [kind, row] of everyFeedRow()) {
      const lying = Object.entries(row).filter(
        ([field, value]) =>
          !NON_NUMERIC_FEED_FIELDS.has(field)
          && UNIT_SUFFIX.test(field)
          && value !== null
          && typeof value !== "number",
      );
      expect(lying, `${kind} row`).toEqual([]);
    }
  });

  // The provider calls these `amount` and `totalAmount`. Observed values are
  // exactly {10, 20, 30, 50, 100, 300, 500} — promotion packs, not dollars — and
  // an agent that reads "amount: 500" as $500 has been told something false.
  it("boost units are named as COUNTS, and the currency-shaped names are gone", () => {
    const boost = boostsLatest().boosts[0];
    if (boost === undefined) throw new Error("fixture has no boosts");
    const row = projectFull(toBoostFeedRow(boost));
    expect(row).toHaveProperty("boostCount");
    expect(row).toHaveProperty("boostCountTotal");
    expect(row).not.toHaveProperty("amount");
    expect(row).not.toHaveProperty("totalAmount");
    expect(row).not.toHaveProperty("boostAmount");
  });

  it("every feed row carries identity, because identity is what the next call needs", () => {
    for (const [kind, row] of everyFeedRow()) {
      expect(typeof row.chainId, `${kind} row`).toBe("string");
      expect(typeof row.tokenAddress, `${kind} row`).toBe("string");
    }
  });

  it("lean and rich sets are disjoint and together are the whole vocabulary", () => {
    const overlap = LEAN_FEED_FIELDS.filter((field) => RICH_FEED_FIELDS.includes(field));
    expect(overlap).toEqual([]);
    expect(LEAN_FEED_FIELDS.length + RICH_FEED_FIELDS.length).toBe(ALL_FEED_FIELDS.length);
  });

  // The four opt-ins are what bring five feeds under the 16 KiB cap. If one of
  // them landed in the lean set, every default call would carry it again.
  it("the two CDN image URLs and the issuer link list are NOT in the lean set", () => {
    for (const field of ["iconUrl", "headerUrl", "links", "dexScreenerUrl"]) {
      expect(LEAN_FEED_FIELDS).not.toContain(field);
      expect(RICH_FEED_FIELDS).toContain(field);
    }
  });

  it("eventAgeSeconds means the same thing on every feed that reports a time", () => {
    const rows = everyFeedRow().filter(([kind]) => kind !== "boost");
    for (const [kind, row] of rows) {
      expect(row, `${kind} row lost its age`).toHaveProperty("eventAgeSeconds");
    }
    // The boost feeds carry no timestamp of any kind, so the field is ABSENT
    // rather than null — an absent field says "this feed does not report time",
    // where `null` would say "this row happens to have none".
    const boost = everyFeedRow().find(([kind]) => kind === "boost")?.[1];
    expect(boost).not.toHaveProperty("eventAgeSeconds");
  });
});

describe("AgentDexNarrative naming law", () => {
  it("every emitted field name is either declared non-numeric or carries a unit suffix", () => {
    const offenders = Object.keys(fullNarrativeRow()).filter(
      (field) => !NON_NUMERIC_NARRATIVE_FIELDS.has(field) && !UNIT_SUFFIX.test(field),
    );
    expect(offenders).toEqual([]);
  });

  it("every field carrying a unit suffix really is a number or null", () => {
    const lying = Object.entries(fullNarrativeRow()).filter(
      ([field, value]) =>
        !NON_NUMERIC_NARRATIVE_FIELDS.has(field)
        && UNIT_SUFFIX.test(field)
        && value !== null
        && typeof value !== "number",
    );
    expect(lying).toEqual([]);
  });

  // The provider ships `marketCapChange` and `marketCapDelta` as two
  // identically-shaped maps. One is a percentage and one is absolute USD, and
  // neither name says which.
  it("the two identically-shaped provider maps are told apart by their units", () => {
    const row = fullNarrativeRow();
    expect(row).toHaveProperty("marketCapChangePctH24");
    expect(row).toHaveProperty("marketCapDeltaUsdH24");
    expect(row).not.toHaveProperty("marketCapChange");
    expect(row).not.toHaveProperty("marketCapDelta");

    const meta = metasTrending()[0];
    // The percent and the absolute move for the same window differ by orders of
    // magnitude, which is exactly why conflating them is dangerous.
    expect(row.marketCapChangePctH24).toBe(meta?.marketCapChange?.h24 ?? null);
    expect(row.marketCapDeltaUsdH24).toBe(meta?.marketCapDelta?.h24 ?? null);
  });

  it("the narrative token count is named for the narrative, not for a subset", () => {
    const row = fullNarrativeRow();
    expect(row).toHaveProperty("narrativeTokenCount");
    expect(row).not.toHaveProperty("tokenCount");
  });

  it("lean and rich sets are disjoint and together are the whole vocabulary", () => {
    const overlap = LEAN_NARRATIVE_FIELDS.filter((field) => RICH_NARRATIVE_FIELDS.includes(field));
    expect(overlap).toEqual([]);
    expect(LEAN_NARRATIVE_FIELDS.length + RICH_NARRATIVE_FIELDS.length).toBe(
      ALL_NARRATIVE_FIELDS.length,
    );
  });
});
