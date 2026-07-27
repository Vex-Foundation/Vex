/**
 * W2B pins for the `tweet_search` filter vocabulary.
 *
 * `filter.cashtags` — the live recon established that X's native cashtag
 * operator already works through `includeWords` (rettiwt joins those words RAW),
 * so the capability existed but the `$` handling was folklore. The param names
 * it, validates the syntax, and normalizes into `includeWords` deduped against
 * the query.
 *
 * `filter.withinHours` — the momentum question is always relative ("who is
 * talking about this token TODAY"). It derives ONE `startDate`, in the schema,
 * so the value sent to X and the value echoed to the agent cannot drift apart.
 * Conflicts are rejected rather than silently resolved.
 *
 * `filter.min*` — rettiwt gates every numeric operator on TRUTHINESS
 * (`this.minLikes ? …`), so a `0` floor is dropped from the query instead of
 * applied. Zero is rejected BY NAME rather than silently discarded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwitterAccountParamsSchema } from "@tools/twitter-account/schema.js";

type TweetSearch = Extract<
  import("@tools/twitter-account/schema.js").TwitterAccountParams,
  { action: "tweet_search" }
>;

function parseSearch(params: Record<string, unknown>): TweetSearch {
  const parsed = TwitterAccountParamsSchema.safeParse({ action: "tweet_search", ...params });
  if (!parsed.success) {
    throw new Error(`expected a valid tweet_search: ${parsed.error.issues[0]?.message ?? "?"}`);
  }
  return parsed.data as TweetSearch;
}

function rejection(params: Record<string, unknown>): string {
  const parsed = TwitterAccountParamsSchema.safeParse({ action: "tweet_search", ...params });
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error("unreachable");
  const issue = parsed.error.issues[0];
  if (!issue) throw new Error("a failed parse must carry at least one issue");
  return `${issue.path.map(String).join(".")}: ${issue.message}`;
}

describe("tweet_search — cashtags", () => {
  it("normalizes cashtags into includeWords with a leading $", () => {
    const parsed = parseSearch({ filter: { cashtags: ["WIF", "$BONK"] } });
    expect(parsed.filter?.includeWords).toEqual(["$WIF", "$BONK"]);
    expect(parsed.filter).not.toHaveProperty("cashtags");
  });

  it("dedupes against includeWords and against itself, case-insensitively", () => {
    const parsed = parseSearch({
      filter: { cashtags: ["WIF", "wif", "$BONK"], includeWords: ["$wif", "moon"] },
    });
    expect(parsed.filter?.includeWords).toEqual(["$wif", "moon", "$BONK"]);
  });

  it("rejects cashtag syntax that X cannot match", () => {
    expect(rejection({ filter: { cashtags: ["not a ticker"] } })).toContain("cashtags");
    expect(rejection({ filter: { cashtags: ["$"] } })).toContain("cashtags");
    expect(rejection({ filter: { cashtags: ["WIF!"] } })).toContain("cashtags");
  });
});

describe("tweet_search — withinHours", () => {
  const NOW = new Date("2026-07-27T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives startDate as an exact UTC instant `withinHours` before now", () => {
    const parsed = parseSearch({ filter: { withinHours: 24 } });
    expect(parsed.filter?.startDate).toBe("2026-07-26T12:00:00.000Z");
    expect(parsed.filter).not.toHaveProperty("withinHours");
  });

  it("REJECTS withinHours together with an explicit startDate", () => {
    const message = rejection({
      filter: { withinHours: 24, startDate: "2026-07-01T00:00:00.000Z" },
    });
    expect(message).toContain("withinHours");
    expect(message).toContain("startDate");
  });

  it("REJECTS an endDate earlier than the derived start", () => {
    const message = rejection({
      filter: { withinHours: 24, endDate: "2026-07-20T00:00:00.000Z" },
    });
    expect(message).toContain("endDate");
  });

  it("accepts an endDate after the derived start", () => {
    const parsed = parseSearch({
      filter: { withinHours: 24, endDate: "2026-07-27T06:00:00.000Z" },
    });
    expect(parsed.filter?.startDate).toBe("2026-07-26T12:00:00.000Z");
    expect(parsed.filter?.endDate).toBe("2026-07-27T06:00:00.000Z");
  });

  it("rejects a non-positive or absurd window", () => {
    expect(rejection({ filter: { withinHours: 0 } })).toContain("withinHours");
    expect(rejection({ filter: { withinHours: -3 } })).toContain("withinHours");
    expect(rejection({ filter: { withinHours: 10_000 } })).toContain("withinHours");
  });
});

describe("tweet_search — engagement floors", () => {
  it("rejects a ZERO floor by name (rettiwt would silently drop it)", () => {
    for (const field of ["minLikes", "minReplies", "minRetweets"]) {
      const message = rejection({ filter: { [field]: 0 } });
      expect(message).toContain(field);
      expect(message).toContain("0");
    }
  });

  it("accepts a floor of 1 and above", () => {
    const parsed = parseSearch({ filter: { minLikes: 1, minRetweets: 10 } });
    expect(parsed.filter?.minLikes).toBe(1);
    expect(parsed.filter?.minRetweets).toBe(10);
  });
});
