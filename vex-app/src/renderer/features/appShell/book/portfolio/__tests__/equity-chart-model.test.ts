/**
 * The wallet total chart's geometry (`equity-chart-model.ts`; H3-DESKTOP.md
 * section 4.1 item 12).
 *
 * Pins:
 *   - the line joins COMPLETE cycles only, oldest first; a partial cycle is a
 *     mark at its own value, off the line, never dropped; no line with fewer
 *     than two complete cycles;
 *   - the time axis spans the whole range ending at the newest cycle (a short
 *     history starts in from the left), "all" spans its own points;
 *   - the value axis covers every point with round ticks, and a flat history
 *     gets a band rather than a divide by zero;
 *   - nothing drawable (empty, unreadable) is null, for the caller to word.
 */

import { describe, expect, it } from "vitest";
import type { PortfolioHistoryPointDto } from "@shared/schemas/portfolio-history.js";
import { equityChartModel, niceStep, timeLabel, valueTicks } from "../equity-chart-model.js";

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 3, 14, 26, 0);

function point(daysAgo: number, totalUsd: number, partial = false): PortfolioHistoryPointDto {
  return {
    at: new Date(END - daysAgo * DAY).toISOString(),
    totalUsd,
    settledUsd: totalUsd,
    inTransitUsd: 0,
    partial,
  };
}

describe("equityChartModel", () => {
  it("is null for nothing drawable", () => {
    expect(equityChartModel([], "30d")).toBeNull();
    expect(
      equityChartModel([{ ...point(0, 1), at: "not a time" }], "30d"),
    ).toBeNull();
  });

  it("joins complete cycles in time order and keeps a partial one off the line", () => {
    const model = equityChartModel(
      [point(2, 1000), point(0, 1200), point(1, 900, true), point(3, 1100)],
      "7d",
    );
    if (model === null) throw new Error("no model");
    expect(model.complete.map((p) => p.totalUsd)).toEqual([1100, 1000, 1200]);
    expect(model.partial.map((p) => p.totalUsd)).toEqual([900]);
    // Three vertices: one move and two lines, the partial cycle in none.
    expect(model.line?.match(/[ML]/g)).toEqual(["M", "L", "L"]);
    expect(model.area?.endsWith("Z")).toBe(true);
  });

  it("draws no line with one complete cycle, and none with partial cycles alone", () => {
    const lone = equityChartModel([point(0, 1000)], "24h");
    expect(lone?.line).toBeNull();
    expect(lone?.complete).toHaveLength(1);

    const partialOnly = equityChartModel([point(1, 900, true), point(0, 950, true)], "7d");
    expect(partialOnly?.line).toBeNull();
    expect(partialOnly?.partial).toHaveLength(2);
  });

  it("spans a fixed range ending at the newest cycle, so a short history starts in from the left", () => {
    const model = equityChartModel([point(3, 1000), point(0, 1100)], "30d");
    if (model === null) throw new Error("no model");
    expect(model.to).toBe(END);
    expect(model.from).toBe(END - 30 * DAY);
    // Three days of thirty: the first cycle sits 27/30 of the way across.
    expect(model.complete[0]?.x).toBeCloseTo(27 / 30, 6);
    expect(model.complete[1]?.x).toBe(1);
  });

  it("spans its own points for All", () => {
    const model = equityChartModel([point(40, 1000), point(0, 1100)], "all");
    expect(model?.from).toBe(END - 40 * DAY);
    expect(model?.complete[0]?.x).toBe(0);
  });

  it("covers every point, partial ones too, inside the value axis", () => {
    const model = equityChartModel([point(2, 2900), point(1, 2650, true), point(0, 2912.75)], "7d");
    if (model === null) throw new Error("no model");
    for (const placed of [...model.complete, ...model.partial]) {
      expect(placed.y).toBeGreaterThanOrEqual(0);
      expect(placed.y).toBeLessThanOrEqual(1);
    }
    expect(model.yTicks[0]?.at).toBe(0);
    expect(model.yTicks[model.yTicks.length - 1]?.at).toBeCloseTo(1, 9);
  });

  it("labels five times across the range, a clock for a day and a date beyond", () => {
    const day = equityChartModel([point(1, 1), point(0, 2)], "24h");
    expect(day?.xTicks).toHaveLength(5);
    expect(day?.xTicks[0]?.label).toMatch(/^\d{2}:\d{2}$/);
    const month = equityChartModel([point(1, 1), point(0, 2)], "30d");
    expect(month?.xTicks[4]?.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe("the value axis", () => {
  it("steps by 1, 2, 2.5 or 5 times a power of ten", () => {
    expect(niceStep(130)).toBe(200);
    expect(niceStep(0.23)).toBe(0.25);
    expect(niceStep(40)).toBe(50);
    expect(niceStep(0)).toBe(1);
  });

  it("bands a flat history instead of dividing by zero", () => {
    const flat = valueTicks(500, 500);
    expect(flat.high).toBeGreaterThan(flat.low);
    expect(flat.low).toBeLessThanOrEqual(500);
    expect(flat.high).toBeGreaterThanOrEqual(500);
  });
});

describe("timeLabel", () => {
  it("is a month and year past ten months", () => {
    expect(timeLabel(Date.UTC(2026, 0, 15, 12), 400 * DAY)).toMatch(/^Jan 2026$/);
  });
});
