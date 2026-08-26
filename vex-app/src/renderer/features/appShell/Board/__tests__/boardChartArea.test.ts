/**
 * THE AREA ADAPTER AND ITS RECONCILIATION TABLE.
 *
 * Every row of SPOTLIGHT-CHART-CONTRACT 2.2 is a claim about one pure
 * function, which is why the function is pure: the alternative is asserting
 * these against a canvas, where a wrong branch shows up as a reader's
 * viewport jumping rather than as a red test.
 *
 * THE COMPARISON IS OVER TIMESTAMP SETS (A8's correction over the annex). A
 * rolling window that replaced a constant NUMBER of bars is viewport-neutral
 * only for a reader sitting at the live edge; for a reader scrolled back it
 * silently swaps the bars under their eyes. So the cases below are stated in
 * terms of which timestamps left, arrived, or changed value, and the two the
 * annex missed - an interior removal and a trim combined with an append - are
 * their own rows.
 */

import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it, vi } from "vitest";
import {
  AREA_MAX_HISTORICAL_UPDATES,
  AreaFeed,
  normalizeBoardAreaPoints,
  reconcileAreaSeries,
  toChartAreaPoint,
  type BoardChartAreaPoint,
} from "../boardChartFeed.js";

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 7, 26, 11, 0, 0);

function row(minute: number, close: string | null) {
  return {
    tMs: BASE + minute * MINUTE,
    o: close,
    h: close,
    l: close,
    c: close,
  };
}

function point(minute: number, value: number | null): BoardChartAreaPoint {
  const time = Math.floor((BASE + minute * MINUTE) / 1000) as UTCTimestamp;
  return value === null ? { time } : { time, value };
}

describe("toChartAreaPoint", () => {
  it("derives the close and floors the instant to one second", () => {
    expect(toChartAreaPoint(row(0, "0.00000123"))).toEqual({
      time: Math.floor(BASE / 1000),
      value: 0.00000123,
    });
  });

  it("makes a bucket with no close into whitespace, never a zero", () => {
    const converted = toChartAreaPoint(row(1, null));
    expect(converted).toEqual({ time: Math.floor((BASE + MINUTE) / 1000) });
    expect("value" in converted).toBe(false);
  });

  it("refuses a close that is not a finite decimal", () => {
    expect("value" in toChartAreaPoint(row(2, "not-a-number"))).toBe(false);
  });
});

describe("normalizeBoardAreaPoints", () => {
  it("sorts, deduplicates last-write-wins, and reports its own bounds", () => {
    const normalized = normalizeBoardAreaPoints([
      row(2, "3"),
      row(0, "1"),
      row(2, "4"),
      row(1, "2"),
    ]);
    expect(normalized.points.map((p) => ("value" in p ? p.value : null))).toEqual([
      1, 2, 4,
    ]);
    expect(normalized.totalDistinct).toBe(3);
    expect(normalized.hiddenOlder).toBe(0);
    expect(normalized.oldestTimeSec).toBe(Math.floor(BASE / 1000));
    expect(normalized.newestTimeSec).toBe(Math.floor((BASE + 2 * MINUTE) / 1000));
  });

  it("counts whitespace rather than hiding it", () => {
    expect(normalizeBoardAreaPoints([row(0, "1"), row(1, null)]).whitespaceCount).toBe(1);
  });

  it("reports the older bars a budget kept off the chart", () => {
    const rows = Array.from({ length: 260 }, (_, index) => row(index, "1"));
    const normalized = normalizeBoardAreaPoints(rows);
    expect(normalized.points).toHaveLength(200);
    expect(normalized.hiddenOlder).toBe(60);
    expect(normalized.totalDistinct).toBe(260);
  });
});

describe("reconcileAreaSeries", () => {
  const held = [point(0, 1), point(1, 2), point(2, 3)];

  it("row 1: the forming bar re-emitted with a new value is an append", () => {
    const plan = reconcileAreaSeries(held, [point(0, 1), point(1, 2), point(2, 9)]);
    expect(plan.kind).toBe("incremental");
    if (plan.kind !== "incremental") return;
    expect(plan.corrections).toEqual([]);
    expect(plan.appends).toEqual([point(2, 9)]);
  });

  it("row 2: a newly closed bucket plus a fresh forming bar, oldest first", () => {
    const plan = reconcileAreaSeries(held, [
      point(0, 1),
      point(1, 2),
      point(2, 3.5),
      point(3, 4),
    ]);
    expect(plan.kind).toBe("incremental");
    if (plan.kind !== "incremental") return;
    expect(plan.appends).toEqual([point(2, 3.5), point(3, 4)]);
  });

  it("row 6: a corrected past bar is a historical update, not an append", () => {
    const plan = reconcileAreaSeries(held, [point(0, 1), point(1, 99), point(2, 3)]);
    expect(plan.kind).toBe("incremental");
    if (plan.kind !== "incremental") return;
    expect(plan.corrections).toEqual([point(1, 99)]);
    expect(plan.appends).toEqual([point(2, 3)]);
  });

  it("row 6b: above the threshold, a full replace is cheaper", () => {
    const longHeld = Array.from({ length: 10 }, (_, i) => point(i, i));
    const corrected = longHeld.map((p, i) =>
      i < AREA_MAX_HISTORICAL_UPDATES + 1 ? point(i, i + 100) : p,
    );
    const plan = reconcileAreaSeries(longHeld, corrected);
    expect(plan).toMatchObject({ kind: "reset", reason: "many-corrections" });
  });

  it("row 5: the window sliding off the left is a replace, and says so", () => {
    const plan = reconcileAreaSeries(held, [point(1, 2), point(2, 3), point(3, 4)]);
    expect(plan).toMatchObject({ kind: "reset", reason: "left-trim" });
  });

  it("A8: a TRIM COMBINED WITH AN APPEND is still one replace", () => {
    const plan = reconcileAreaSeries(held, [point(2, 3), point(3, 4), point(4, 5)]);
    expect(plan).toMatchObject({ kind: "reset", reason: "left-trim" });
    if (plan.kind !== "reset") return;
    expect(plan.points).toHaveLength(3);
  });

  it("A8: an INTERIOR bucket disappearing is never papered over by an append", () => {
    const plan = reconcileAreaSeries(held, [point(0, 1), point(2, 3)]);
    expect(plan).toMatchObject({ kind: "reset", reason: "interior-change" });
  });

  it("row 9: a response reaching further back than the chart holds is a replace", () => {
    const plan = reconcileAreaSeries(
      [point(2, 3)],
      [point(0, 1), point(1, 2), point(2, 3)],
    );
    expect(plan).toMatchObject({ kind: "reset", reason: "shrink" });
  });

  it("row 10: an empty response keeps the last good data", () => {
    expect(reconcileAreaSeries(held, [])).toEqual({
      kind: "keep",
      reason: "empty-response",
    });
  });

  it("seeds an empty chart with a plain replace", () => {
    expect(reconcileAreaSeries([], held)).toMatchObject({ kind: "reset", reason: "seed" });
  });

  it("treats a value that became whitespace as a correction, not a no-op", () => {
    const plan = reconcileAreaSeries(held, [point(0, 1), point(1, null), point(2, 3)]);
    expect(plan.kind).toBe("incremental");
    if (plan.kind !== "incremental") return;
    expect(plan.corrections).toEqual([point(1, null)]);
  });
});

describe("AreaFeed", () => {
  function sink() {
    const setData = vi.fn();
    const update = vi.fn();
    return { setData, update };
  }

  it("answers the two facts the trim condition needs", () => {
    const feed = new AreaFeed(sink());
    expect(feed.oldestTimeSec).toBeNull();
    expect(feed.heldCount).toBe(0);
    feed.reset([point(0, 1), point(1, 2)]);
    expect(feed.oldestTimeSec).toBe(Math.floor(BASE / 1000));
    expect(feed.newestTimeSec).toBe(Math.floor((BASE + MINUTE) / 1000));
    expect(feed.heldCount).toBe(2);
  });

  it("applies corrections with the historical flag and appends without it", () => {
    const series = sink();
    const feed = new AreaFeed(series);
    feed.reset([point(0, 1), point(1, 2), point(2, 3)]);
    series.update.mockClear();

    feed.apply(
      reconcileAreaSeries(feed.held, [point(0, 1), point(1, 99), point(2, 4)]),
    );
    expect(series.update).toHaveBeenNthCalledWith(1, point(1, 99), true);
    expect(series.update).toHaveBeenNthCalledWith(2, point(2, 4));
    // And the feed now HOLDS what it wrote, so the next poll compares against
    // the truth rather than against the seed.
    expect(feed.held).toEqual([point(0, 1), point(1, 99), point(2, 4)]);
  });

  it("writes nothing at all for a keep", () => {
    const series = sink();
    const feed = new AreaFeed(series);
    feed.reset([point(0, 1)]);
    series.setData.mockClear();
    series.update.mockClear();
    const written = feed.apply(reconcileAreaSeries(feed.held, []));
    expect(series.setData).not.toHaveBeenCalled();
    expect(series.update).not.toHaveBeenCalled();
    expect(written).toEqual({ reset: false, corrected: 0, appended: 0 });
  });

  it("never calls update for a time it does not already hold", () => {
    const series = sink();
    const feed = new AreaFeed(series);
    feed.reset([point(1, 2), point(2, 3)]);
    series.update.mockClear();
    series.setData.mockClear();
    // A response that reaches back before the held window takes the replace
    // path, so `historicalUpdate` is never asked about a time that would
    // make the library throw.
    feed.apply(reconcileAreaSeries(feed.held, [point(0, 1), point(1, 2), point(2, 3)]));
    expect(series.update).not.toHaveBeenCalled();
    expect(series.setData).toHaveBeenCalledTimes(1);
  });
});
