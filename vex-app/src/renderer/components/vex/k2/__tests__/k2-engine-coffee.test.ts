/**
 * K2's morning coffee in the engine (`k2-engine.ts`, `setMorning`) on a stepped clock, in jsdom, as
 * `k2-engine.test.ts` drives it: her art is a blank app drawing (the real `meta.json`, token sheet
 * and `coffee.json`, empty maps), animation frames are fired by hand at 60 Hz and each frame she
 * steps places her coin. Her gestures' drawings never load here (no idle callback), so her pool is
 * the map-free one, plus the coffee in the morning. Regressions this catches: a coffee outside the
 * morning, a morning slot that passes without it, a coffee stepped at anything but 30 fps or played
 * on any face but its own (the hold, the sip with the content eye), a hover or an emotion other than
 * idle that does not end it within its 300 ms fade (or lets it come back), an emotion set before
 * its slot that does not hold it back, a failed coffee file that breaks her morning, and a still
 * frame in the morning that is painted without the mug or keeps the mug once the morning ends.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { isK2Meta, isTokenSheet } from "../k2-assets.js";
import { isCoffeeGeo } from "../k2-coffee.js";
import { K2Engine, type K2EngineOptions } from "../k2-engine.js";
import { type K2Map, Portrait, type PortraitFrame } from "../k2-portrait.js";
import { fitFor } from "../k2-rig.js";
import { GESTURE_MS, GestureChain } from "../k2-time.js";
import { TokenSprite } from "../k2-token.js";

const here = dirname(fileURLToPath(import.meta.url));
const art = (file: string): unknown =>
  JSON.parse(readFileSync(join(here, "../../../../public/art/vex-k2/", file), "utf8"));
const META = art("app/meta.json");
const SHEET = art("token.json");
const COFFEE = art("app/coffee.json");
if (!isK2Meta(META) || !isTokenSheet(SHEET) || !isCoffeeGeo(COFFEE))
  throw new Error("the art does not match");

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

/** The map files asked for, and whether the coffee's geometry fails to load. */
let mapsAsked: string[] = [];
let coffeeFails = false;

vi.mock("../k2-assets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../k2-assets.js")>();
  return {
    ...real,
    loadMeta: async () => META,
    loadTokenSheet: async () => SHEET,
    loadCoffeeGeo: async () => {
      if (coffeeFails) throw new Error("K2: app/coffee.json");
      return COFFEE;
    },
    loadMap: async (file: string, n: number) => {
      mapsAsked.push(file);
      return blank(n);
    },
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

/** Lets the engine's awaited loads settle. */
async function settle(): Promise<void> {
  for (let n = 0; n < 10; n++) await Promise.resolve();
}

let engine: K2Engine | null = null;

/** She starts awake and idle on the welcome; `morning` is set before her first frame. */
async function mount(morning: boolean, more: Partial<K2EngineOptions> = {}): Promise<K2Engine> {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 320 });
  Object.defineProperty(host, "clientHeight", { value: 284 });
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "getContext", { value: () => null });
  host.append(canvas);
  document.body.append(host);
  const e = new K2Engine({
    host,
    canvas,
    dark: false,
    ground: "paper",
    still: false,
    wake: false,
    onWoken: () => undefined,
    ...more,
  });
  engine = e;
  e.setEmotion("idle");
  e.setMorning(morning);
  const fit = fitFor("welcome", 320, 284);
  if (fit === null) throw new Error("no fit");
  e.setFit(fit);
  await e.start();
  await settle();
  return e;
}

/** The frames she steps over the next `ms` of the display. */
function stepped(ms: number): number {
  const place = vi.spyOn(TokenSprite.prototype, "place");
  stepFor(ms);
  const n = place.mock.calls.length;
  place.mockRestore();
  return n;
}

/** The frames her portrait is emitted for over the next `ms` (each pass's frame). */
function emitted(ms: number): PortraitFrame[] {
  const emit = vi.spyOn(Portrait.prototype, "emit");
  stepFor(ms);
  const out = emit.mock.calls.map((c) => c[0]);
  emit.mockRestore();
  return out;
}

/**
 * The first coffee's slot on her clock: awake at once, the morning from her first frame. The blow
 * keeps the first slot (6 s; its drawing never loads here, so it passes); the coffee takes the next.
 */
const FIRST = (() => {
  const chain = new GestureChain(0, null, 0);
  const slot = chain.from(6001);
  if (slot.name !== "coffee") throw new Error("the coffee is not the second slot");
  return slot.start;
})();

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  wall = 0;
  mapsAsked = [];
  coffeeFails = false;
  vi.stubGlobal("requestAnimationFrame", (f: (now: number) => void) => {
    const id = nextFrame++;
    frames.set(id, f);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  // her gestures' drawings never load: the pool stays the map-free one (and the coffee)
  vi.stubGlobal("requestIdleCallback", () => 0);
});

afterEach(() => {
  engine?.destroy();
  engine = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("the morning coffee's schedule in the engine", () => {
  test("the first coffee comes 12 s or more after she is awake, in the pool's second slot, within 40 s", () => {
    expect(FIRST).toBeGreaterThanOrEqual(12000);
    expect(FIRST).toBeLessThan(40000);
  });

  test("in the morning its slot plays at 30 fps for its 7.6 s, on its own face; without the morning the slot passes at 10 fps", async () => {
    await mount(true);
    expect(mapsAsked).toEqual(expect.arrayContaining(["app/coffeeHold.png", "app/coffeeSip.png"]));
    stepFor(FIRST - 1500);
    // before it: her idle life at 10 fps
    const before = stepped(1000);
    expect(before).toBeGreaterThanOrEqual(9);
    expect(before).toBeLessThanOrEqual(11);
    stepFor(700);
    // the mug risen and held: 30 fps
    const held = stepped(1000);
    expect(held).toBeGreaterThanOrEqual(29);
    expect(held).toBeLessThanOrEqual(31);
    // the sip (2.7 to 3.0 s in): the sip's drawing, the content eye, her lids half down
    stepFor(1500);
    const sip = emitted(300);
    expect(sip.some((fr) => fr.face.map === "coffeeSip" && fr.face.eyes === "content")).toBe(true);
    expect(sip.every((fr) => fr.face.actors === "coffee")).toBe(true);
    expect(Math.min(...sip.map((fr) => fr.lid))).toBeGreaterThanOrEqual(0.62);
    // after its 7.6 s: 10 fps again
    stepFor(GESTURE_MS.coffee - 3000 + 200);
    const after = stepped(1000);
    expect(after).toBeGreaterThanOrEqual(9);
    expect(after).toBeLessThanOrEqual(11);
  });

  test("without the morning no coffee loads and its slot passes at 10 fps", async () => {
    await mount(false);
    expect(mapsAsked.filter((f) => f.includes("coffee"))).toEqual([]);
    stepFor(FIRST + 700);
    const n = stepped(1000);
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(11);
  });

  test("a coffee file that fails to load leaves her morning like any other time", async () => {
    coffeeFails = true;
    await mount(true);
    stepFor(FIRST + 700);
    const n = stepped(1000);
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(11);
  });

  test("a morning that comes while she is on screen loads the coffee then", async () => {
    const e = await mount(false);
    stepFor(2000);
    e.setMorning(true);
    await settle();
    expect(mapsAsked).toEqual(expect.arrayContaining(["app/coffeeHold.png", "app/coffeeSip.png"]));
  });
});

describe("what holds the coffee back", () => {
  test("a hover during it fades it out within 300 ms, and it does not come back when the hover ends", async () => {
    const e = await mount(true);
    stepFor(FIRST + 1000);
    expect(stepped(300)).toBeGreaterThanOrEqual(8);
    e.setHover(true);
    // the fade still steps at 30 fps
    expect(stepped(200)).toBeGreaterThanOrEqual(5);
    stepFor(200);
    const gone = stepped(1000);
    expect(gone).toBeGreaterThanOrEqual(9);
    expect(gone).toBeLessThanOrEqual(11);
    e.setHover(false);
    const still = stepped(1000);
    expect(still).toBeLessThanOrEqual(11);
  });

  test("an emotion other than idle during it fades it out within 300 ms, the mug leaving under its face", async () => {
    const e = await mount(true);
    stepFor(FIRST + 1200);
    e.setEmotion("working");
    const fade = emitted(250);
    expect(fade.some((fr) => fr.face.actors === "coffee" && fr.face.from?.map === "coffeeHold")).toBe(
      true,
    );
    stepFor(200);
    const gone = stepped(1000);
    expect(gone).toBeGreaterThanOrEqual(9);
    expect(gone).toBeLessThanOrEqual(11);
    expect(emitted(200).every((fr) => fr.face.actors !== "coffee")).toBe(true);
  });

  test("an emotion other than idle set before its slot holds it back (typing, a reply)", async () => {
    const e = await mount(true);
    stepFor(FIRST - 2000);
    e.setEmotion("listening");
    stepFor(2500);
    const n = stepped(1000);
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(11);
  });

  test("the hologram closed into the token: no coffee while she is the coin's", async () => {
    await mount(true, { tokenOnly: true });
    stepFor(FIRST + 700);
    const n = stepped(1000);
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(11);
  });
});

describe("reduced motion in the morning", () => {
  test("one still frame of her holding the mug, the coffee's drawings in before it; none once the morning ends", async () => {
    const emit = vi.spyOn(Portrait.prototype, "emit");
    const e = await mount(true, { still: true });
    expect(mapsAsked).toEqual(expect.arrayContaining(["app/coffeeHold.png", "app/coffeeSip.png"]));
    // no loop runs under the still frame
    expect(frames.size).toBe(0);
    const first = emit.mock.calls.map((c) => c[0]);
    expect(first.length).toBeGreaterThan(0);
    for (const fr of first) {
      expect(fr.still).toBe(true);
      expect(fr.held).toBe(true);
      expect(fr.face.map).toBe("coffeeHold");
      expect(fr.face.hand).toEqual({ map: "coffeeHold", rise: 0, di: 0, p: 1 });
      expect(fr.face.eyes).toBe("soft");
      expect(fr.face.mouth).toBe("smile");
      expect(fr.lid).toBeCloseTo(0.22, 5);
    }
    emit.mockClear();
    e.setMorning(false);
    const after = emit.mock.calls.map((c) => c[0]);
    // her settled frame's unchanging dots are emitted again without the mug
    expect(after.some((fr) => fr.face.map !== "coffeeHold")).toBe(true);
    expect(after.every((fr) => fr.face.actors !== "coffee")).toBe(true);
    expect(frames.size).toBe(0);
    emit.mockRestore();
  });

  test("without the morning the still frame has no mug", async () => {
    const emit = vi.spyOn(Portrait.prototype, "emit");
    await mount(false, { still: true });
    const all = emit.mock.calls.map((c) => c[0]);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((fr) => fr.face.actors !== "coffee" && fr.face.map !== "coffeeHold")).toBe(true);
    emit.mockRestore();
  });
});
