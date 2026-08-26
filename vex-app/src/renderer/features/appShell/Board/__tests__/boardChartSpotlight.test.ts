/**
 * THE SPOTLIGHT ADAPTER: candles plus volume, the per-bar colours, and the
 * reconciliation table.
 *
 * Every row of SPOTLIGHT-CHART-CONTRACT 2.2 is a claim about one pure
 * function, which is why the function is pure: the alternative is asserting
 * these against a canvas, where a wrong branch shows up as a reader's
 * viewport jumping rather than as a red test.
 *
 * THE COMPARISON IS OVER TIMESTAMP SETS and over ALL FIVE FIELDS. The area
 * line compared one value per time; a candle sibling that did the same would
 * drop a poll that only moved the high as "unchanged" (brief D7). That row is
 * here by name.
 *
 * THE COLOURS ARE DECIDED HERE, not on the canvas (brief D3, D6): the volume
 * tint, the forming-bar tint and the whitespace-for-null-volume rule are all
 * table rows below.
 */

import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it, vi } from "vitest";
import {
  SPOTLIGHT_FORMING_ALPHA,
  SPOTLIGHT_MAX_HISTORICAL_UPDATES,
  SPOTLIGHT_VOLUME_ALPHA,
  SpotlightFeed,
  isDrawnSpotlightBar,
  normalizeSpotlightBars,
  reconcileSpotlightBars,
  styleSpotlightBar,
  toSpotlightBar,
  type SpotlightBarStyle,
  type SpotlightChartBar,
} from "../boardChartFeed.js";

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 7, 26, 11, 0, 0);

const UP = "rgb(31, 185, 84)";
const DOWN = "rgb(242, 109, 109)";
const STYLE: SpotlightBarStyle = { up: UP, down: DOWN, lastBarPartial: false };
const FORMING: SpotlightBarStyle = { ...STYLE, lastBarPartial: true };

function row(
  minute: number,
  legs: { o?: string | null; h?: string | null; l?: string | null; c?: string | null } = {},
) {
  return {
    tMs: BASE + minute * MINUTE,
    o: legs.o === undefined ? "1.0" : legs.o,
    h: legs.h === undefined ? "1.2" : legs.h,
    l: legs.l === undefined ? "0.9" : legs.l,
    c: legs.c === undefined ? "1.1" : legs.c,
  };
}

function sec(minute: number): UTCTimestamp {
  return Math.floor((BASE + minute * MINUTE) / 1000) as UTCTimestamp;
}

/** A drawn bar with every field named, so a case reads as its own fixture. */
function bar(
  minute: number,
  fields: Partial<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }> = {},
): SpotlightChartBar {
  const volume = fields.volume === undefined ? 10 : fields.volume;
  return {
    time: sec(minute),
    open: fields.open ?? 1,
    high: fields.high ?? 1.2,
    low: fields.low ?? 0.9,
    close: fields.close ?? 1.1,
    volume,
    volumeUsd: volume === null ? null : String(volume),
    incoherent: false,
  };
}

function whitespace(minute: number): SpotlightChartBar {
  return { time: sec(minute) };
}

/* ------------------------------------------------------------------ */

describe("toSpotlightBar", () => {
  it("floors the instant to one second and keeps the volume as float AND text", () => {
    const converted = toSpotlightBar(row(0), "1234.5");
    expect(isDrawnSpotlightBar(converted)).toBe(true);
    if (!isDrawnSpotlightBar(converted)) return;
    expect(converted.time).toBe(sec(0));
    expect(converted).toMatchObject({ open: 1, high: 1.2, low: 0.9, close: 1.1 });
    expect(converted.volume).toBe(1234.5);
    expect(converted.volumeUsd).toBe("1234.5");
  });

  it("draws the candle and leaves the volume null when none was reported", () => {
    const converted = toSpotlightBar(row(0), null);
    expect(isDrawnSpotlightBar(converted)).toBe(true);
    if (!isDrawnSpotlightBar(converted)) return;
    expect(converted.volume).toBeNull();
    expect(converted.volumeUsd).toBeNull();
  });

  it("refuses a volume that is not a finite decimal, and keeps the candle", () => {
    const converted = toSpotlightBar(row(0), "1e5");
    if (!isDrawnSpotlightBar(converted)) throw new Error("expected a drawn bar");
    expect(converted.volume).toBeNull();
    expect(converted.volumeUsd).toBeNull();
  });

  it("makes a bucket with a missing leg into whitespace, never a zero, volume or not", () => {
    const converted = toSpotlightBar(row(1, { c: null }), "5");
    expect(isDrawnSpotlightBar(converted)).toBe(false);
    expect(converted).toEqual({ time: sec(1) });
  });

  it("spans the drawn extremes over all four legs and says so", () => {
    // A close above the reported high: measured provider behaviour.
    const converted = toSpotlightBar(row(2, { h: "1.05", c: "1.3" }), "1");
    if (!isDrawnSpotlightBar(converted)) throw new Error("expected a drawn bar");
    expect(converted.high).toBe(1.3);
    expect(converted.incoherent).toBe(true);
  });
});

describe("normalizeSpotlightBars", () => {
  it("sorts, deduplicates last-write-wins, and reports every count", () => {
    const normalized = normalizeSpotlightBars(
      [row(2), row(0, { h: "0.95" }), row(2, { c: "1.15" }), row(1, { o: null })],
      ["3", "1", "4", "2"],
    );
    expect(normalized.bars.map((b) => b.time)).toEqual([sec(0), sec(1), sec(2)]);
    const last = normalized.bars[2];
    if (last === undefined || !isDrawnSpotlightBar(last)) throw new Error("expected drawn");
    expect(last.close).toBe(1.15);
    expect(last.volume).toBe(4);
    expect(normalized.totalDistinct).toBe(3);
    expect(normalized.hiddenOlder).toBe(0);
    expect(normalized.whitespaceCount).toBe(1);
    expect(normalized.incoherentCount).toBe(1);
    expect(normalized.volumelessCount).toBe(0);
    expect(normalized.oldestTimeSec).toBe(sec(0));
    expect(normalized.newestTimeSec).toBe(sec(2));
  });

  it("counts a null or missing volume as volumeless on a DRAWN bar only", () => {
    const normalized = normalizeSpotlightBars(
      [row(0), row(1), row(2, { c: null })],
      ["1", null],
    );
    // Row 1 has null, row 2 has no entry at all AND is whitespace: only the
    // drawn one counts.
    expect(normalized.volumelessCount).toBe(1);
    expect(normalized.whitespaceCount).toBe(1);
  });
});

describe("styleSpotlightBar - the colours are a table", () => {
  it("tints the volume column by the candle's direction at the volume alpha", () => {
    const up = styleSpotlightBar(bar(0, { open: 1, close: 1.1 }), false, STYLE);
    const down = styleSpotlightBar(bar(0, { open: 1.1, close: 1 }), false, STYLE);
    expect(up.volume).toEqual({
      time: sec(0),
      value: 10,
      color: `rgba(31, 185, 84, ${String(SPOTLIGHT_VOLUME_ALPHA)})`,
    });
    expect(down.volume).toEqual({
      time: sec(0),
      value: 10,
      color: `rgba(242, 109, 109, ${String(SPOTLIGHT_VOLUME_ALPHA)})`,
    });
    // A flat bar is an up bar (close >= open), never a third colour.
    const flat = styleSpotlightBar(bar(0, { open: 1, close: 1 }), false, STYLE);
    expect("color" in flat.volume && flat.volume.color?.startsWith("rgba(31,")).toBe(true);
  });

  it("leaves the histogram slot as WHITESPACE for a null volume, never a zero column", () => {
    const styled = styleSpotlightBar(bar(0, { volume: null }), false, STYLE);
    expect(styled.volume).toEqual({ time: sec(0) });
    expect("value" in styled.volume).toBe(false);
    // The candle still draws.
    expect("open" in styled.candle).toBe(true);
  });

  it("draws a settled bar with NO per-item colour, so the series options own it", () => {
    const styled = styleSpotlightBar(bar(0), false, STYLE);
    expect(styled.candle).toEqual({
      time: sec(0),
      open: 1,
      high: 1.2,
      low: 0.9,
      close: 1.1,
    });
  });

  it("tints the newest bar on body, border and wick while its bucket is forming", () => {
    const styled = styleSpotlightBar(bar(0, { open: 1.1, close: 1 }), true, FORMING);
    const tint = `rgba(242, 109, 109, ${String(SPOTLIGHT_FORMING_ALPHA)})`;
    expect(styled.candle).toMatchObject({
      color: tint,
      borderColor: tint,
      wickColor: tint,
    });
    // Never hidden, never whitespace: the four legs are still there.
    expect(styled.candle).toMatchObject({ open: 1.1, close: 1 });
  });

  it("does NOT tint the newest bar once its bucket has closed, nor any older bar while forming", () => {
    const closed = styleSpotlightBar(bar(0), true, STYLE);
    expect("color" in closed.candle).toBe(false);
    const older = styleSpotlightBar(bar(0), false, FORMING);
    expect("color" in older.candle).toBe(false);
  });

  it("maps a whitespace bar to whitespace in BOTH series", () => {
    const styled = styleSpotlightBar(whitespace(3), true, FORMING);
    expect(styled.candle).toEqual({ time: sec(3) });
    expect(styled.volume).toEqual({ time: sec(3) });
  });
});

describe("reconcileSpotlightBars - the table", () => {
  const held = [bar(0), bar(1), bar(2), bar(3)];

  it("keeps everything on an empty response (row 10)", () => {
    expect(reconcileSpotlightBars(held, [])).toEqual({
      kind: "keep",
      reason: "empty-response",
    });
  });

  it("seeds an empty feed with a full write", () => {
    expect(reconcileSpotlightBars([], held)).toEqual({
      kind: "reset",
      reason: "seed",
      bars: held,
    });
  });

  it("re-writes the SAME forming bar as an update, never a correction (row 1)", () => {
    const moved = bar(3, { close: 1.19, high: 1.25, volume: 12 });
    const plan = reconcileSpotlightBars(held, [bar(0), bar(1), bar(2), moved]);
    expect(plan).toEqual({ kind: "incremental", corrections: [], appends: [moved] });
  });

  it("appends a newly closed bucket AND the fresh forming bar, oldest first (row 2)", () => {
    const closed = bar(3, { close: 1.15 });
    const forming = bar(4, { open: 1.15, close: 1.16 });
    const plan = reconcileSpotlightBars(held, [bar(0), bar(1), bar(2), closed, forming]);
    expect(plan).toEqual({
      kind: "incremental",
      corrections: [],
      appends: [closed, forming],
    });
  });

  it("treats a past bar whose HIGH alone moved as a correction (brief D7)", () => {
    // The single-value comparison of the area line would have called this
    // unchanged and left the wick short.
    const corrected = bar(1, { high: 1.4 });
    const plan = reconcileSpotlightBars(held, [bar(0), corrected, bar(2), bar(3)]);
    expect(plan).toEqual({
      kind: "incremental",
      corrections: [corrected],
      appends: [bar(3)],
    });
  });

  it.each([
    ["open", { open: 0.95 }],
    ["low", { low: 0.85 }],
    ["close", { close: 1.12 }],
    ["volume", { volume: 11 }],
  ] as const)("treats a past bar whose %s alone moved as a correction", (_leg, change) => {
    const corrected = bar(1, change);
    const plan = reconcileSpotlightBars(held, [bar(0), corrected, bar(2), bar(3)]);
    expect(plan.kind).toBe("incremental");
    if (plan.kind === "incremental") expect(plan.corrections).toEqual([corrected]);
  });

  it("treats a past bar that became whitespace, or stopped being, as a correction", () => {
    const plan = reconcileSpotlightBars(held, [bar(0), whitespace(1), bar(2), bar(3)]);
    expect(plan.kind).toBe("incremental");
    if (plan.kind === "incremental") expect(plan.corrections).toEqual([whitespace(1)]);
    const back = reconcileSpotlightBars(
      [bar(0), whitespace(1), bar(2), bar(3)],
      [bar(0), bar(1), bar(2), bar(3)],
    );
    expect(back.kind).toBe("incremental");
    if (back.kind === "incremental") expect(back.corrections).toEqual([bar(1)]);
  });

  it("does a full replace when the window slid left (row 5), even with an append", () => {
    const plan = reconcileSpotlightBars(held, [bar(1), bar(2), bar(3), bar(4)]);
    expect(plan.kind).toBe("reset");
    if (plan.kind === "reset") expect(plan.reason).toBe("left-trim");
  });

  it("does a full replace when an interior bar vanished", () => {
    const plan = reconcileSpotlightBars(held, [bar(0), bar(2), bar(3)]);
    expect(plan).toMatchObject({ kind: "reset", reason: "interior-change" });
  });

  it("does a full replace when the response reaches further back than the chart", () => {
    const plan = reconcileSpotlightBars(held, [bar(-1), bar(0), bar(1), bar(2), bar(3)]);
    expect(plan).toMatchObject({ kind: "reset", reason: "shrink" });
  });

  it("does a full replace above the historical-update budget (row 6b)", () => {
    const many = [bar(0), bar(1), bar(2), bar(3), bar(4), bar(5)];
    const corrected = many.map((b, i) =>
      i < SPOTLIGHT_MAX_HISTORICAL_UPDATES + 1 ? bar(i, { close: 2 }) : b,
    );
    const plan = reconcileSpotlightBars(many, corrected);
    expect(plan).toMatchObject({ kind: "reset", reason: "many-corrections" });
  });
});

describe("SpotlightFeed - one writer, two series", () => {
  function sinks() {
    const candle = { setData: vi.fn(), update: vi.fn() };
    const volume = { setData: vi.fn(), update: vi.fn() };
    return { candle, volume };
  }

  it("seeds both series with styled points and tints only the forming newest bar", () => {
    const s = sinks();
    const feed = new SpotlightFeed(s);
    feed.reset([bar(0), bar(1, { volume: null }), bar(2)], FORMING);
    expect(s.candle.setData).toHaveBeenCalledTimes(1);
    expect(s.volume.setData).toHaveBeenCalledTimes(1);
    const candles = s.candle.setData.mock.calls[0]?.[0] as Record<string, unknown>[];
    const volumes = s.volume.setData.mock.calls[0]?.[0] as Record<string, unknown>[];
    expect(candles.map((c) => "color" in c)).toEqual([false, false, true]);
    expect(volumes.map((v) => "value" in v)).toEqual([true, false, true]);
    expect(feed.heldCount).toBe(3);
    expect(feed.oldestTimeSec).toBe(sec(0));
    expect(feed.newestTimeSec).toBe(sec(2));
  });

  it("applies corrections with historicalUpdate on BOTH series, then appends", () => {
    const s = sinks();
    const feed = new SpotlightFeed(s);
    feed.reset([bar(0), bar(1), bar(2)], FORMING);
    const plan = reconcileSpotlightBars(feed.held, [
      bar(0),
      bar(1, { high: 1.5 }),
      bar(2, { close: 1.18 }),
    ]);
    const applied = feed.apply(plan, FORMING);
    expect(applied).toEqual({ reset: false, corrected: 1, appended: 1 });
    expect(s.candle.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ high: 1.5 }), true);
    expect(s.volume.update).toHaveBeenNthCalledWith(1, expect.objectContaining({ time: sec(1) }), true);
    expect(s.candle.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ close: 1.18 }));
    expect(s.volume.update).toHaveBeenNthCalledWith(2, expect.objectContaining({ time: sec(2) }));
  });

  it("settles the previously forming bar's colour on the poll that closes it", () => {
    const s = sinks();
    const feed = new SpotlightFeed(s);
    feed.reset([bar(0), bar(1)], FORMING);
    const plan = reconcileSpotlightBars(feed.held, [bar(0), bar(1, { close: 1.15 }), bar(2)]);
    feed.apply(plan, FORMING);
    const written = s.candle.update.mock.calls.map((call) => call[0] as Record<string, unknown>);
    // Bar 1 re-written WITHOUT a tint (it closed), bar 2 WITH one (forming).
    expect(written.map((c) => "color" in c)).toEqual([false, true]);
    expect(feed.heldCount).toBe(3);
  });

  it("re-writes the held bars re-tinted on a restyle, without changing what is held", () => {
    const s = sinks();
    const feed = new SpotlightFeed(s);
    feed.reset([bar(0), bar(1)], FORMING);
    const before = feed.held;
    feed.restyle({ up: "rgb(1, 2, 3)", down: DOWN, lastBarPartial: true });
    expect(s.volume.setData).toHaveBeenCalledTimes(2);
    const volumes = s.volume.setData.mock.calls[1]?.[0] as Record<string, unknown>[];
    expect(volumes[0]?.color).toBe(`rgba(1, 2, 3, ${String(SPOTLIGHT_VOLUME_ALPHA)})`);
    expect(feed.held).toBe(before);
  });

  it("writes nothing on an empty restyle and nothing on a keep", () => {
    const s = sinks();
    const feed = new SpotlightFeed(s);
    feed.restyle(STYLE);
    expect(feed.apply({ kind: "keep", reason: "empty-response" }, STYLE)).toEqual({
      reset: false,
      corrected: 0,
      appended: 0,
    });
    expect(s.candle.setData).not.toHaveBeenCalled();
    expect(s.volume.setData).not.toHaveBeenCalled();
  });
});
