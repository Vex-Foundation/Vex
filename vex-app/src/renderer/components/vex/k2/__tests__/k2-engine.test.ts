/**
 * K2's engine (`k2-engine.ts`) on a stepped clock, in jsdom: her art is a blank app drawing (the
 * real `meta.json` and token sheet, empty maps, blank bitmaps), the canvas has no 2D context, and
 * animation frames are fired by hand at 60 Hz. Each frame the engine steps places her coin (the
 * placings count the frames), and each frame whose pixels changed asks for the canvas's context
 * (the asks count the repaints). Regressions this catches: an episode (the wake from the token, the
 * close) stepped at anything but 30 fps, her idle life at anything but 10 fps, the coin at rest
 * repainted at all, a hidden window that still steps or whose clock runs on; a
 * coin start that reports anything but `token` or reports twice; an open that is not the wake
 * replayed from the press (opening until the wake hands her over), or a close that is not 1.94 s of
 * closing then the coin; an open asked for during a close that cuts the close short; a close asked for during an open that waits; a choice made before her first frame that
 * plays an episode; a still frame that plays any episode; and `setClosed` reopening with anything
 * but the 2.6 s open episode.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isK2Meta, isTokenSheet } from "../k2-assets.js";
import { K2Engine, type K2EngineOptions, type K2TokenState } from "../k2-engine.js";
import type { K2Map } from "../k2-portrait.js";
import { fitFor } from "../k2-rig.js";
import { CLOSE_MS, OPEN_LEAD, OPEN_MS, wakeEnd } from "../k2-time.js";
import { TokenSprite } from "../k2-token.js";

const here = dirname(fileURLToPath(import.meta.url));
const art = (file: string): unknown =>
  JSON.parse(readFileSync(join(here, "../../../../public/art/vex-k2/", file), "utf8"));
const META = art("app/meta.json");
const SHEET = art("token.json");
if (!isK2Meta(META) || !isTokenSheet(SHEET)) throw new Error("the art does not match");

/** A drawing with no lit cell: she computes every frame and draws no dot. */
function blank(n: number): K2Map {
  return {
    tone: new Float32Array(n),
    cls: new Uint8Array(n),
    flags: new Uint8Array(n),
    col: new Uint8Array(n),
    tip: new Float32Array(n),
  };
}

vi.mock("../k2-assets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../k2-assets.js")>();
  return {
    ...real,
    loadMeta: async () => META,
    loadTokenSheet: async () => SHEET,
    loadMap: async (_file: string, n: number) => blank(n),
    loadBitmap: async () => ({ width: 1, height: 1, close: () => undefined }),
  };
});

/** Animation frames fired by hand at 60 Hz, as a display would (a cancelled one never fires). */
let frames = new Map<number, (now: number) => void>();
let nextFrame = 1;
let wall = 0;
function stepFor(ms: number): void {
  const end = wall + ms;
  while (wall < end) {
    wall += 1000 / 60;
    const due = [...frames.values()];
    frames = new Map();
    for (const f of due) f(wall);
  }
}

/** The canvas's asks for its 2D context: one per frame the engine paints. */
let asks = 0;

/** Lets the engine's awaited loads and the toggle's pose promise settle. */
async function settle(): Promise<void> {
  for (let n = 0; n < 10; n++) await Promise.resolve();
}

let engine: K2Engine | null = null;

async function mount(
  more: Partial<K2EngineOptions> = {},
): Promise<{ engine: K2Engine; states: K2TokenState[] }> {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 320 });
  Object.defineProperty(host, "clientHeight", { value: 284 });
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", {
    value: () => {
      asks++;
      return null;
    },
  });
  host.append(canvas);
  document.body.append(host);
  const states: K2TokenState[] = [];
  const e = new K2Engine({
    host,
    canvas,
    dark: false,
    ground: "paper",
    still: false,
    wake: false,
    onWoken: () => undefined,
    onToken: (s) => states.push(s),
    ...more,
  });
  engine = e;
  e.setEmotion("idle");
  const fit = fitFor("welcome", 320, 284);
  if (fit === null) throw new Error("no fit");
  e.setFit(fit);
  await e.start();
  await settle();
  return { engine: e, states };
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  wall = 0;
  asks = 0;
  vi.stubGlobal("requestAnimationFrame", (f: (now: number) => void) => {
    const id = nextFrame++;
    frames.set(id, f);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  engine?.destroy();
  engine = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("the token toggle in the engine", () => {
  test("a coin start reports token once, after her first frame, and plays no wake", async () => {
    const { states } = await mount({ tokenOnly: true });
    expect(states).toEqual(["token"]);
    stepFor(12000);
    expect(states).toEqual(["token"]);
  });

  test("the open is the wake replayed from the press: opening until the wake hands her over, then shown", async () => {
    const { engine: e, states } = await mount({ tokenOnly: true });
    e.setTokenOnly(false);
    await settle();
    stepFor(200);
    expect(states).toEqual(["token", "opening"]);
    // still opening just before the wake ends (it starts OPEN_LEAD before the press)
    stepFor(wakeEnd("full") - OPEN_LEAD - 600);
    expect(states.at(-1)).toBe("opening");
    stepFor(800);
    expect(states).toEqual(["token", "opening", "shown"]);
  });

  test("the close: 1.94 s of closing, then the coin", async () => {
    const { engine: e, states } = await mount();
    expect(states).toEqual(["shown"]);
    stepFor(500);
    e.setTokenOnly(true);
    await settle();
    stepFor(200);
    expect(states).toEqual(["shown", "closing"]);
    stepFor(CLOSE_MS - 500);
    expect(states.at(-1)).toBe("closing");
    stepFor(600);
    expect(states).toEqual(["shown", "closing", "token"]);
  });

  test("an open asked for while she closes waits until the close has settled", async () => {
    const { engine: e, states } = await mount();
    e.setTokenOnly(true);
    await settle();
    stepFor(400);
    e.setTokenOnly(false);
    await settle();
    // the close runs to its end: still closing just before it settles
    stepFor(CLOSE_MS - 400 - 200);
    expect(states).toEqual(["shown", "closing"]);
    // then the coin presses at once into the wake (it stands upright for no frame of its own)
    stepFor(400);
    expect(states).toEqual(["shown", "closing", "opening"]);
  });

  test("a close asked for while she opens starts at once", async () => {
    const { engine: e, states } = await mount({ tokenOnly: true });
    e.setTokenOnly(false);
    await settle();
    stepFor(3000);
    expect(states.at(-1)).toBe("opening");
    e.setTokenOnly(true);
    await settle();
    stepFor(200);
    expect(states.at(-1)).toBe("closing");
    stepFor(CLOSE_MS);
    expect(states).toEqual(["token", "opening", "closing", "token"]);
  });

  test("a choice made before her first frame is where she starts, with no episode", async () => {
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 320 });
    Object.defineProperty(host, "clientHeight", { value: 284 });
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getContext", { value: () => null });
    host.append(canvas);
    document.body.append(host);
    const states: K2TokenState[] = [];
    const e = new K2Engine({
      host,
      canvas,
      dark: false,
      ground: "paper",
      still: false,
      wake: false,
      onWoken: () => undefined,
      onToken: (s) => states.push(s),
    });
    engine = e;
    const fit = fitFor("welcome", 320, 284);
    if (fit === null) throw new Error("no fit");
    e.setFit(fit);
    e.setTokenOnly(true);
    await e.start();
    await settle();
    stepFor(3000);
    expect(states).toEqual(["token"]);
  });

  test("under the still frame the toggle swaps at once between the two still states", async () => {
    const { engine: e, states } = await mount({ still: true });
    expect(states).toEqual(["shown"]);
    e.setTokenOnly(true);
    await settle();
    expect(states).toEqual(["shown", "token"]);
    e.setTokenOnly(false);
    await settle();
    expect(states).toEqual(["shown", "token", "shown"]);
    // no loop runs under the still frame
    expect(frames.size).toBe(0);
  });

  test("setClosed reopens with the open episode: opening for 2.6 s, then shown", async () => {
    const { engine: e, states } = await mount({ closed: true });
    expect(states).toEqual(["token"]);
    e.setClosed(false);
    await settle();
    stepFor(200);
    expect(states).toEqual(["token", "opening"]);
    stepFor(OPEN_MS);
    expect(states).toEqual(["token", "opening", "shown"]);
  });
});

/** The frames stepped (`placed`) and repainted (`painted`) over the next `ms` of the display. */
function framesOver(ms: number): { readonly placed: number; readonly painted: number } {
  const place = vi.spyOn(TokenSprite.prototype, "place");
  const before = asks;
  stepFor(ms);
  const placed = place.mock.calls.length;
  place.mockRestore();
  return { placed, painted: asks - before };
}

describe("the frame rate", () => {
  test("the wake from the token is painted at 30 fps, her idle life after it at 10 fps", async () => {
    const { engine: e, states } = await mount({ tokenOnly: true });
    e.setTokenOnly(false);
    await settle();
    stepFor(300);
    expect(states.at(-1)).toBe("opening");
    // the press, the turn, the beam and the assembly: a new frame every 33 or 34 ms
    const rise = framesOver(1000);
    expect(rise.placed).toBeGreaterThanOrEqual(29);
    expect(rise.placed).toBeLessThanOrEqual(31);
    // the coin turning and the beam growing change her pixels at that rate too
    expect(rise.painted).toBeGreaterThanOrEqual(20);
    stepFor(wakeEnd("full"));
    expect(states.at(-1)).toBe("shown");
    // awake and idle: the beam's life, the blink and the gaze step at 10 fps
    const idle = framesOver(1000);
    expect(idle.placed).toBeGreaterThanOrEqual(9);
    expect(idle.placed).toBeLessThanOrEqual(11);
    expect(idle.painted).toBeLessThanOrEqual(idle.placed);
  });

  test("the close is painted at 30 fps, and the coin at rest is not repainted", async () => {
    const { engine: e, states } = await mount();
    stepFor(500);
    e.setTokenOnly(true);
    await settle();
    stepFor(100);
    expect(states.at(-1)).toBe("closing");
    const close = framesOver(1000);
    expect(close.placed).toBeGreaterThanOrEqual(29);
    expect(close.placed).toBeLessThanOrEqual(31);
    stepFor(CLOSE_MS);
    expect(states.at(-1)).toBe("token");
    // at rest she steps at the idle rate and nothing of the frame changes: no repaint
    const rest = framesOver(3000);
    expect(rest.placed).toBeGreaterThanOrEqual(29);
    expect(rest.placed).toBeLessThanOrEqual(31);
    expect(rest.painted).toBe(0);
  });

  test("a hidden window paints nothing and her clock stops: she resumes where she was", async () => {
    const { engine: e, states } = await mount({ tokenOnly: true });
    e.setTokenOnly(false);
    await settle();
    stepFor(1000);
    expect(states.at(-1)).toBe("opening");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(framesOver(20000)).toEqual({ placed: 0, painted: 0 });
    hidden.mockRestore();
    document.dispatchEvent(new Event("visibilitychange"));
    // the wake was 1 s in: it still plays, at 30 fps
    stepFor(500);
    expect(states.at(-1)).toBe("opening");
    expect(framesOver(500).placed).toBeGreaterThanOrEqual(14);
  });
});
