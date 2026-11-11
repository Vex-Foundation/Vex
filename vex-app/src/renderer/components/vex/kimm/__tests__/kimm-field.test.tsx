// @vitest-environment jsdom

/**
 * Kimm's glyph field (`kimm-field.ts`, `KimmField.tsx`, the port in
 * `gradient-ascii.ts`; docs/design/H3-DESKTOP.md sections 1.5, 3.2 and 3.5;
 * plan row S4-17; MOTION-POLICY.md "Kimm's glyph field"). Pinned:
 *
 *  - THE RECIPE: VEX Cloud's, ' VEX', cell 20, density 0.5, glyphs 0.6,
 *    gradient 0.8, the four blues on the horizon shape, no intro, at most
 *    twice the CSS pixel;
 *  - THE GATE: it runs only live, only while her section is open, only on
 *    screen in a shown window, never under reduced motion or Save-Data;
 *  - THE MOUNT: the port is mounted once, holding one frame, and every
 *    switch of the gate is its `setStill`, never a remount; it is disposed on
 *    unmount; her ground hears when it has painted, and nothing when WebGL2
 *    drew nothing;
 *  - THE PORT is plain canvas code: no eval, no WebAssembly, no worker, its
 *    licence header and licence file beside it.
 *
 * jsdom has no WebGL2, so the port is replaced by a recording fake here; the
 * port's own drawing is Cloud's, unchanged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GradientAsciiOptions } from "../kimm-field.js";
import { KIMM_FIELD_RECIPE, kimmFieldOptions, kimmFieldRuns } from "../kimm-field.js";

/** Reduced motion or Save-Data, as the still-frame read answers it. */
const still = vi.hoisted(() => ({ current: false }));
vi.mock("../../../../lib/motion/use-still-frame.js", () => ({
  prefersSaveData: () => false,
  prefersStillFrame: () => still.current,
  useStillFrame: () => still.current,
}));

/** The port, recorded: each mount's options, its `setStill` calls, its disposal. */
interface FakeField {
  readonly options: GradientAsciiOptions;
  readonly still: boolean[];
  disposed: boolean;
}
const port = vi.hoisted(() => ({ mounts: [] as FakeField[], drawn: true }));
vi.mock("../gradient-ascii.js", () => ({
  mountGradientAscii: (_container: HTMLElement, options: GradientAsciiOptions) => {
    const field: FakeField = { options, still: [], disposed: false };
    port.mounts.push(field);
    return {
      drawn: port.drawn,
      dispose: () => {
        field.disposed = true;
      },
      wake: () => undefined,
      setStill: (on: boolean) => {
        field.still.push(on);
      },
    };
  },
}));

const { KimmField } = await import("../KimmField.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT_SOURCE = readFileSync(path.join(here, "..", "gradient-ascii.ts"), "utf8");
const LICENCE = readFileSync(path.join(here, "..", "GRADIENT-ASCII-LICENSE.md"), "utf8");
const KIMM_CSS = readFileSync(
  path.join(here, "..", "..", "..", "..", "styles", "global-css", "kimm.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the field's recipe", () => {
  it("is VEX Cloud's: ' VEX', cell 20, density 0.5, glyphs 0.6, gradient 0.8, four blues, horizon", () => {
    expect(KIMM_FIELD_RECIPE).toEqual({
      colors: ["#1e3fd8", "#f6f8ff", "#a5d8ff", "#38bdf8"],
      shape: "horizon",
      characters: " VEX",
      cellSize: 20,
      density: 0.5,
      glyphOpacity: 0.6,
      gradientOpacity: 0.8,
      fontFamily: '"Roboto Mono", ui-monospace, monospace',
      intro: false,
    });
  });

  it("holds one frame unless it runs, takes the pointer's trail only live, and caps the pixel ratio at 2", () => {
    expect(kimmFieldOptions("live", true, 3)).toMatchObject({ still: false, mouseInteraction: true, dpr: 2 });
    expect(kimmFieldOptions("live", false, 1)).toMatchObject({ still: true, dpr: 1 });
    expect(kimmFieldOptions("frame", false, 0)).toMatchObject({ still: true, mouseInteraction: false, dpr: 1 });
  });
});

describe("the field's gate", () => {
  const open = { mode: "live", open: true, still: false, onScreen: true } as const;

  it("runs live, open, on screen and with motion allowed", () => {
    expect(kimmFieldRuns(open)).toBe(true);
  });

  it("holds its frame when she is closed, off screen or hidden, under the still frame, or in the band", () => {
    expect(kimmFieldRuns({ ...open, open: false })).toBe(false);
    expect(kimmFieldRuns({ ...open, onScreen: false })).toBe(false);
    expect(kimmFieldRuns({ ...open, still: true })).toBe(false);
    expect(kimmFieldRuns({ ...open, mode: "frame" })).toBe(false);
  });
});

/* ---------------------------------- the mount --------------------------------- */

let hidden = false;
let onscreen: ((entries: { readonly isIntersecting: boolean }[]) => void) | null = null;
let frames: FrameRequestCallback[] = [];

function setHidden(next: boolean): void {
  hidden = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** Run the pending animation frames (and the ones they ask for), `times` deep. */
function runFrames(times: number): void {
  for (let i = 0; i < times; i += 1) {
    const due = frames;
    frames = [];
    act(() => {
      for (const callback of due) callback(0);
    });
  }
}

/** Let the dynamic import of the port settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

function only(): FakeField {
  expect(port.mounts).toHaveLength(1);
  const field = port.mounts[0];
  if (field === undefined) throw new Error("the field was never mounted");
  return field;
}

function runningAttr(): string | null {
  return document.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-running") ?? null;
}

beforeEach(() => {
  still.current = false;
  hidden = false;
  onscreen = null;
  frames = [];
  port.mounts = [];
  port.drawn = true;
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
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the field's mount", () => {
  it("mounts the port once with the recipe, then runs it while she is open and on screen", async () => {
    render(<KimmField open />);
    await settle();
    const field = only();
    expect(field.options).toMatchObject({ ...KIMM_FIELD_RECIPE, still: true, mouseInteraction: true });
    // Mounted holding a frame, then set running because the gate is open.
    expect(field.still.at(-1)).toBe(false);
    expect(runningAttr()).toBe("true");
  });

  it("holds its frame when she closes, and runs again from it when she opens, never remounting", async () => {
    const view = render(<KimmField open />);
    await settle();
    view.rerender(<KimmField open={false} />);
    expect(only().still.at(-1)).toBe(true);
    expect(runningAttr()).toBe("false");
    view.rerender(<KimmField open />);
    expect(only().still.at(-1)).toBe(false);
    expect(port.mounts).toHaveLength(1);
  });

  it("holds while the window is hidden or the field is off screen, and resumes", async () => {
    render(<KimmField open />);
    await settle();
    const field = only();
    setHidden(true);
    expect(field.still.at(-1)).toBe(true);
    setHidden(false);
    expect(field.still.at(-1)).toBe(false);
    act(() => onscreen?.([{ isIntersecting: false }]));
    expect(field.still.at(-1)).toBe(true);
    act(() => onscreen?.([{ isIntersecting: true }]));
    expect(field.still.at(-1)).toBe(false);
  });

  it("draws one frame and never runs under reduced motion or Save-Data", async () => {
    still.current = true;
    render(<KimmField open />);
    await settle();
    const field = only();
    expect(field.options.still).toBe(true);
    expect(field.still).not.toContain(false);
    expect(runningAttr()).toBe("false");
  });

  it("holds its frame on a page though she is open, and runs again in a chat, never remounting", async () => {
    // VEX Cloud runs the field only in a chat's section; a page paints one frame.
    const view = render(<KimmField open hold />);
    await settle();
    expect(only().still).not.toContain(false);
    expect(runningAttr()).toBe("false");
    view.rerender(<KimmField open />);
    expect(only().still.at(-1)).toBe(false);
    expect(runningAttr()).toBe("true");
    view.rerender(<KimmField open hold />);
    expect(only().still.at(-1)).toBe(true);
    expect(port.mounts).toHaveLength(1);
  });

  it("draws one frame and never runs in the band", async () => {
    render(<KimmField open mode="frame" />);
    await settle();
    const field = only();
    expect(field.options).toMatchObject({ still: true, mouseInteraction: false });
    expect(field.still).not.toContain(false);
  });

  it("tells her ground two frames after it has painted, and again when it is gone", async () => {
    const onDrawn = vi.fn();
    const view = render(<KimmField open onDrawn={onDrawn} />);
    await settle();
    runFrames(1);
    expect(onDrawn).not.toHaveBeenCalled();
    runFrames(1);
    expect(onDrawn).toHaveBeenCalledWith(true);
    view.unmount();
    expect(onDrawn).toHaveBeenLastCalledWith(false);
    expect(only().disposed).toBe(true);
  });

  it("never tells her ground it painted where WebGL2 drew nothing: the baked frame stays", async () => {
    port.drawn = false;
    const onDrawn = vi.fn();
    render(<KimmField open onDrawn={onDrawn} />);
    await settle();
    runFrames(3);
    expect(onDrawn).not.toHaveBeenCalledWith(true);
  });

  it("mounts nothing when it leaves before the port has loaded", async () => {
    const view = render(<KimmField open />);
    view.unmount();
    await settle();
    expect(port.mounts).toHaveLength(0);
  });

  it("is decorative and takes no pointer", () => {
    render(<KimmField open={false} />);
    const box = document.querySelector("[data-vex-area='kimm-field']");
    expect(box?.getAttribute("aria-hidden")).toBe("true");
    const rule = /\.vex-kimm__field\s*\{([^}]*)\}/.exec(KIMM_CSS)?.[1] ?? "";
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});

describe("the port", () => {
  it("is plain canvas code: no eval, no Function, no WebAssembly, no worker", () => {
    expect(PORT_SOURCE).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|WebAssembly|new\s+Worker\s*\(|importScripts/);
    expect(PORT_SOURCE).toMatch(/getContext\("webgl2"/);
  });

  it("keeps its licence header, and its licence file stands beside it", () => {
    expect(PORT_SOURCE.slice(0, 400)).toMatch(/React Bits/);
    expect(PORT_SOURCE.slice(0, 400)).toMatch(/Copyright \(c\) 2026 David Haz\. MIT \+ Commons Clause License Condition v1\.0/);
    expect(LICENCE).toMatch(/^MIT \+ Commons Clause License Condition v1\.0/);
    expect(LICENCE).toMatch(/Copyright \(c\) 2026 David Haz/);
  });
});
