/**
 * Param validation on the feed and narrative tools.
 *
 * EVERY CASE HERE WAS A LIVE DEFECT, on the tools that had params at all:
 *
 * - `limit: NaN` — the old reader checked `typeof value === "number"` and nothing
 *   else, so a NaN threshold made every comparison false, dropped every row, and
 *   reported an empty market that a bad parameter had invented.
 * - `limit: 0` — meant "20" in `search` and "everything" in `attention` and
 *   `trending`. One value, two opposite meanings. It is now REJECTED so it can mean
 *   neither.
 * - `limit: -5` — fell through to a hidden default.
 * - `attention.limit` and `trending.limit` had NO MAXIMUM.
 * - An unknown parameter was silently ignored, which is indistinguishable from a
 *   parameter that had no matching rows.
 *
 * The rule these all serve: a rejection NAMES the offending parameter, because the
 * agent has to be able to fix it in one turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import {
  adsLatest,
  boostsLatest,
  boostsTop,
  communityTakeovers,
  metaCat,
  metasTrending,
  profilesLatest,
  profilesRecent,
} from "./_feed-captures.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

async function run(
  toolId: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  return { ok: result.success, output: result.output };
}

/** The tools whose whole param surface this card introduced. */
const NEW_PARAM_TOOLS = [
  "dexscreener.profiles",
  "dexscreener.profiles.recent",
  "dexscreener.boosts",
  "dexscreener.boosts.top",
  "dexscreener.communityTakeovers",
  "dexscreener.attention",
  "dexscreener.ads",
  "dexscreener.trending",
] as const;

describe("DexScreener feed + narrative param validation", () => {
  beforeEach(() => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getProfiles").mockResolvedValue(profilesLatest());
    vi.spyOn(client, "getProfilesRecentUpdates").mockResolvedValue(profilesRecent());
    vi.spyOn(client, "getBoosts").mockResolvedValue(boostsLatest());
    vi.spyOn(client, "getTopBoosts").mockResolvedValue(boostsTop());
    vi.spyOn(client, "getCommunityTakeovers").mockResolvedValue(communityTakeovers());
    vi.spyOn(client, "getAds").mockResolvedValue(adsLatest());
    vi.spyOn(client, "getMetasTrending").mockResolvedValue(metasTrending());
    vi.spyOn(client, "getMeta").mockResolvedValue(metaCat());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── limit: the value that meant two opposite things ─────────────

  it("limit: 0 is rejected on every tool, because it cannot mean both none and all", async () => {
    for (const toolId of NEW_PARAM_TOOLS) {
      const result = await run(toolId, { limit: 0 });
      expect(result.ok, `${toolId} accepted limit: 0`).toBe(false);
      expect(result.output).toContain("limit");
    }
  });

  it("a negative limit is rejected by name, not swallowed into a default", async () => {
    for (const toolId of NEW_PARAM_TOOLS) {
      const result = await run(toolId, { limit: -5 });
      expect(result.ok, `${toolId} accepted limit: -5`).toBe(false);
      expect(result.output).toContain("limit");
    }
  });

  it("NaN is rejected by name, with the reason it is dangerous", async () => {
    const result = await run("dexscreener.boosts", { minBoostCountTotal: Number.NaN });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("minBoostCountTotal");
    expect(result.output).toContain("finite");
    expect(result.output).toContain("drop every row");
  });

  it("Infinity is rejected too — it is the other non-finite", async () => {
    const result = await run("dexscreener.trending", { minMarketCapUsd: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("minMarketCapUsd");
  });

  it("limit now has a maximum, which attention and trending never had", async () => {
    for (const toolId of ["dexscreener.attention", "dexscreener.trending"]) {
      const result = await run(toolId, { limit: 5_000 });
      expect(result.ok, `${toolId} accepted limit: 5000`).toBe(false);
      expect(result.output).toContain("at most 200");
    }
  });

  it("a fractional limit is rejected — half a row is not a request", async () => {
    const result = await run("dexscreener.profiles", { limit: 7.5 });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("whole number");
  });

  // ── Wrong types, named ─────────────────────────────────────────

  it("a limit sent as a string is rejected naming the type it got", async () => {
    const result = await run("dexscreener.profiles", { limit: "15" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("must be a number");
    expect(result.output).toContain("string");
  });

  // CONTRACT CHANGE, and the reason is measured. This case used to assert the
  // array spelling was REJECTED. `call-records.json` (persona gate, first
  // record) shows what that cost live: `dexscreener.profiles
  // {chainIds:["solana"], limit:15}` → 78 bytes, ok:false, while the identical
  // call spelled `"solana"` → 5,215 bytes of answer. A JSON tool call makes the
  // array natural. Both spellings are now accepted and must agree exactly —
  // see `./list-string-array-params.test.ts` for the equivalence pins.
  it("chainIds sent as an array is accepted and means the same as the comma string", async () => {
    const fromArray = await run("dexscreener.profiles", { chainIds: ["base", "solana"] });
    const fromString = await run("dexscreener.profiles", { chainIds: "base,solana" });
    expect(fromArray.ok).toBe(true);
    expect(fromString.ok).toBe(true);
    // Everything but `asOfMs`, which is our clock at response time and so is the
    // one field legitimately allowed to differ between two calls.
    const withoutClock = (output: string): unknown => {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      delete parsed.asOfMs;
      return parsed;
    };
    expect(withoutClock(fromArray.output)).toEqual(withoutClock(fromString.output));
  });

  it("a chainIds array with a non-string member is still rejected, by position", async () => {
    const result = await run("dexscreener.profiles", { chainIds: ["base", 7] });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("chainIds");
    expect(result.output).toContain("index 1");
  });

  it("a chainIds string with no values in it is rejected rather than ignored", async () => {
    const result = await run("dexscreener.profiles", { chainIds: " , , " });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("contained no values");
  });

  it("ctoOnly sent as a string is rejected — a truthy string is not a boolean", async () => {
    const result = await run("dexscreener.profiles", { ctoOnly: "true" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ctoOnly");
    expect(result.output).toContain("true or false");
  });

  // ── Unknown values, named, with the accepted set ────────────────

  it("an unknown sortBy is rejected listing the keys this feed can order by", async () => {
    const result = await run("dexscreener.profiles", { sortBy: "boostCountTotal" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("sortBy");
    // The profiles feed carries no boost units, so it names what it CAN sort by.
    expect(result.output).toContain("eventAgeSeconds");
  });

  it("an unknown field is rejected with the complete accepted list", async () => {
    const result = await run("dexscreener.boosts", { fields: "icon" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("icon");
    expect(result.output).toContain("iconUrl");
    expect(result.output).toContain("full");
  });

  it("an unknown narrative field is rejected the same way", async () => {
    const result = await run("dexscreener.trending", { fields: "marketCapChange" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("marketCapChangePctM5");
  });

  it("fields=full is accepted everywhere as the discovery escape hatch", async () => {
    for (const toolId of NEW_PARAM_TOOLS) {
      const result = await run(toolId, { fields: "full" });
      expect(result.ok, `${toolId} rejected fields: full`).toBe(true);
    }
  });

  // ── Zero thresholds are no-ops, not filters ────────────────────

  it("a zero threshold admits every row instead of dropping the unmeasured ones", async () => {
    // The old `(value ?? -Infinity) >= 0` made a zero floor drop every row whose
    // value was unknown — a filter the caller did not ask for.
    const result = await run("dexscreener.boosts", { minBoostCountTotal: 0 });
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.output) as {
      returned: number;
      droppedByFilter: Record<string, number>;
      providerWindow: { providerReturned: number };
    };
    expect(data.returned).toBe(data.providerWindow.providerReturned);
    expect(data.droppedByFilter.minBoostCountTotal).toBeUndefined();
  });

  it("a zero freshness ceiling is a real threshold, not a no-op", async () => {
    // `updatedWithinSeconds: 0` asks for profiles updated this instant. It is a
    // genuine question with a genuine answer (usually none), so it filters.
    const result = await run("dexscreener.profiles", { updatedWithinSeconds: 0 });
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.output) as { droppedByFilter: Record<string, number> };
    expect(Object.keys(data.droppedByFilter).length).toBeGreaterThan(0);
  });

  // ── Echo of what was applied ───────────────────────────────────

  it("filtersApplied echoes only what the caller supplied, normalised", async () => {
    const result = await run("dexscreener.profiles", { chainIds: "ROBINHOOD", limit: 5 });
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.output) as { filtersApplied: Record<string, unknown> };
    // Lowercased to agree with the rows it describes: every provider row carries a
    // lowercase slug, and an echo that disagrees with its data is worse than none.
    expect(data.filtersApplied.chainIds).toEqual(["robinhood"]);
    // `limit` is a window, not a filter, so it is not echoed as one; the unset
    // filters are absent rather than present as null.
    expect(data.filtersApplied.ctoOnly).toBeUndefined();
    expect(data.filtersApplied.updatedWithinSeconds).toBeUndefined();
    expect(data.filtersApplied.sortBy).toBe("relevance");
  });

  it("offset skips rows of the same window and says how many remain", async () => {
    const result = await run("dexscreener.profiles", { offset: 25 });
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.output) as {
      offset: number;
      returned: number;
      totalMatched: number;
      hasMore: boolean;
    };
    expect(data.offset).toBe(25);
    expect(data.returned).toBe(5);
    expect(data.totalMatched).toBe(30);
    expect(data.hasMore).toBe(false);
  });

  // ── The rejection always names the tool as well as the param ────

  it("a rejection names the tool, so the agent knows which call to fix", async () => {
    const result = await run("dexscreener.communityTakeovers", { limit: 0 });
    expect(result.output).toContain("dexscreener.communityTakeovers");
  });
});
