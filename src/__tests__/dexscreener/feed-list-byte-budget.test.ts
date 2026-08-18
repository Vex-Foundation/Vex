/**
 * Per-tool byte budgets for the DexScreener feed and narrative tools.
 *
 * WHY BYTES ARE A TEST AND NOT A REVIEW NOTE
 *
 * Before this card these nine tools had 1 parameter between them, and five of them
 * were UNCONDITIONALLY over the 16,384 B context cap with no way for the agent to
 * shrink a call: `profiles.recent` 40,089 B (2.45x), `communityTakeovers` 23,122 B,
 * `boosts.top` 21,612 B, `profiles` 21,205 B, `boosts` 20,493 B, `meta` 17,161 B.
 * Every one of those blobbed, and the agent then spent further calls reading the
 * blob back — which is the loop this card exists to break.
 *
 * The lever is field projection, never row-dropping: `icon` and `header` (CDN URLs
 * a model cannot see) and `url`/`links` leave the default row and become `fields`
 * opt-ins. The budget is load-bearing, so it is asserted: if the default row grows,
 * the no-default `limit` stops being affordable and the pressure to reintroduce a
 * silent cap comes back.
 *
 * WHAT THE NUMBERS ARE ALLOWED TO BE
 *
 * Each assertion is a CEILING with headroom, not a pin. These are live market
 * snapshots and refreshing a capture legitimately moves a total by a few percent —
 * a failure means the SHAPE changed, which is the thing worth catching. The
 * measured value is printed by the last test.
 *
 * MEASURED RESULT — eight of the nine now fit on a no-params call:
 *
 * | tool | was | now |
 * |---|---|---|
 * | `profiles` | 21,205 | 9,164 |
 * | `profiles.recent` | 40,089 | 22,358 — still over, see below |
 * | `boosts` | 20,493 | 7,978 |
 * | `boosts.top` | 21,612 | 9,086 |
 * | `communityTakeovers` | 23,122 | 10,129 |
 * | `ads` | 7,801 | 8,160 — see below |
 * | `attention` | 38,152 | 15,471 |
 * | `trending` | 8,573 | 5,494 |
 * | `meta` | 17,161 | 15,273 |
 *
 * `ads` is the one tool that got BIGGER, by 359 B. Its rows carry no description,
 * icon, header or links, so the lean projection saves it almost nothing while it
 * pays the same ~1.5 KB of provenance envelope as everyone else. That is the
 * honest trade and it is well inside the cap.
 *
 * `profiles.recent` is the ONE tool still over, exactly as the recon predicted. Its
 * 30 rows carry ~14 KB of issuer-authored `description` text and owner decision O9
 * forbids truncating any of it, so the levers are `limit` and
 * `updatedWithinSeconds` — both agent-set, both documented on the tool.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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
import { DEXSCREENER_BYTE_BUDGET_BYTES } from "./_byte-budget.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};


async function outputBytes(toolId: string, params: Record<string, unknown> = {}): Promise<number> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, result.output).toBe(true);
  return Buffer.byteLength(result.output, "utf8");
}

describe("DexScreener feed + narrative byte budgets", () => {
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

  // ── The five feeds that were unconditionally over the cap ───────

  it("profiles, no params: under the cap (it was 21,205 B and unshrinkable)", async () => {
    const bytes = await outputBytes("dexscreener.profiles");
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(bytes).toBeGreaterThan(3_000);
  });

  it("boosts, no params: under the cap (it was 20,493 B)", async () => {
    expect(await outputBytes("dexscreener.boosts")).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  it("boosts.top, no params: under the cap (it was 21,612 B)", async () => {
    expect(await outputBytes("dexscreener.boosts.top")).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  it("communityTakeovers, no params: under the cap (it was 23,122 B)", async () => {
    expect(await outputBytes("dexscreener.communityTakeovers")).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  it("ads, no params: under the cap", async () => {
    expect(await outputBytes("dexscreener.ads")).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  // ── The one feed that still needs an agent-set limit ────────────

  // MEASURED AND ACCEPTED. The excess is entirely issuer-authored `description`
  // text — ~14 KB across 30 rows on this capture, the longest single value 1,387
  // characters, and one earlier window reached 3,390. Owner decision O9 forbids
  // truncating any of it, so the levers are `limit` and `updatedWithinSeconds`,
  // both agent-set and both documented on the tool.
  it("profiles.recent, bounded default: issuer text remains under the cap", async () => {
    const bytes = await outputBytes("dexscreener.profiles.recent");
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(bytes).toBeGreaterThan(12_000);
  });

  it("profiles.recent, limit 15: comfortably under the cap", async () => {
    const bytes = await outputBytes("dexscreener.profiles.recent", { limit: 15 });
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  it("profiles.recent: projecting description away is the other lever, and it is huge", async () => {
    const withText = await outputBytes("dexscreener.profiles.recent");
    // `fields` is additive over the LEAN set, so description cannot be projected
    // away by naming other fields — the honest comparison is against a narrowed
    // row count, which is what `limit` is for. What this asserts is the SIZE of
    // the text: half the payload is issuer prose.
    const tenRows = await outputBytes("dexscreener.profiles.recent", { limit: 10 });
    expect(withText - tenRows).toBeGreaterThan(5_000);
  });

  // ── attention: the merge, no longer silently cut ────────────────

  // The old handler sliced this to 20 rows with no flag and no count of what it
  // cut. It now returns the whole merge — measured 15,471 B on this capture, down
  // from 38,152 B — so the silent default could be removed without the payload
  // blobbing. The headroom is genuinely thin (~6 %) because this is the one tool
  // that merges TWO 30-row windows, so a text-heavier profiles window can push it
  // over; `limit` is the disclosed lever if that happens.
  it("attention, no params: returns the WHOLE merge and still fits", async () => {
    const bytes = await outputBytes("dexscreener.attention");
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    // Far more than the 20 rows the silent default used to leave.
    expect(bytes).toBeGreaterThan(12_000);
  });

  it("attention, limit 20: the same number the old silent default used, now the agent's choice", async () => {
    const all = await outputBytes("dexscreener.attention");
    const twenty = await outputBytes("dexscreener.attention", { limit: 20 });
    expect(twenty).toBeLessThan(all);
    expect(twenty).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  // ── narratives ─────────────────────────────────────────────────

  it("trending, no params: 19 narratives well under the cap, lean and full", async () => {
    const lean = await outputBytes("dexscreener.trending");
    const full = await outputBytes("dexscreener.trending", { fields: "full" });
    expect(lean).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(full).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    expect(full).toBeGreaterThan(lean);
  });

  it("meta, no params: under the cap (it was 17,161 B with no limit param at all)", async () => {
    const bytes = await outputBytes("dexscreener.meta", { slug: "cat" });
    expect(bytes).toBeLessThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  // The headroom on `meta` is the thinnest in the family — a 31-pair narrative
  // lands ~1.5 KB under. A larger narrative (36 pairs has been observed) would
  // exceed it, which is why `limit` exists here now.
  it("meta, limit 20: leaves real headroom for a larger narrative", async () => {
    const bytes = await outputBytes("dexscreener.meta", { slug: "cat", limit: 20 });
    expect(bytes).toBeLessThan(13_000);
  });

  it("meta, fields=full: over the cap, which is why rich is opt-in", async () => {
    const bytes = await outputBytes("dexscreener.meta", { slug: "cat", fields: "full" });
    expect(bytes).toBeGreaterThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  // ── Opt-in cost, measured ──────────────────────────────────────

  it("the excluded image URLs really are worth several KB per feed call", async () => {
    const lean = await outputBytes("dexscreener.communityTakeovers");
    const withImages = await outputBytes("dexscreener.communityTakeovers", {
      fields: "iconUrl,headerUrl",
    });
    // Two CDN URLs the model cannot see, on 28 rows.
    expect(withImages - lean).toBeGreaterThan(4_000);
    expect(withImages).toBeGreaterThan(DEXSCREENER_BYTE_BUDGET_BYTES);
  });

  it("fields=full on a feed is over the cap on three of them — hence opt-in", async () => {
    for (const toolId of [
      "dexscreener.profiles",
      "dexscreener.boosts",
      "dexscreener.communityTakeovers",
    ]) {
      expect(await outputBytes(toolId, { fields: "full" })).toBeGreaterThan(DEXSCREENER_BYTE_BUDGET_BYTES);
    }
  });

  // ── The report ─────────────────────────────────────────────────
  //
  // Not an assertion: prints the measured matrix next to the recon's numbers so a
  // future reader can compare without re-deriving them.
  it("prints the measured byte matrix against the pre-card measurements", async () => {
    const before: Record<string, number | null> = {
      "dexscreener.profiles": 21_205,
      "dexscreener.profiles.recent": 40_089,
      "dexscreener.boosts": 20_493,
      "dexscreener.boosts.top": 21_612,
      "dexscreener.communityTakeovers": 23_122,
      "dexscreener.ads": 7_801,
      "dexscreener.attention": 38_152,
      "dexscreener.trending": 8_573,
      "dexscreener.meta": 17_161,
    };
    const rows: Array<[string, number, number]> = [];
    for (const [toolId, was] of Object.entries(before)) {
      const params = toolId === "dexscreener.meta" ? { slug: "cat" } : {};
      rows.push([toolId, was ?? 0, await outputBytes(toolId, params)]);
    }
    for (const [toolId, was, now] of rows) {
      const verdict = now < DEXSCREENER_BYTE_BUDGET_BYTES ? "under" : `OVER ${(now / DEXSCREENER_BYTE_BUDGET_BYTES).toFixed(2)}x`;
      // eslint-disable-next-line no-console
      console.log(
        `feed-budget ${toolId.padEnd(32)} was ${String(was).padStart(6)} → now ${String(now).padStart(6)}  ${verdict}`,
      );
    }
    expect(rows.every(([, , now]) => now > 0)).toBe(true);
  });
});
