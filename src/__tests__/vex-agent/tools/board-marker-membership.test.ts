/**
 * MARKER MEMBERSHIP, decided at persisted-spec construction.
 *
 * The defect this guards: `lightweight-charts` does not refuse a marker whose
 * time is absent from the series - it SNAPS it to a neighbouring bar. A marker
 * is the agent's claim about one specific bar, so a snapped marker silently
 * becomes a claim about a bar the agent never looked at. `hydrate.ts` therefore
 * decides membership once, against the exact bars that are persisted beside the
 * marker, and the renderer omits the unmatched ones and names them in words.
 *
 * Both directions matter, so both are asserted: a marker that lands exactly on
 * a bar must stay drawable, and a marker that lands anywhere else must not.
 */

import { describe, expect, it } from "vitest";
import { unmatchedMarkerInstants } from "@vex-agent/tools/internal/board/hydrate.js";
import type { BoardCandle } from "../../../lib/board/index.js";

const HOUR_MS = 3_600_000;
const T0 = 1_756_000_000_000;

const BARS: readonly BoardCandle[] = [
  { tMs: T0, o: "1.0", h: "1.2", l: "0.9", c: "1.1" },
  { tMs: T0 + HOUR_MS, o: "1.1", h: "1.3", l: "1.0", c: "1.25" },
];

function chartWith(atMsValues: readonly number[]) {
  return {
    poolIndex: 0,
    resolution: "1h" as const,
    annotations: [
      { kind: "level" as const, price: "1.20", label: "resistance" },
      ...atMsValues.map((atMs) => ({
        kind: "marker" as const,
        atMs,
        label: "entry",
      })),
    ],
  };
}

describe("unmatchedMarkerInstants", () => {
  it("keeps a marker that lands exactly on a persisted bar", () => {
    expect(unmatchedMarkerInstants(chartWith([T0, T0 + HOUR_MS]), BARS)).toEqual([]);
  });

  it("reports a marker that lands between bars, even by one millisecond", () => {
    // One millisecond off is the whole point: the library would snap this onto
    // the T0 bar and the reader would see analysis of a bar nobody analysed.
    expect(unmatchedMarkerInstants(chartWith([T0 + 1]), BARS)).toEqual([T0 + 1]);
    expect(
      unmatchedMarkerInstants(chartWith([T0 + HOUR_MS / 2]), BARS),
    ).toEqual([T0 + HOUR_MS / 2]);
  });

  it("reports a marker outside the covered range in either direction", () => {
    const before = T0 - HOUR_MS;
    const after = T0 + 5 * HOUR_MS;
    expect(unmatchedMarkerInstants(chartWith([before, after]), BARS)).toEqual([
      before,
      after,
    ]);
  });

  it("reports every marker when the series carried no bars at all", () => {
    expect(unmatchedMarkerInstants(chartWith([T0]), [])).toEqual([T0]);
  });

  it("judges only markers, and answers null for a board with no chart", () => {
    // Levels and zones are price coordinates: they are drawn wherever the
    // price axis puts them and have no bar to miss.
    expect(unmatchedMarkerInstants(chartWith([]), BARS)).toEqual([]);
    expect(unmatchedMarkerInstants(undefined, BARS)).toBeNull();
  });
});
