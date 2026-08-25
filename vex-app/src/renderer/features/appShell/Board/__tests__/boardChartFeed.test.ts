/**
 * BOARD CHART ADAPTER - the validation lightweight-charts does NOT do for us.
 *
 * Measured against the installed 5.2.1: the ordering and value assertions are
 * stripped from `dist/lightweight-charts.production.mjs` (`grep -c` = 0 for
 * "data must be asc ordered by time"), while the `Cannot update oldest data`
 * throw survives (`grep -c` = 1). So these tests protect the exact properties
 * the shipped bundle will not: ascending order, uniqueness, finiteness, the
 * ms-to-seconds conversion, and the stale guard that keeps the one surviving
 * throw unreachable.
 *
 * The feed is driven against a recording fake series that implements the real
 * `setData`/`update` contract. Nothing here renders a canvas.
 */

import { describe, expect, it } from "vitest";
import type {
  CandlestickData,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import {
  BOARD_CHART_MAX_BARS,
  CandleFeed,
  barsToPush,
  boardChartSubjectKey,
  formatChartAxisPrice,
  normalizeBoardBars,
  toChartBar,
  toDisplayPrice,
  toDisplayTimeSec,
  type BoardCandleInput,
  type BoardChartBar,
} from "../boardChartFeed.js";

function bar(
  tMs: number,
  close: string | null = "1",
): BoardCandleInput {
  return { tMs, o: close, h: close, l: close, c: close };
}

/** Records what the feed wrote, and enforces the library's real update law. */
function fakeSeries(): {
  readonly api: ISeriesApi<"Candlestick", Time>;
  readonly calls: { kind: "setData" | "update"; times: number[] }[];
} {
  const calls: { kind: "setData" | "update"; times: number[] }[] = [];
  let lastTime: number | null = null;
  const api = {
    setData(data: CandlestickData<Time>[]): void {
      calls.push({ kind: "setData", times: data.map((d) => d.time as number) });
      const newest = data.at(-1);
      lastTime = newest === undefined ? null : (newest.time as number);
    },
    update(item: CandlestickData<Time>): void {
      const time = item.time as number;
      // The library's own production throw, reproduced exactly.
      if (lastTime !== null && time < lastTime) {
        throw new Error(
          `Cannot update oldest data, last time=${lastTime}, new time=${time}`,
        );
      }
      calls.push({ kind: "update", times: [time] });
      lastTime = time;
    },
  } as unknown as ISeriesApi<"Candlestick", Time>;
  return { api, calls };
}

describe("toChartBar", () => {
  it("converts epoch milliseconds to SECONDS exactly once", () => {
    const converted = toChartBar(bar(1_783_172_700_000, "0.5"));
    expect(converted.time).toBe(1_783_172_700);
  });

  it("floors a sub-second remainder rather than rounding it up", () => {
    expect(toChartBar(bar(1_000_999)).time).toBe(1_000);
  });

  it("turns a null-priced row into whitespace, not a fabricated zero", () => {
    const converted = toChartBar({ tMs: 5_000, o: null, h: "1", l: "1", c: "1" });
    expect(converted).toStrictEqual({ time: 5 });
    expect("open" in converted).toBe(false);
  });

  it("turns a non-numeric price into whitespace instead of NaN", () => {
    const converted = toChartBar(bar(5_000, "not-a-price"));
    expect("open" in converted).toBe(false);
  });

  it("preserves a sub-cent price down to 1e-13", () => {
    const converted = toChartBar(bar(5_000, "0.0000000000001234"));
    expect((converted as CandlestickData<UTCTimestamp>).close).toBeCloseTo(
      1.234e-13,
      20,
    );
  });
});

describe("normalizeBoardBars", () => {
  it("sorts ascending regardless of input order", () => {
    const { bars } = normalizeBoardBars([bar(3_000), bar(1_000), bar(2_000)]);
    expect(bars.map((b) => b.time)).toStrictEqual([1, 2, 3]);
  });

  it("dedupes a repeated timestamp keeping the LAST value (the forming bar)", () => {
    const { bars, totalDistinct } = normalizeBoardBars([
      bar(1_000, "1"),
      bar(1_000, "2"),
    ]);
    expect(totalDistinct).toBe(1);
    expect((bars[0] as CandlestickData<UTCTimestamp>).close).toBe(2);
  });

  it("produces STRICTLY ascending times, the contract setData requires", () => {
    const { bars } = normalizeBoardBars([
      bar(2_000),
      bar(1_000),
      bar(2_000),
      bar(3_000),
    ]);
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i]!.time as number).toBeGreaterThan(bars[i - 1]!.time as number);
    }
  });

  it("keeps the NEWEST bars at the budget and reports how many were left out", () => {
    const rows = Array.from({ length: BOARD_CHART_MAX_BARS + 7 }, (_, i) =>
      bar((i + 1) * 1_000),
    );
    const result = normalizeBoardBars(rows);
    expect(result.bars).toHaveLength(BOARD_CHART_MAX_BARS);
    expect(result.hiddenOlder).toBe(7);
    expect(result.totalDistinct).toBe(BOARD_CHART_MAX_BARS + 7);
    // The newest bar survives; the oldest is the one dropped.
    expect(result.bars.at(-1)!.time).toBe((BOARD_CHART_MAX_BARS + 7) * 1_000 / 1000);
    expect(result.bars[0]!.time).toBe(8);
  });

  it("reports nothing hidden when the board is within budget", () => {
    expect(normalizeBoardBars([bar(1_000)]).hiddenOlder).toBe(0);
  });

  it("counts whitespace rows so the surface can say buckets had no price", () => {
    const result = normalizeBoardBars([bar(1_000), bar(2_000, null)]);
    expect(result.whitespaceCount).toBe(1);
  });

  it("returns an empty result for no rows", () => {
    expect(normalizeBoardBars([])).toStrictEqual({
      bars: [],
      totalDistinct: 0,
      hiddenOlder: 0,
      whitespaceCount: 0,
    });
  });
});

describe("CandleFeed", () => {
  it("reset writes the whole series once and tracks the newest time", () => {
    const { api, calls } = fakeSeries();
    const feed = new CandleFeed(api);
    feed.reset(normalizeBoardBars([bar(1_000), bar(2_000)]).bars);
    expect(calls).toStrictEqual([{ kind: "setData", times: [1, 2] }]);
    expect(feed.newestTimeSec).toBe(2);
  });

  it("reset on an empty series leaves no newest time", () => {
    const { api } = fakeSeries();
    const feed = new CandleFeed(api);
    feed.reset([]);
    expect(feed.newestTimeSec).toBeNull();
  });

  it("push at the SAME time reports an in-place update of the forming bar", () => {
    const { api, calls } = fakeSeries();
    const feed = new CandleFeed(api);
    feed.reset(normalizeBoardBars([bar(1_000)]).bars);
    expect(feed.push(toChartBar(bar(1_000, "9")))).toBe("updated");
    expect(calls.at(-1)).toStrictEqual({ kind: "update", times: [1] });
  });

  it("push at a NEWER time appends", () => {
    const { api } = fakeSeries();
    const feed = new CandleFeed(api);
    feed.reset(normalizeBoardBars([bar(1_000)]).bars);
    expect(feed.push(toChartBar(bar(2_000)))).toBe("appended");
    expect(feed.newestTimeSec).toBe(2);
  });

  it("push at an OLDER time is refused as stale and never reaches the series", () => {
    const { api, calls } = fakeSeries();
    const feed = new CandleFeed(api);
    feed.reset(normalizeBoardBars([bar(5_000)]).bars);
    const before = calls.length;
    // The fake throws exactly as the shipped library does; the guard is what
    // keeps that throw unreachable. Reverting the guard makes this red.
    expect(feed.push(toChartBar(bar(1_000)))).toBe("stale");
    expect(calls).toHaveLength(before);
    expect(feed.newestTimeSec).toBe(5);
  });

  it("drives a whole refresh cycle without the library's ordering throw", () => {
    const { api } = fakeSeries();
    const feed = new CandleFeed(api);
    feed.reset(normalizeBoardBars([bar(1_000), bar(2_000)]).bars);
    const next = normalizeBoardBars([
      bar(1_000),
      bar(2_000, "7"),
      bar(3_000),
    ]).bars;
    expect(() => {
      for (const b of barsToPush(next, feed.newestTimeSec)) feed.push(b);
    }).not.toThrow();
    expect(feed.newestTimeSec).toBe(3);
  });
});

describe("barsToPush", () => {
  it("includes the bar AT the newest held time, because it is still forming", () => {
    const bars: readonly BoardChartBar[] = normalizeBoardBars([
      bar(1_000),
      bar(2_000),
      bar(3_000),
    ]).bars;
    expect(barsToPush(bars, 2).map((b) => b.time)).toStrictEqual([2, 3]);
  });

  it("returns everything when nothing is held yet", () => {
    const bars = normalizeBoardBars([bar(1_000)]).bars;
    expect(barsToPush(bars, null)).toBe(bars);
  });
});

describe("annotation coordinate conversion", () => {
  it("accepts a plain decimal string", () => {
    expect(toDisplayPrice("0.00042")).toBeCloseTo(0.00042, 12);
  });

  it.each(["", "  ", "1e5", "0x10", "abc", "1.2.3", "Infinity"])(
    "refuses %j rather than plotting a guess",
    (input) => {
      expect(toDisplayPrice(input)).toBeNull();
    },
  );

  it("converts a marker instant from milliseconds to seconds", () => {
    expect(toDisplayTimeSec(1_783_172_700_000)).toBe(1_783_172_700);
  });

  it("refuses a non-finite instant", () => {
    expect(toDisplayTimeSec(Number.NaN)).toBeNull();
  });
});

describe("formatChartAxisPrice", () => {
  it.each([
    [1234.5, "1234.50"],
    [0.5, "0.5000"],
    [0.00042, "0.0004200"],
    // Four significant digits past the zero run: 13 leading zeros + 3.
    [1.234e-13, "0.0000000000001234"],
    [0, "0"],
  ])("formats %j as %j", (value, expected) => {
    expect(formatChartAxisPrice(value)).toBe(expected);
  });

  it("never renders a sub-cent price as the default 0.00", () => {
    expect(formatChartAxisPrice(1e-13)).not.toBe("0.00");
  });

  it("returns an empty label for a non-finite value", () => {
    expect(formatChartAxisPrice(Number.NaN)).toBe("");
  });
});

describe("boardChartSubjectKey", () => {
  it("distinguishes a resolution change on the same pool", () => {
    expect(boardChartSubjectKey("base", "0xabc", "1h")).not.toBe(
      boardChartSubjectKey("base", "0xabc", "4h"),
    );
  });

  it("distinguishes the same address on a different chain", () => {
    expect(boardChartSubjectKey("base", "0xabc", "1h")).not.toBe(
      boardChartSubjectKey("solana", "0xabc", "1h"),
    );
  });
});
