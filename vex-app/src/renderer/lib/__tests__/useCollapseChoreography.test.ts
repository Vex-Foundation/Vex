import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSE_SETTLE_MS,
  useCollapseChoreography,
} from "../useCollapseChoreography.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useCollapseChoreography", () => {
  it("a live collapse fades first, then settles into the rail with the entry armed", () => {
    const { result, rerender } = renderHook(
      ({ collapsed }) => useCollapseChoreography(collapsed, 280),
      { initialProps: { collapsed: false } },
    );
    expect(result.current).toMatchObject({ wide: true, fading: false, railIn: false });

    rerender({ collapsed: true });
    // Phase 1 (0-150ms): wide layout frozen and fading in place.
    expect(result.current).toMatchObject({ wide: true, fading: true, railIn: false });

    act(() => vi.advanceTimersByTime(COLLAPSE_SETTLE_MS));
    // Phase 2: rail layout with the rail-in entry (this WAS a live collapse).
    expect(result.current).toMatchObject({ wide: false, fading: false, railIn: true });
  });

  it("one millisecond before settle the wide layout still stands", () => {
    const { result, rerender } = renderHook(
      ({ collapsed }) => useCollapseChoreography(collapsed, 280),
      { initialProps: { collapsed: false } },
    );
    rerender({ collapsed: true });
    act(() => vi.advanceTimersByTime(COLLAPSE_SETTLE_MS - 1));
    expect(result.current.wide).toBe(true);
  });

  it("a cold-collapsed mount renders the rail statically (no rail-in replay)", () => {
    const { result } = renderHook(() => useCollapseChoreography(true, 280));
    expect(result.current).toMatchObject({ wide: false, fading: false, railIn: false });
  });

  it("freezes the last expanded width for the fade, ignoring rail-time width", () => {
    const { result, rerender } = renderHook(
      ({ collapsed, width }) => useCollapseChoreography(collapsed, width),
      { initialProps: { collapsed: false, width: 342 } },
    );
    rerender({ collapsed: true, width: 56 });
    // Mid-fade the content holds the 342px it had while expanded.
    expect(result.current.frozenWidth).toBe(342);
  });

  it("expanding remounts wide content immediately and disarms the rail entry", () => {
    const { result, rerender } = renderHook(
      ({ collapsed }) => useCollapseChoreography(collapsed, 280),
      { initialProps: { collapsed: true } },
    );
    rerender({ collapsed: false });
    expect(result.current).toMatchObject({ wide: true, fading: false, railIn: false });
  });
});
