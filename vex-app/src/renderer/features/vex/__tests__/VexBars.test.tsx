// @vitest-environment jsdom

/**
 * Vex's bars (`vex-bars.ts`, `VexBars.tsx`; docs/design/H3-DESKTOP.md
 * section 1.8; MOTION-POLICY.md "Vex's bars"; VEX Cloud's bars canvas).
 * Pinned:
 *
 *  - THE MODEL: max(12, round(W / 22)) bars, 3 apart; each white at 1.4%
 *    plus up to 55% by its level; levels ease on the spring toward their
 *    mood's goal, a step never longer than 50ms; the still frame is the goal;
 *  - THE MOOD from her state alone: busy while she thinks or works, approve
 *    while a decision waits, ready otherwise;
 *  - IT RUNS only while the canvas is on screen and the window is shown (the
 *    run gate), stops when either goes and on unmount, and resumes;
 *  - THE STILL FRAME: under reduced motion or Save-Data it paints one settled
 *    frame, again when her mood changes, and starts no loop;
 *  - the canvas is decorative, takes no pointer and its colour from the
 *    sheet.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VEX_BARS_GAP,
  VEX_BARS_STILL_S,
  VexBarsModel,
  vexBarAlpha,
  vexBarCount,
  vexBarGoal,
  vexBarsMoodOf,
} from "../vex-bars.js";
import { VEX_STATES } from "../vex-state.js";

/** Reduced motion or Save-Data, as the still-frame read answers it. */
const still = vi.hoisted(() => ({ current: false }));
vi.mock("../../../lib/motion/use-still-frame.js", () => ({
  prefersSaveData: () => false,
  prefersStillFrame: () => still.current,
  useStillFrame: () => still.current,
}));

const { VexBars } = await import("../VexBars.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const SHEET = readFileSync(
  path.join(here, "..", "..", "..", "styles", "global-css", "vex-sidebar.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the bars' model", () => {
  it("draws max(12, round(W / 22)) bars", () => {
    expect(vexBarCount(200)).toBe(12);
    expect(vexBarCount(432)).toBe(20);
    expect(vexBarCount(576)).toBe(26);
    expect(vexBarCount(768)).toBe(35);
  });

  it("paints each bar white at 1.4% plus up to 55% by its level", () => {
    expect(vexBarAlpha(0)).toBeCloseTo(0.014);
    expect(vexBarAlpha(1)).toBeCloseTo(0.564);
    expect(vexBarAlpha(-1)).toBeCloseTo(0.014);
    expect(vexBarAlpha(2)).toBeCloseTo(0.564);
    expect(VEX_BARS_GAP).toBe(3);
  });

  it("takes its mood from her state alone", () => {
    expect(VEX_STATES.map((state) => [state, vexBarsMoodOf(state)])).toEqual([
      ["ready", "ready"],
      ["listening", "ready"],
      ["thinking", "busy"],
      ["working", "busy"],
      ["awaiting", "approve"],
      ["done", "ready"],
      ["concerned", "ready"],
      ["error", "ready"],
      ["sleeping", "ready"],
      ["waking", "busy"],
    ]);
  });

  it("eases each level toward its goal on the spring, and settles onto it", () => {
    const model = new VexBarsModel(20);
    const goal = Array.from({ length: 20 }, (_, i) => vexBarGoal("approve", 2, i, 20));
    const gap = (): number =>
      model.levels().reduce((sum, level, i) => sum + Math.abs(level - (goal[i] ?? 0)), 0);
    const before = gap();
    for (let k = 0; k < 120; k += 1) model.step("approve", 2, 1 / 60);
    expect(gap()).toBeLessThan(before / 10);
    model.settle("busy", VEX_BARS_STILL_S);
    expect(model.levels()).toEqual(
      Array.from({ length: 20 }, (_, i) => vexBarGoal("busy", VEX_BARS_STILL_S, i, 20)),
    );
  });

  it("never steps more than 50ms in one frame", () => {
    const capped = new VexBarsModel(12);
    const sliced = new VexBarsModel(12);
    capped.step("busy", 1, 60);
    sliced.step("busy", 1, 0.05);
    expect(capped.levels()).toEqual(sliced.levels());
  });

  it("keeps every goal a level between nothing and full", () => {
    for (const mood of ["ready", "busy", "approve"] as const) {
      for (let s = 0; s < 12; s += 0.37) {
        for (let i = 0; i < 20; i += 1) {
          const goal = vexBarGoal(mood, s, i, 20);
          expect(goal).toBeGreaterThanOrEqual(0);
          expect(goal).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

/* ---------------------------------- the canvas --------------------------------- */

let hidden = false;
let onscreen: ((entries: { readonly isIntersecting: boolean }[]) => void) | null = null;
let paints = 0;
let rects = 0;
let frames: FrameRequestCallback[] = [];
let now = 0;

function setHidden(next: boolean): void {
  hidden = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Run the next animation frame `ms` after the last. */
function frame(ms: number): void {
  now += ms;
  const due = frames;
  frames = [];
  act(() => {
    for (const callback of due) callback(now);
  });
}

beforeEach(() => {
  still.current = false;
  hidden = false;
  onscreen = null;
  paints = 0;
  rects = 0;
  frames = [];
  now = 0;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { readonly isIntersecting: boolean }[]) => void) {
        onscreen = callback;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", { configurable: true, get: () => 432 });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", { configurable: true, get: () => 72 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        setTransform: () => undefined,
        clearRect: () => {
          paints += 1;
        },
        fillRect: () => {
          rects += 1;
        },
        fillStyle: "",
        globalAlpha: 1,
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the bars' canvas", () => {
  it("draws one bar per count every frame while on screen and the window is shown", () => {
    render(<VexBars mood="ready" />);
    expect(paints).toBe(1);
    expect(rects).toBe(vexBarCount(432));
    expect(frames.length).toBe(1);
    frame(16);
    frame(16);
    expect(paints).toBe(3);
    expect(frames.length).toBe(1);
    expect(document.querySelector("[data-vex-bars-running='true']")).not.toBeNull();
  });

  it("stops while the window is hidden or the canvas is off screen, and resumes", () => {
    render(<VexBars mood="busy" />);
    setHidden(true);
    expect(frames.length).toBe(0);
    setHidden(false);
    expect(frames.length).toBe(1);
    act(() => onscreen?.([{ isIntersecting: false }]));
    expect(frames.length).toBe(0);
    const held = paints;
    frame(1000);
    expect(paints).toBe(held);
    act(() => onscreen?.([{ isIntersecting: true }]));
    expect(frames.length).toBe(1);
  });

  it("stops on unmount", () => {
    const view = render(<VexBars mood="approve" />);
    view.unmount();
    expect(frames.length).toBe(0);
  });

  it("paints one still frame, again for a new mood, and starts no loop under reduced motion or Save-Data", () => {
    still.current = true;
    const view = render(<VexBars mood="ready" />);
    expect(frames.length).toBe(0);
    const first = paints;
    expect(first).toBeGreaterThanOrEqual(1);
    view.rerender(<VexBars mood="busy" />);
    expect(paints).toBe(first + 1);
    expect(frames.length).toBe(0);
    expect(document.querySelector("[data-vex-bars-running='false']")).not.toBeNull();
  });

  it("is decorative, takes no pointer and its colour from the sheet", () => {
    render(<VexBars mood="ready" />);
    const canvas = document.querySelector("canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("data-vex-bars")).toBe("ready");
    const rule = /\n\.vex-foot__bars \{([^}]*)\}/.exec(SHEET)?.[1] ?? "";
    expect(rule).toMatch(/color:\s*var\(--vex-alias-bars\);/);
    expect(rule).toMatch(/pointer-events:\s*none;/);
    expect(rule).toMatch(/inset:\s*0;/);
  });
});
