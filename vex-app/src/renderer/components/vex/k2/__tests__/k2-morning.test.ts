/**
 * The morning input (`k2-morning.ts`). Regressions this catches: a morning that starts before 06:00
 * or runs into 11:00, a review hour that takes anything but a whole hour of the day, a host that
 * reads the clock less often than every minute, a `morningNow` that does not follow the local clock,
 * and a `useMorning` that does not turn false when the morning ends while she is on screen.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isMorning,
  MORNING,
  MORNING_REFRESH_MS,
  morningNow,
  requestedHour,
  useMorning,
} from "../k2-morning.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("the morning", () => {
  test("local 06:00 to 10:59", () => {
    expect(MORNING).toEqual({ from: 6, to: 11 });
    expect(isMorning(5)).toBe(false);
    expect(isMorning(6)).toBe(true);
    expect(isMorning(8)).toBe(true);
    expect(isMorning(10)).toBe(true);
    expect(isMorning(11)).toBe(false);
    expect(isMorning(0)).toBe(false);
    expect(isMorning(23)).toBe(false);
  });

  test("?hour= stands in for the local hour (review): a whole hour of the day, else none", () => {
    expect(requestedHour("?hour=8")).toBe(8);
    expect(requestedHour("?still&hour=0")).toBe(0);
    expect(requestedHour("?hour=23")).toBe(23);
    expect(requestedHour("?hour=24")).toBeNull();
    expect(requestedHour("?hour=-1")).toBeNull();
    expect(requestedHour("?hour=8.5")).toBeNull();
    expect(requestedHour("?hour=")).toBeNull();
    expect(requestedHour("")).toBeNull();
  });

  test("the host reads it again every minute", () => {
    expect(MORNING_REFRESH_MS).toBe(60000);
  });
});

describe("the morning by the local clock", () => {
  test("morningNow follows the local time: 05:59 is not morning, 06:00 is", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 18, 5, 59, 0));
    expect(morningNow()).toBe(false);
    vi.setSystemTime(new Date(2026, 9, 18, 6, 0, 0));
    expect(morningNow()).toBe(true);
    vi.setSystemTime(new Date(2026, 9, 18, 10, 59, 59));
    expect(morningNow()).toBe(true);
    vi.setSystemTime(new Date(2026, 9, 18, 11, 0, 0));
    expect(morningNow()).toBe(false);
  });

  test("useMorning reads the clock again every minute: true at 10:59:30, false at 11:00:30", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 18, 10, 59, 30));
    const { result } = renderHook(() => useMorning());
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current).toBe(false);
  });
});
