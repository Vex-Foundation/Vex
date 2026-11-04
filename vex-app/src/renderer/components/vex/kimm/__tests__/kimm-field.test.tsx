// @vitest-environment jsdom

/**
 * Kimm's glyph field (`kimm-field.ts`, `KimmField.tsx`; docs/design/H3-DESKTOP.md
 * sections 1.5, 3.2 and 3.5; plan row S4-17; MOTION-POLICY.md "Kimm's glyph
 * field"). Pinned:
 *
 *  - THE MODEL: V, X and E only, inside the field's grid, the same field for
 *    the same step (one seeded sequence), and it moves as it steps;
 *  - IT RUNS only while her section is open, the window is shown and the
 *    canvas is on screen (the run gate), stepping 10 times a second, never
 *    more than the clock cap in one frame;
 *  - IT STOPS when she closes (the field holds its frame), when the window
 *    hides or the canvas leaves the screen, and on unmount;
 *  - THE STILL FRAME: under reduced motion or Save-Data it paints one frame
 *    and starts no loop;
 *  - the canvas is decorative and takes its ink and face from the sheet.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KIMM_FIELD_CELL,
  KIMM_FIELD_CLOCK_CAP_MS,
  KIMM_FIELD_GLYPHS,
  KIMM_FIELD_STEP_MS,
  KimmFieldModel,
} from "../kimm-field.js";

/** Reduced motion or Save-Data, as the still-frame read answers it. */
const still = vi.hoisted(() => ({ current: false }));
vi.mock("../../../../lib/motion/use-still-frame.js", () => ({
  prefersSaveData: () => false,
  prefersStillFrame: () => still.current,
  useStillFrame: () => still.current,
}));

const { KimmField } = await import("../KimmField.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const KIMM_CSS = readFileSync(
  path.join(here, "..", "..", "..", "..", "styles", "global-css", "kimm.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the glyph field's model", () => {
  it("draws only V, X and E, inside its grid", () => {
    const model = new KimmFieldModel(431, 603);
    model.advance(60);
    expect(model.columns).toBe(Math.floor(431 / KIMM_FIELD_CELL.width));
    expect(model.rows).toBe(Math.ceil(603 / KIMM_FIELD_CELL.height));
    const glyphs = model.glyphs();
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(KIMM_FIELD_GLYPHS).toContain(glyph.glyph);
      expect(glyph.column).toBeGreaterThanOrEqual(0);
      expect(glyph.column).toBeLessThan(model.columns);
      expect(glyph.row).toBeGreaterThanOrEqual(0);
      expect(glyph.row).toBeLessThan(model.rows);
      expect(glyph.alpha).toBeGreaterThan(0);
      expect(glyph.alpha).toBeLessThanOrEqual(1);
    }
  });

  it("is the same field for the same step, and moves as it steps", () => {
    const a = new KimmFieldModel(431, 603);
    const b = new KimmFieldModel(431, 603);
    a.advance(30);
    b.advance(30);
    expect(a.glyphs()).toEqual(b.glyphs());
    const before = JSON.stringify(a.glyphs());
    a.advance(10);
    expect(JSON.stringify(a.glyphs())).not.toBe(before);
    expect(a.step).toBe(40);
  });
});

/* ---------------------------------- the canvas --------------------------------- */

let hidden = false;
let onscreen: ((entries: { readonly isIntersecting: boolean }[]) => void) | null = null;
let paints = 0;
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
  // A canvas with a box and a 2D context that counts its paints.
  Object.defineProperty(HTMLCanvasElement.prototype, "clientWidth", { configurable: true, get: () => 431 });
  Object.defineProperty(HTMLCanvasElement.prototype, "clientHeight", { configurable: true, get: () => 603 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        setTransform: () => undefined,
        clearRect: () => {
          paints += 1;
        },
        fillText: () => undefined,
        fillStyle: "",
        font: "",
        textBaseline: "top",
        globalAlpha: 1,
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the glyph field's canvas", () => {
  it("runs while she is open and on screen, stepping ten times a second", () => {
    render(<KimmField running />);
    const first = paints;
    expect(first).toBe(1);
    expect(frames.length).toBe(1);
    frame(16);
    frame(50);
    // Not yet a step: nothing repaints.
    expect(paints).toBe(first);
    frame(KIMM_FIELD_STEP_MS);
    expect(paints).toBe(first + 1);
    expect(frames.length).toBe(1);
    expect(document.querySelector("[data-kimm-field-running='true']")).not.toBeNull();
  });

  it("never advances more than the clock cap in one frame", () => {
    render(<KimmField running />);
    frame(16);
    const spy = vi.spyOn(KimmFieldModel.prototype, "advance");
    frame(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(Math.floor(KIMM_FIELD_CLOCK_CAP_MS / KIMM_FIELD_STEP_MS));
  });

  it("holds its frame when she closes: no loop while closed", () => {
    const view = render(<KimmField running />);
    view.rerender(<KimmField running={false} />);
    const held = paints;
    expect(frames.length).toBe(0);
    frame(1000);
    expect(paints).toBe(held);
    view.rerender(<KimmField running />);
    expect(frames.length).toBe(1);
  });

  it("stops while the window is hidden or the canvas is off screen, and resumes", () => {
    render(<KimmField running />);
    setHidden(true);
    expect(frames.length).toBe(0);
    setHidden(false);
    expect(frames.length).toBe(1);
    act(() => onscreen?.([{ isIntersecting: false }]));
    expect(frames.length).toBe(0);
    act(() => onscreen?.([{ isIntersecting: true }]));
    expect(frames.length).toBe(1);
  });

  it("paints one still frame and starts no loop under reduced motion or Save-Data", () => {
    still.current = true;
    render(<KimmField running />);
    expect(paints).toBe(1);
    expect(frames.length).toBe(0);
    expect(document.querySelector("[data-kimm-field-running='false']")).not.toBeNull();
  });

  it("stops on unmount", () => {
    const view = render(<KimmField running />);
    view.unmount();
    expect(frames.length).toBe(0);
  });

  it("is decorative and takes its ink and face from the sheet", () => {
    render(<KimmField running={false} />);
    const canvas = document.querySelector("canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    const rule = /\.vex-kimm__field\s*\{([^}]*)\}/.exec(KIMM_CSS)?.[1] ?? "";
    expect(rule).toMatch(/color:\s*var\(--vex-alias-label-primary\)/);
    expect(rule).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});
