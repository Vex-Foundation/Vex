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

  it("reduced motion settles in the same commit instead of waiting for a fade that is not playing", async () => {
    // base.css clamps the 150ms fade to 0.01ms under this preference, so the
    // timer would be a wait for nothing: the rail took 150ms to appear behind
    // an already-finished fade. The instant path is what "degrades to an
    // instant state change" means for a JS-owned half of a CSS pair.
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      // `lib/motion/reduced-motion.ts` keeps ONE MediaQueryList for the window,
      // so the stub above only reaches a module graph that has not read the
      // preference yet - hence the reset and the dynamic import.
      vi.resetModules();
      const { useCollapseChoreography: hook } = await import(
        "../useCollapseChoreography.js"
      );
      const { result, rerender } = renderHook(
        ({ collapsed }) => hook(collapsed, 280),
        { initialProps: { collapsed: false } },
      );

      rerender({ collapsed: true });
      // No timer advance: the rail is already there, and nothing is fading.
      expect(result.current).toMatchObject({ wide: false, fading: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
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
