/**
 * The lock screen's light motes (`kimm-motes.ts`, `KimmMotes.tsx`; owner decision 2026-11-15).
 *
 * Regressions this catches:
 *   - motes that leave the box for good, jump on a stalled window, or appear at full light at the box's edge;
 *   - redraws above 30 a second;
 *   - a canvas mounted where her live figure does not stand (the card, reduced motion), or drawing in a hidden window.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMotes, KIMM_MOTES, moteFrameDue, motePose, stepMotes } from "../kimm-motes.js";
import { KimmMotes } from "../KimmMotes.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A seeded generator, so the cases are the same on every run. */
function seeded(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("the motes' model", () => {
  it("spreads its motes over the box within their measures", () => {
    const motes = createMotes(seeded());
    expect(motes).toHaveLength(KIMM_MOTES.count);
    for (const m of motes) {
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(1);
      expect(m.r).toBeGreaterThanOrEqual(KIMM_MOTES.radius[0]);
      expect(m.r).toBeLessThanOrEqual(KIMM_MOTES.radius[1]);
      expect(m.alpha).toBeLessThanOrEqual(KIMM_MOTES.alpha[1]);
      expect(KIMM_MOTES.colors).toContain(m.color);
    }
  });

  it("rises slowly and comes back in at the foot", () => {
    const random = seeded();
    const motes = createMotes(random, 1);
    const first = motes[0];
    if (first === undefined) throw new Error("no mote");
    first.y = 0.5;
    const rise = first.rise;
    stepMotes(motes, 1, random);
    expect(motes[0]?.y).toBeCloseTo(0.5 - Math.min(0.1, 1) * rise, 9);
    for (let i = 0; i < 2000; i += 1) stepMotes(motes, 0.1, random);
    expect(motes[0]?.y).toBeGreaterThan(-0.05);
    expect(motes[0]?.y).toBeLessThanOrEqual(1.04);
  });

  it("clamps a stalled window's step, so nothing jumps", () => {
    const motes = createMotes(seeded(), 1);
    const before = motes[0]?.y ?? 0;
    const rise = motes[0]?.rise ?? 0;
    stepMotes(motes, 30, seeded());
    expect(before - (motes[0]?.y ?? 0)).toBeLessThanOrEqual(0.1 * rise + 1e-12);
  });

  it("fades in at the foot and out at the top, and twinkles under its peak", () => {
    const [m] = createMotes(seeded(), 1);
    if (m === undefined) throw new Error("no mote");
    m.y = 0;
    expect(motePose(m, 3, 400, 900).alpha).toBe(0);
    m.y = 1;
    expect(motePose(m, 3, 400, 900).alpha).toBe(0);
    m.y = 0.5;
    for (let t = 0; t < 20; t += 0.25) {
      const pose = motePose(m, t, 400, 900);
      expect(pose.alpha).toBeLessThanOrEqual(m.alpha + 1e-12);
      expect(pose.alpha).toBeGreaterThanOrEqual(0);
      expect(Math.abs(pose.x - m.x * 400)).toBeLessThanOrEqual(KIMM_MOTES.sway * 400 + 1e-9);
    }
  });

  it("redraws at most 30 times a second", () => {
    expect(KIMM_MOTES.fps).toBe(30);
    expect(moteFrameDue(1000, 0)).toBe(true);
    expect(moteFrameDue(1016, 1000)).toBe(false);
    expect(moteFrameDue(1033, 1000)).toBe(true);
    let drawn = 0;
    let last = 0;
    for (let now = 1; now <= 1000; now += 1000 / 120) {
      if (moteFrameDue(now, last)) {
        drawn += 1;
        last = now;
      }
    }
    expect(drawn).toBeLessThanOrEqual(31);
    expect(drawn).toBeGreaterThanOrEqual(25);
  });
});

describe("KimmMotes", () => {
  it("draws nothing at all while not active", () => {
    const view = render(<KimmMotes active={false} />);
    expect(view.container.querySelector("canvas")).toBeNull();
  });

  it("is decorative and runs while active in a shown window, stopping when it is hidden", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const view = render(<KimmMotes active />);
    const canvas = view.container.querySelector("canvas[data-vex-area='kimm-motes']");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("data-kimm-motes-running")).toBe("true");
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(canvas?.getAttribute("data-kimm-motes-running")).toBe("false");
    view.rerender(<KimmMotes active={false} />);
    expect(view.container.querySelector("canvas")).toBeNull();
  });
});
