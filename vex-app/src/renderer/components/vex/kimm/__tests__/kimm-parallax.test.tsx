/**
 * The lock screen's depth (`kimm-parallax.ts`, `use-kimm-parallax.ts`; owner decision 2026-11-15).
 *
 * Regressions this catches:
 *   - a layer shifting more than its bleed (an edge would show), or with the pointer instead of against it;
 *   - the far field moving as much as her figure (no depth);
 *   - an easing that jumps, overshoots or never settles;
 *   - shifts written while inactive, left behind when it stops, or not sent home when the pointer leaves the window.
 */

import { act, cleanup, render } from "@testing-library/react";
import { useRef, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIMM_LIVE_BLEED } from "../kimm-fit.js";
import {
  easeParallax,
  KIMM_PARALLAX,
  KIMM_PARALLAX_HOME,
  parallaxSettled,
  parallaxShift,
  parallaxTarget,
} from "../kimm-parallax.js";
import { parallaxVariable, useKimmParallax } from "../use-kimm-parallax.js";

describe("the depth's model", () => {
  it("reads the pointer from the window's centre, clamped to -1 and 1", () => {
    expect(parallaxTarget(720, 450, 1440, 900)).toEqual({ x: 0, y: 0 });
    expect(parallaxTarget(1440, 0, 1440, 900)).toEqual({ x: 1, y: -1 });
    expect(parallaxTarget(-500, 5000, 1440, 900)).toEqual({ x: -1, y: 1 });
  });

  it("shifts each layer against the pointer, the nearer the more, never past its bleed", () => {
    const edge = { x: 1, y: 1 };
    const field = parallaxShift(edge, "field");
    const motes = parallaxShift(edge, "motes");
    const figure = parallaxShift(edge, "figure");
    expect(field.x).toBeLessThan(0);
    expect(Math.abs(field.x)).toBeLessThan(Math.abs(motes.x));
    expect(Math.abs(motes.x)).toBeLessThan(Math.abs(figure.x));
    expect(Math.abs(figure.x)).toBeLessThan(KIMM_LIVE_BLEED);
    expect(Math.abs(field.x)).toBeLessThan(8);
    expect(figure.y).toBeCloseTo(-KIMM_PARALLAX.figure * KIMM_PARALLAX.yShare, 9);
  });

  it("eases without a jump or an overshoot, and settles", () => {
    let point = KIMM_PARALLAX_HOME;
    const target = { x: 1, y: -1 };
    let steps = 0;
    while (!parallaxSettled(point, target)) {
      const next = easeParallax(point, target, 1000 / 30);
      expect(next.x).toBeGreaterThan(point.x);
      expect(next.x).toBeLessThanOrEqual(1);
      expect(next.x - point.x).toBeLessThan(0.12);
      point = next;
      steps += 1;
      expect(steps).toBeLessThan(200);
    }
    // a stalled window: one long step lands on the target, never past it
    expect(easeParallax(KIMM_PARALLAX_HOME, target, 60_000).x).toBeLessThanOrEqual(1);
  });
});

function Panel({ active }: { readonly active: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useKimmParallax(ref, active);
  return <div ref={ref} data-testid="panel" />;
}

describe("useKimmParallax", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const shift = (el: HTMLElement, layer: "field" | "motes" | "figure") =>
    el.style.getPropertyValue(parallaxVariable(layer));

  it("writes nothing while inactive", () => {
    const view = render(<Panel active={false} />);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 0 }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(shift(view.getByTestId("panel"), "figure")).toBe("");
  });

  it("eases each layer toward the pointer's shift, sends it home when the pointer leaves, and cleans up", () => {
    const view = render(<Panel active />);
    const panel = view.getByTestId("panel");
    expect(shift(panel, "figure")).toBe("0.00px, 0.00px");
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: window.innerHeight / 2 }));
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const early = Number.parseFloat(shift(panel, "figure"));
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(KIMM_PARALLAX.figure);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(Number.parseFloat(shift(panel, "figure"))).toBeCloseTo(KIMM_PARALLAX.figure, 1);
    expect(shift(panel, "figure").endsWith(", 0.00px")).toBe(true);
    expect(Number.parseFloat(shift(panel, "field"))).toBeCloseTo(KIMM_PARALLAX.field, 1);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerout", { relatedTarget: null }));
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(Math.abs(Number.parseFloat(shift(panel, "figure")))).toBeLessThan(0.05);
    view.rerender(<Panel active={false} />);
    expect(shift(panel, "figure")).toBe("");
  });
});
