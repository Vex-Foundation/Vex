/**
 * The flock engine: the compositions are the design's (the agent state
 * table, `docs/design/V10-SPREAD.md section 6`), the still frame
 * is the frame motion starts from, and nothing animates where it should not:
 * not in the states that hold still, not under reduced motion or Save-Data,
 * and not one frame while the window is hidden or the plate is off screen.
 *
 * The 2D canvas is the recording fake from `fake-canvas.ts`, so the real
 * classifier, the real placement and the real draw run; what is asserted is
 * the exact list of blocks painted.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PixelSource } from "../../../lib/pixel/core.js";
import { DESK_AGENT_STATES, type DeskAgentState } from "../agent-state.js";
import {
  FPS_CAP,
  FRAME_STEP_MS,
  FlockEngine,
  MOVING_STATES,
  PLATE_ART,
  STAGE_POSE,
  compositionFor,
  placeEagle,
  spritesFor,
  type EagleLayer,
  type BirdLayer,
  type Composition,
} from "../flock-engine.js";
import {
  BIRD_SPRITE,
  EAGLE_SPRITE,
  fakeSprite,
  firstFrame,
  installFakeCanvas,
  lastFrame,
  paintLog,
} from "./fake-canvas.js";

/* ------------------------------------------------------------- the environment */

let restoreCanvas: () => void = () => undefined;
const dprDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
let hidden = false;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const rafCalls = { requested: 0, cancelled: 0 };

beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
});

afterAll(() => {
  restoreCanvas();
  Reflect.deleteProperty(document, "hidden");
  if (dprDescriptor === undefined) Reflect.deleteProperty(window, "devicePixelRatio");
  else Object.defineProperty(window, "devicePixelRatio", dprDescriptor);
});

beforeEach(() => {
  hidden = false;
  frames = new Map();
  nextFrame = 1;
  rafCalls.requested = 0;
  rafCalls.cancelled = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCalls.requested += 1;
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCalls.cancelled += 1;
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run every pending frame callback at `now`. */
function flushFrames(now: number): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb(now);
}

/** Drive the loop at 4ms steps from `from` to `to` (a fast display, so the cap shows). */
function runFor(from: number, to: number): void {
  for (let now = from; now <= to; now += 4) flushFrames(now);
}

const SPRITES = new Map<string, PixelSource>([
  [PLATE_ART.eagle, fakeSprite(480, 369, EAGLE_SPRITE)],
  ...[1, 3, 6, 7, 8].map(
    (n): [string, PixelSource] => [`${PLATE_ART.birds}bird-${n}.webp`, fakeSprite(192, 110, BIRD_SPRITE)],
  ),
]);

function load(src: string): Promise<PixelSource> {
  const img = SPRITES.get(src);
  return img === undefined ? Promise.reject(new Error(`no sprite ${src}`)) : Promise.resolve(img);
}

/** A plate canvas of a given CSS size. */
function plateCanvas(width = 300, height = 900): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  });
  return canvas;
}

async function started(
  state: DeskAgentState,
  still: boolean,
  canvas = plateCanvas(),
): Promise<{ engine: FlockEngine; canvas: HTMLCanvasElement }> {
  const engine = new FlockEngine({ canvas, state, layout: "page", still, load });
  await engine.start();
  return { engine, canvas };
}

const eagleOf = (c: Composition): EagleLayer | undefined =>
  c.layers.find((l): l is EagleLayer => l.kind === "eagle");
const birdsOf = (c: Composition): BirdLayer[] =>
  c.layers.filter((l): l is BirdLayer => l.kind === "bird");

/* ------------------------------------------------------------- compositions */

describe("compositions: the agent state table on a 300 x 900 page", () => {
  it("idle: the eagle glides 150 wide at 99, 596 with two far birds resting", () => {
    const c = compositionFor("idle", "page", 300, 900);
    const eagle = eagleOf(c);
    expect(eagle).toMatchObject({ cx: 99, vis: 150, cell: 4 });
    expect(eagle?.cy).toBeCloseTo(595.8, 5);
    expect(eagle?.glitch).toMatchObject({ trail: 0.42, trailLen: 12 });
    expect(birdsOf(c)).toHaveLength(2);
    expect(c.dust).toBeNull();
    expect(c.hold).toBeNull();
  });

  it("live: short eagle trails, four far birds wheeling round 26 gathering pixels", () => {
    const c = compositionFor("live", "page", 300, 900);
    expect(eagleOf(c)?.glitch).toMatchObject({ trail: 0.26, trailLen: 6 });
    expect(birdsOf(c)).toHaveLength(4);
    expect(c.dust).toMatchObject({ n: 26 });
    expect(c.wheel).toEqual({ x: c.dust?.x, y: c.dust?.y });
  });

  it("running: single file with full trails, the eagle leading 104 wide", () => {
    const c = compositionFor("running", "page", 300, 900);
    const eagle = eagleOf(c);
    expect(eagle).toMatchObject({ vis: 104 });
    expect(eagle?.glitch).toMatchObject({ trail: 0.62, trailLen: 22 });
    const birds = birdsOf(c);
    expect(birds).toHaveLength(3);
    for (const b of birds) expect(b.glitch).toMatchObject({ trail: 0.7, trailLen: 16 });
    // The lead is ahead of every bird in the line.
    expect(Math.max(...birds.map((b) => b.x + b.w))).toBeLessThan(eagle?.cx ?? 0);
  });

  it("awaiting: frozen and crisp, with a 40 px hold line ahead of the lead", () => {
    const c = compositionFor("awaiting", "page", 300, 900);
    for (const l of c.layers) expect(l.glitch.crisp).toBe(true);
    expect(c.hold).toMatchObject({ len: 40 });
    expect(c.hold?.x).toBeGreaterThan(eagleOf(c)?.cx ?? Infinity);
    expect(c.dust).toBeNull();
  });

  it("paused: the empty print", () => {
    for (const layout of ["page", "stage"] as const) {
      expect(compositionFor("paused", layout, 300, 900)).toEqual({
        layers: [],
        dust: null,
        hold: null,
        wheel: null,
      });
    }
  });

  it("a page under 120 wide is the spine: the eagle alone, small", () => {
    for (const state of ["idle", "live", "running", "awaiting"] as const) {
      const c = compositionFor(state, "page", 56, 720);
      expect(c.layers).toHaveLength(1);
      expect(eagleOf(c)?.cell).toBe(2);
      expect(eagleOf(c)?.vis).toBeLessThanOrEqual(42);
    }
  });

  it("the stage eagle sits 288 wide at 288, 567 in a 1440 x 900 window", () => {
    const eagle = eagleOf(compositionFor("idle", "stage", 1440, 900, STAGE_POSE));
    expect(eagle?.cx).toBeCloseTo(288, 5);
    expect(eagle?.cy).toBeCloseTo(567, 5);
    expect(eagle?.vis).toBeCloseTo(288, 5);
    expect(eagle?.cell).toBe(5);
  });

  it("only live and running move", () => {
    expect([...MOVING_STATES].sort()).toEqual(["live", "running"]);
  });

  it("loads the wing beat poses only for a moving flock", () => {
    expect(spritesFor("live", "page", false).sort()).not.toContain(`${PLATE_ART.birds}bird-1.webp`);
    expect(spritesFor("awaiting", "page", false)).toContain(`${PLATE_ART.birds}bird-1.webp`);
    expect(spritesFor("running", "page", true)).toEqual(
      expect.arrayContaining([6, 7, 8].map((n) => `${PLATE_ART.birds}bird-${n}.webp`)),
    );
    expect(spritesFor("paused", "page", true)).toEqual([]);
    expect(spritesFor("idle", "stage", false)).toEqual([PLATE_ART.eagle]);
  });
});

describe("the eagle is placed by its visible box", () => {
  it("centres the visible box on the pose, within half a block", () => {
    const box = { fw: 480, fh: 369, x0: 48, x1: 432, y0: 30, y1: 339 };
    const pose = { cx: 99, cy: 595.8, vis: 150, cell: 4 };
    const at = placeEagle(box, pose, 2);
    const k = at.w / box.fw;
    const centreX = at.X0 / 2 + ((box.x0 + box.x1) / 2) * k;
    const centreY = at.Y0 / 2 + ((box.y0 + box.y1) / 2) * k;
    expect(Math.abs(centreX - pose.cx)).toBeLessThanOrEqual(pose.cell / 2);
    expect(Math.abs(centreY - pose.cy)).toBeLessThanOrEqual(pose.cell / 2);
    expect((box.x1 - box.x0) * k).toBeCloseTo(150, 5);
    // Blocks snap to whole device cells.
    expect(at.X0 % at.c).toBe(0);
    expect(at.Y0 % at.c).toBe(0);
  });
});

/* ------------------------------------------------------------- the still frame */

describe("the still frame (reduced motion, Save-Data)", () => {
  it.each(DESK_AGENT_STATES)("%s paints one composed frame and never asks for another", async (state) => {
    const { engine, canvas } = await started(state, true);
    const log = paintLog(canvas);
    expect(log.clears).toBe(1);
    expect(canvas.dataset.ready).toBe("");
    if (state === "paused") expect(log.rects).toHaveLength(0);
    else expect(log.rects.length).toBeGreaterThan(0);
    expect(rafCalls.requested).toBe(0);
    engine.destroy();
  });

  it.each(DESK_AGENT_STATES)("%s: the still frame is the same pixels every time", async (state) => {
    const a = await started(state, true);
    const b = await started(state, true);
    expect(paintLog(b.canvas).rects).toEqual(paintLog(a.canvas).rects);
    a.engine.destroy();
    b.engine.destroy();
  });

  it.each([...MOVING_STATES])("%s: motion starts from exactly the still frame", async (state) => {
    const still = await started(state, true);
    const moving = await started(state, false);
    expect(moving.engine.moving).toBe(true);
    expect(firstFrame(paintLog(moving.canvas))).toEqual(firstFrame(paintLog(still.canvas)));
    still.engine.destroy();
    moving.engine.destroy();
  });

  it("the spine and the stage have still frames too", async () => {
    const spine = await started("idle", true, plateCanvas(56, 720));
    expect(paintLog(spine.canvas).rects.length).toBeGreaterThan(0);
    const stageCanvas = plateCanvas(1440, 900);
    const stage = new FlockEngine({ canvas: stageCanvas, state: "idle", layout: "stage", still: true, load });
    await stage.start();
    expect(paintLog(stageCanvas).rects.length).toBeGreaterThan(0);
    expect(rafCalls.requested).toBe(0);
    spine.engine.destroy();
    stage.destroy();
  });
});

/* ------------------------------------------------------------- motion */

describe("motion", () => {
  it.each(["idle", "awaiting", "paused"] as const)(
    "%s holds still even with motion allowed: no loop at all",
    async (state) => {
      const { engine, canvas } = await started(state, false);
      expect(engine.moving).toBe(false);
      expect(rafCalls.requested).toBe(0);
      expect(paintLog(canvas).clears).toBe(1);
      engine.destroy();
    },
  );

  it("a moving flock repaints on the frame step and never above the 30fps cap", async () => {
    const { engine, canvas } = await started("live", false);
    const log = paintLog(canvas);
    runFor(0, 1000);
    // One composed frame plus at most one paint per 1/30 s over that second.
    expect(log.clears).toBeGreaterThan(1 + 1000 / FRAME_STEP_MS - 2);
    expect(log.clears).toBeLessThanOrEqual(1 + FPS_CAP + 1);
    // The trails and the dust were re-seeded and the birds wheeled: the pixels moved.
    expect(lastFrame(log)).not.toEqual(firstFrame(log));
    engine.destroy();
  });

  it("running repaints only when a block can change (the frame step)", async () => {
    const { engine, canvas } = await started("running", false);
    const log = paintLog(canvas);
    runFor(0, 1000);
    // Five frame steps a second, plus the bob moving a block now and then.
    expect(log.clears).toBeLessThanOrEqual(1 + FPS_CAP + 1);
    expect(log.clears).toBeGreaterThanOrEqual(1 + 4);
    engine.destroy();
  });

  it("destroy stops the loop", async () => {
    const { engine, canvas } = await started("live", false);
    runFor(0, 100);
    engine.destroy();
    const clears = paintLog(canvas).clears;
    const requested = rafCalls.requested;
    runFor(104, 1000);
    expect(paintLog(canvas).clears).toBe(clears);
    expect(rafCalls.requested).toBe(requested);
  });
});

describe("no animation frames while hidden", () => {
  it("a hidden window gets the composed frame and not one animation frame", async () => {
    hidden = true;
    const { engine, canvas } = await started("live", false);
    const log = paintLog(canvas);
    expect(log.clears).toBe(1);
    expect(rafCalls.requested).toBe(0);
    runFor(0, 1000);
    expect(log.clears).toBe(1);
    expect(rafCalls.requested).toBe(0);
    engine.destroy();
  });

  it("stops when the window hides and resumes, without a jump, when it shows", async () => {
    const { engine, canvas } = await started("running", false);
    const log = paintLog(canvas);
    runFor(0, 400);
    expect(rafCalls.requested).toBeGreaterThan(0);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafCalls.cancelled).toBeGreaterThan(0);
    expect(frames.size).toBe(0);
    const clearsWhileHidden = log.clears;
    const requestedWhileHidden = rafCalls.requested;
    runFor(404, 5000);
    expect(log.clears).toBe(clearsWhileHidden);
    expect(rafCalls.requested).toBe(requestedWhileHidden);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafCalls.requested).toBe(requestedWhileHidden + 1);
    runFor(5004, 5400);
    expect(log.clears).toBeGreaterThan(clearsWhileHidden);
    engine.destroy();
  });

  it("an off screen plate does not loop either", async () => {
    let report: (visible: boolean) => void = () => undefined;
    // The engine reads `isIntersecting` and nothing else from an entry.
    class FakeObserver {
      constructor(cb: (entries: readonly { readonly isIntersecting: boolean }[]) => void) {
        report = (visible) => cb([{ isIntersecting: visible }]);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const { engine, canvas } = await started("live", false);
    report(false);
    const clears = paintLog(canvas).clears;
    runFor(0, 1000);
    expect(paintLog(canvas).clears).toBe(clears);
    expect(frames.size).toBe(0);
    report(true);
    runFor(1004, 1400);
    expect(paintLog(canvas).clears).toBeGreaterThan(clears);
    engine.destroy();
  });
});
