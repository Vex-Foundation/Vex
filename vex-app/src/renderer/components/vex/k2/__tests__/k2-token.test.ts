/**
 * The token's states (`k2-token.ts`), with the shipped sheet layout and stubbed bitmaps (jsdom has
 * no decoder). Regressions this catches: a coin that does not lift under the pointer or stays up
 * after it leaves; a sleep dim that brightens, goes past its floor or leaks its filter into her
 * dots; the poses loaded when only the flat coin is needed, or not loaded for the reverse flip; a
 * failed pose sheet that takes the coin away instead of leaving it flat; a reverse flip that draws
 * other poses than the turn to flat; a lifted coin whose frame box does not grow and rise with it;
 * a 30 fps turn that jumps from pose to pose instead of gliding (the face's ellipse not continuous
 * in the turn); an ellipse that misses a pose at its own turn, the face-on rest at 0 or the flat
 * coin at 1; and a stretched pose whose face does not land on that ellipse, or a placed coin whose
 * frame box and cone base disagree.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CoinCanvas,
  frameFor,
  LIFT,
  liftOf,
  stretchOnto,
  type TokenSheet,
  TokenSprite,
  TOKEN_DIM,
  tokenBrightness,
  turnGeometry,
} from "../k2-token.js";
import { isTokenSheet } from "../k2-assets.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw: unknown = JSON.parse(
  readFileSync(join(here, "../../../../public/art/vex-k2/token.json"), "utf8"),
);
if (!isTokenSheet(raw)) throw new Error("token.json does not match the sheet layout");
const SHEET: TokenSheet = raw;

/** Serves the sheet's layout and blank bitmaps, recording every file asked for. */
function stubArt(fail: readonly string[] = []): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const file = url.split("/").pop() ?? "";
      asked.push(file);
      if (fail.includes(file)) return new Response(null, { status: 404 });
      if (file === "token.json") return new Response(JSON.stringify(SHEET));
      return new Response(new Blob([new Uint8Array([0])]));
    }),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close: () => undefined })),
  );
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const FLAT = { flip: 1, press: 0, tiltX: 0, tiltY: 0 };
const FACE_ON = { flip: 0, press: 0, tiltX: 0, tiltY: 0 };

describe("the hover lift", () => {
  test("rises over 220 ms once the pointer is on the coin and sinks over 260 ms after", () => {
    expect(liftOf(false, -1, -1)).toBe(0);
    expect(liftOf(true, 0, -1)).toBe(0);
    expect(liftOf(true, LIFT.up / 2, -1)).toBeGreaterThan(0.5);
    expect(liftOf(true, LIFT.up, -1)).toBe(1);
    expect(liftOf(true, 5000, -1)).toBe(1);
    expect(liftOf(false, -1, 0)).toBe(1);
    expect(liftOf(false, -1, LIFT.down / 2)).toBeLessThan(0.5);
    expect(liftOf(false, -1, LIFT.down)).toBe(0);
  });

  test("raises the coin by 3.5% of its diameter and grows it by 2.5%", async () => {
    stubArt();
    const coin = new TokenSprite();
    await coin.load(false, 1);
    const rest = coin.place(100, 200, 58, 0, FLAT);
    const up = coin.place(100, 200, 58, 0, { ...FLAT, lift: 1 });
    expect(rest).not.toBeNull();
    expect(up?.w).toBeCloseTo((rest?.w ?? 0) * (1 + LIFT.grow), 5);
    expect(up?.h).toBeCloseTo((rest?.h ?? 0) * (1 + LIFT.grow), 5);
    // centred on the same point, then lifted
    const mid = (p: typeof rest) => (p?.x ?? 0) + (p?.w ?? 0) / 2;
    expect(mid(up)).toBeCloseTo(mid(rest), 5);
    const drop = (p: typeof rest) => (p?.y ?? 0) + ((SHEET.box / 2 - 6) / SHEET.box) * (p?.h ?? 0);
    expect(drop(rest) - drop(up)).toBeCloseTo(LIFT.rise * 58, 5);
  });
});

describe("the sleep dim", () => {
  test("darkens the coin to 0.775 at the deepest sleep, never past it, never brighter", () => {
    expect(tokenBrightness(0)).toBe(1);
    expect(tokenBrightness(1)).toBeCloseTo(1 - 0.5 * TOKEN_DIM, 5);
    expect(tokenBrightness(1)).toBeCloseTo(0.775, 5);
    expect(tokenBrightness(2)).toBeCloseTo(0.775, 5);
    expect(tokenBrightness(-1)).toBe(1);
    expect(tokenBrightness(0.5)).toBeGreaterThan(tokenBrightness(1));
  });

  test("paints through a brightness filter only while dimmed, and leaves the context as it was", async () => {
    stubArt();
    const coin = new TokenSprite();
    await coin.load(false, 1);
    const placed = coin.place(100, 200, 58, 0, FLAT);
    if (placed === null) throw new Error("no coin placed");
    const calls: string[] = [];
    let filter = "none";
    const ctx: CoinCanvas = {
      save: () => calls.push("save"),
      restore: () => {
        calls.push("restore");
        filter = "none";
      },
      drawImage: () => calls.push(`draw:${filter}`),
      get filter() {
        return filter;
      },
      set filter(v: string) {
        filter = v;
      },
    };
    coin.paint(ctx, placed);
    expect(calls).toEqual(["draw:none"]);
    calls.length = 0;
    coin.paint(ctx, placed, 1);
    expect(calls).toEqual(["save", "draw:brightness(0.775)", "restore"]);
    expect(filter).toBe("none");
  });
});

describe("the poses and the reverse flip", () => {
  test("the flat coin alone loads without the poses; the poses load once, on demand", async () => {
    const asked = stubArt();
    const coin = new TokenSprite();
    await coin.load(false, 1);
    expect(asked).toEqual(["token.json", "token-flat-1x.webp"]);
    expect(coin.posed).toBe(false);
    // without its poses a face-on coin is drawn flat
    expect(coin.place(100, 200, 58, 0, FACE_ON)?.n).toBe(-1);
    await coin.loadPoses();
    await coin.loadPoses();
    expect(coin.posed).toBe(true);
    expect(asked.filter((f) => f === "token-wake-1x.webp")).toHaveLength(1);
    expect(coin.place(100, 200, 58, 0, FACE_ON)?.n).toBeGreaterThanOrEqual(0);
    expect(coin.place(100, 200, 58, 0, FLAT)?.n).toBe(-1);
  });

  test("the wake or an episode loads the poses with the coin, at the screen's density", async () => {
    const asked = stubArt();
    await new TokenSprite().load(true, 2);
    expect([...asked].sort()).toEqual(["token-flat-2x.webp", "token-wake-2x.webp", "token.json"]);
  });

  test("a pose sheet that fails leaves the coin flat, not gone", async () => {
    stubArt(["token-wake-1x.webp"]);
    const coin = new TokenSprite();
    await coin.load(true, 1);
    expect(coin.ready).toBe(true);
    expect(coin.posed).toBe(false);
    expect(coin.place(100, 200, 58, 0, FACE_ON)?.n).toBe(-1);
  });

  test("turning back face-on runs the turn to flat backward, pose for pose", () => {
    const steps = Array.from({ length: 25 }, (_, n) => n / 24);
    const forward = steps.map((f) => frameFor(SHEET.frames, f, 0, 0, 0));
    const backward = [...steps].reverse().map((f) => frameFor(SHEET.frames, f, 0, 0, 0));
    expect(backward).toEqual([...forward].reverse());
    // it ends face-on and starts flat
    expect(backward[0]).toBe(-1);
    expect(SHEET.frames[backward.at(-1) ?? -1]?.kind).toBe("tilt");
  });
});

const TURN = SHEET.frames.filter((f) => f.kind === "flip").sort((a, b) => a.flip - b.flip);
const REST = SHEET.frames.find((f) => f.kind === "tilt" && f.tiltX === 0 && f.tiltY === 0);

describe("the coin's turn", () => {
  test("the sheet has the face-on rest, eleven turn poses and the flat coin", () => {
    expect(REST).toBeDefined();
    expect(TURN.length).toBe(11);
    expect(SHEET.flat.flip).toBe(1);
  });

  test("the ellipse meets each pose at its own turn, the face-on rest at 0 and the flat coin at 1", () => {
    for (const f of TURN) {
      const g = turnGeometry(SHEET, f.flip);
      expect(g.cx).toBeCloseTo(f.cx, 6);
      expect(g.cy).toBeCloseTo(f.cy, 6);
      expect(g.rx).toBeCloseTo(f.rx, 6);
      expect(g.ry).toBeCloseTo(f.ry, 6);
    }
    const face = turnGeometry(SHEET, 0);
    expect(face.ry).toBeCloseTo(REST?.ry ?? -1, 6);
    expect(face.cy).toBeCloseTo(REST?.cy ?? -1, 6);
    const flat = turnGeometry(SHEET, 1);
    expect(flat.ry).toBeCloseTo(SHEET.flat.ry, 6);
    expect(flat.cy).toBeCloseTo(SHEET.flat.cy, 6);
    // outside 0..1 it holds the ends
    expect(turnGeometry(SHEET, -0.5)).toEqual(face);
    expect(turnGeometry(SHEET, 1.5)).toEqual(flat);
  });

  test("it glides: continuous through the turn, the face sinking all the way and narrowing to flat", () => {
    let prev = turnGeometry(SHEET, 0);
    let jump = 0;
    expect(turnGeometry(SHEET, 1).ry).toBeLessThan(prev.ry / 2);
    for (let n = 1; n <= 1000; n++) {
      const g = turnGeometry(SHEET, n / 1000);
      expect(g.cy).toBeGreaterThanOrEqual(prev.cy - 1e-9);
      // past the first poses (the perspective widens it a hair at first) it only narrows
      expect(n < 170 || g.ry <= prev.ry + 1e-9).toBe(true);
      jump = Math.max(jump, Math.abs(g.ry - prev.ry), Math.abs(g.cy - prev.cy));
      prev = g;
    }
    // the steepest step of a 1/1000 turn is under 0.05 css px (a pose apart is about 2 px)
    expect(jump).toBeLessThan(0.05);
    // halfway between two poses it is halfway between their ellipses
    const a = TURN[4];
    const b = TURN[5];
    const mid = turnGeometry(SHEET, ((a?.flip ?? 0) + (b?.flip ?? 0)) / 2);
    expect(mid.ry).toBeCloseTo(((a?.ry ?? 0) + (b?.ry ?? 0)) / 2, 6);
  });

  test("the nearest pose, stretched, puts its face on the turn's ellipse", () => {
    const flip = 0.46;
    const n = frameFor(SHEET.frames, flip, 0, 0, 0);
    const pose = SHEET.frames[n];
    expect(pose?.kind).toBe("flip");
    if (pose === undefined) throw new Error("no pose");
    const g = turnGeometry(SHEET, flip);
    const r = stretchOnto(pose, g, SHEET.box);
    const sx = r.w / SHEET.box;
    const sy = r.h / SHEET.box;
    // the pose's face centre and rim land on the ellipse
    expect(r.x + pose.cx * sx).toBeCloseTo(g.cx, 6);
    expect(r.y + pose.cy * sy).toBeCloseTo(g.cy, 6);
    expect(pose.rx * sx).toBeCloseTo(g.rx, 6);
    expect(pose.ry * sy).toBeCloseTo(g.ry, 6);
    // a pose at its own turn is drawn as it is
    expect(stretchOnto(pose, pose, SHEET.box)).toEqual({
      x: 0,
      y: 0,
      w: SHEET.box,
      h: SHEET.box,
    });
  });

  test("a coin placed mid-turn is that pose stretched onto the turn, its cone base the ellipse", async () => {
    stubArt();
    const coin = new TokenSprite();
    await coin.load(true, 1);
    const d = 58;
    const q = d / SHEET.td;
    // the frame box of the coin's resting centre, as `place` lays it out
    const bx = 100 - (SHEET.box / 2) * q;
    const by = 200 - (SHEET.box / 2 - 6) * q;
    const turn = (flip: number, lift = 0) =>
      coin.place(100, 200, d, 0, { flip, press: 0, tiltX: 0, tiltY: 0, lift });
    const mid = turn(0.46);
    const pose = SHEET.frames[mid?.n ?? -1];
    if (mid === null || pose === undefined) throw new Error("no coin placed");
    expect(pose.kind).toBe("flip");
    const g = turnGeometry(SHEET, 0.46);
    // the base is the turn's ellipse on her map, not the pose's
    expect(mid.base.cx).toBeCloseTo(bx + g.cx * q, 5);
    expect(mid.base.cy).toBeCloseTo(by + g.cy * q, 5);
    expect(mid.base.rx).toBeCloseTo(g.rx * q, 5);
    expect(mid.base.ry).toBeCloseTo(g.ry * q, 5);
    // the stretched frame puts the pose's face exactly on that base, and is no longer square
    const sx = mid.w / (SHEET.box * q);
    const sy = mid.h / (SHEET.box * q);
    expect(mid.x + pose.cx * q * sx).toBeCloseTo(mid.base.cx, 5);
    expect(mid.y + pose.cy * q * sy).toBeCloseTo(mid.base.cy, 5);
    expect(pose.rx * q * sx).toBeCloseTo(mid.base.rx, 5);
    expect(pose.ry * q * sy).toBeCloseTo(mid.base.ry, 5);
    expect(Math.abs(mid.w - mid.h)).toBeGreaterThan(0.01);
    // at a pose's own turn the frame is drawn as it is: square, on its box
    const own = TURN[4];
    const at = turn(own?.flip ?? -1);
    expect(at?.n).toBe(SHEET.frames.findIndex((f) => f === own));
    expect(at?.w).toBeCloseTo(SHEET.box * q, 5);
    expect(at?.h).toBeCloseTo(SHEET.box * q, 5);
    expect(at?.x).toBeCloseTo(bx, 5);
    expect(at?.y).toBeCloseTo(by, 5);
    // the lift grows the stretched frame and its base together
    const up = turn(0.46, 1);
    expect(up?.w).toBeCloseTo(mid.w * (1 + LIFT.grow), 5);
    expect(up?.h).toBeCloseTo(mid.h * (1 + LIFT.grow), 5);
    expect(up?.base.rx).toBeCloseTo(mid.base.rx * (1 + LIFT.grow), 5);
    expect(up?.base.ry).toBeCloseTo(mid.base.ry * (1 + LIFT.grow), 5);
  });
});
