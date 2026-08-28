/**
 * THE v3 DERIVATIONS - the subtitle the runtime authors, and the gathering of
 * everything the MODEL authored.
 *
 * Both are pure, and both are tested here rather than only through a rendered
 * surface, because both are single-source derivations that three surfaces
 * consume. A drift between the preview card's subtitle and the modal's would
 * be a defect nobody would notice in a screenshot.
 */

import { describe, expect, it } from "vitest";
import {
  boardSubtitle,
  buildBoardAuthoredContent,
  buildBoardViewModel,
} from "../boardModel.js";
import { FIXTURE_FETCHED_AT, boardSpec, hydratedRow } from "./boardFixture.js";

describe("boardSubtitle", () => {
  it("names the pool count and the UTC clock of the figures on screen", () => {
    const spec = boardSpec({
      pools: [
        { chain: "base", pairAddress: "0xa", analysis: null },
        { chain: "base", pairAddress: "0xb", analysis: null },
      ],
      rows: [hydratedRow(), hydratedRow()],
      marketDataFetchedAt: Date.UTC(2026, 7, 26, 11, 11),
    });
    const model = buildBoardViewModel(spec, Date.now());
    expect(boardSubtitle(model)).toBe("2 pools · 26 Aug · 11:11 UTC");
  });

  it("singularises a one-pool board", () => {
    const model = buildBoardViewModel(boardSpec(), Date.now());
    expect(boardSubtitle(model)).toMatch(/^1 pool · /);
  });

  it("is UTC, NOT the reader's locale", () => {
    // A locale clock would make the same instant read differently in a
    // screenshot than in the transcript that produced it, which is exactly
    // the comparison a reader makes constantly on this surface.
    const spec = boardSpec({ marketDataFetchedAt: Date.UTC(2026, 0, 1, 23, 45) });
    const model = buildBoardViewModel(spec, Date.now());
    expect(boardSubtitle(model)).toContain("1 Jan · 23:45 UTC");
  });

  it("follows the LIVE clock when live rows are drawn over the board", () => {
    const spec = boardSpec({ marketDataFetchedAt: Date.UTC(2026, 7, 26, 11, 11) });
    const model = buildBoardViewModel(spec, Date.now(), {
      mode: "live-connected",
      rowsByKey: new Map(),
      fetchedAtMs: Date.UTC(2026, 7, 26, 12, 30),
    });
    expect(boardSubtitle(model)).toContain("12:30 UTC");
  });
});

describe("buildBoardAuthoredContent", () => {
  it("gathers every authored string a board can carry", () => {
    const spec = boardSpec({
      pools: [
        {
          chain: "base",
          pairAddress: "0xa",
          caption: "Volume led it.",
          analysis: "Momentum elevated.",
        },
        { chain: "base", pairAddress: "0xb", analysis: null },
      ],
      rows: [
        hydratedRow({ baseTokenSymbol: "AAA" }),
        hydratedRow({ baseTokenSymbol: "BBB" }),
      ],
      notes: ["Read during a volatile hour."],
      annotations: [{ kind: "level", price: "0.00000123", label: "Prior high" }],
    });
    const content = buildBoardAuthoredContent(spec);
    expect(content.captions).toEqual([
      { key: "caption/0", heading: "AAA", caption: "Volume led it." },
    ]);
    expect(content.assessments).toEqual([
      { key: "analysis/0", heading: "AAA", analysis: "Momentum elevated." },
    ]);
    expect(content.notes).toEqual(["Read during a volatile hour."]);
    expect(content.annotations.map((row) => row.label)).toEqual(["Prior high"]);
    expect(content.provenance.transport).not.toBe("");
    expect(content.empty).toBe(false);
  });

  it("keeps the TWO clocks apart", () => {
    // One timestamp for both would either make a fresh price claim the
    // analysis is fresh, or make a refreshed board look stale.
    const content = buildBoardAuthoredContent(
      boardSpec({
        analysisCreatedAt: FIXTURE_FETCHED_AT - 60_000,
        marketDataFetchedAt: FIXTURE_FETCHED_AT,
      }),
    );
    expect(content.analysisCreatedAt).toBe(FIXTURE_FETCHED_AT - 60_000);
    expect(content.marketDataFetchedAt).toBe(FIXTURE_FETCHED_AT);
  });

  it("reports a board with no authored prose as empty, not as broken", () => {
    const content = buildBoardAuthoredContent(boardSpec());
    expect(content.empty).toBe(true);
    // Provenance is RUNTIME-authored and always present, so the section still
    // has something honest to show.
    expect(content.provenance.sourceObservation).not.toBe("");
  });

  it("falls back to the pair address when a pool's row has no symbol", () => {
    const content = buildBoardAuthoredContent(
      boardSpec({
        pools: [{ chain: "base", pairAddress: "0xfeed", caption: "note", analysis: null }],
        rows: [hydratedRow({ baseTokenSymbol: null })],
      }),
    );
    expect(content.captions[0]?.heading).toBe("0xfeed");
  });

  it("carries the unmatched-marker REASON, so the claim is never deleted", () => {
    const atMs = 1_783_100_000_000;
    const spec = boardSpec({
      annotations: [{ kind: "marker", atMs, label: "Listing" }],
    });
    const withUnmatched = {
      ...spec,
      hydration: { ...spec.hydration, unmatchedMarkerAtMs: [atMs] },
    };
    const content = buildBoardAuthoredContent(withUnmatched);
    expect(content.annotations[0]?.label).toBe("Listing");
    expect(content.annotations[0]?.note).toContain("matches no candle");
  });
});
