/**
 * K2's dots blended in memory (`k2-stamp.ts`), without a canvas, on a synthetic atlas. Regressions
 * this catches: a blend that is not the canvas's source over (premultiplied, an 8-bit alpha like
 * `globalAlpha`) or its destination over (the beam under her), rounding that drifts from x / 255, a
 * dot cut wrongly at the frame's edge or written outside it, a frame not turned back to the straight
 * alpha of `ImageData`, a kept layer that does not start the next frame as it was, and a dot mapped
 * to another sprite or cell than the canvas path draws.
 */
import { describe, expect, test } from "vitest";
import {
  CELL,
  COLS,
  DotRaster,
  div255,
  LITTLE_ENDIAN,
  SpriteRuns,
  scalePixel,
  spriteOf,
} from "../k2-stamp.js";

/** An atlas of `rows` inks, with the given straight-alpha pixels set (sprite, x, y, rgba). */
function atlas(
  rows: number,
  px: readonly (readonly [number, number, number, readonly number[]])[],
): { rgba: Uint8ClampedArray; width: number } {
  const width = CELL * COLS;
  const rgba = new Uint8ClampedArray(width * CELL * rows * 4);
  for (const [s, x, y, c] of px) {
    const i =
      ((Math.floor(s / COLS) * CELL + y) * width + (s % COLS) * CELL + x) * 4;
    rgba.set(c, i);
  }
  return { rgba, width };
}

const pack = (r: number, g: number, b: number, a: number) =>
  (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
const at = (d: Uint8ClampedArray, w: number, x: number, y: number) => [
  ...d.slice((y * w + x) * 4, (y * w + x) * 4 + 4),
];

describe("the blend in memory", () => {
  test("rounds like x / 255, two channels at a time, at any alpha", () => {
    expect(LITTLE_ENDIAN).toBe(true);
    for (let x = 0; x <= 65025; x++)
      expect(div255(x)).toBe(Math.round(x / 255));
    for (let c = 0; c < 256; c += 3)
      for (let a8 = 0; a8 < 256; a8 += 5) {
        const s = scalePixel(pack(c, 255 - c, c >> 1, 255), a8);
        expect(s & 255).toBe(Math.round((c * a8) / 255));
        expect((s >>> 8) & 255).toBe(Math.round(((255 - c) * a8) / 255));
        expect((s >>> 16) & 255).toBe(Math.round(((c >> 1) * a8) / 255));
        expect(s >>> 24).toBe(a8);
      }
  });

  test("an atlas reads back as runs of premultiplied pixels, sprite by sprite", () => {
    const { rgba, width } = atlas(2, [
      [5, 3, 4, [255, 255, 255, 255]],
      [5, 4, 4, [200, 100, 0, 128]],
      [COLS + 9, 0, 13, [10, 20, 30, 255]],
    ]);
    const runs = new SpriteRuns(rgba, width, CELL, 2, COLS);
    expect(runs.start[5]).toBe(0);
    expect(runs.start[6]).toBe(2);
    expect(runs.start[COLS + 9]).toBe(2);
    expect(runs.start[COLS + 10]).toBe(3);
    expect([runs.cx[0], runs.cy[0], runs.px[0]]).toEqual([
      3,
      4,
      pack(255, 255, 255, 255),
    ]);
    expect(runs.px[1]).toBe(pack(100, 50, 0, 128));
    expect([runs.cx[2], runs.cy[2]]).toEqual([0, 13]);
    expect(runs.offsets(100)[1]).toBe(4 * 100 + 4);
  });

  test("source over: opaque replaces, half alpha stacks like the canvas, alpha scales the dot", () => {
    const { rgba, width } = atlas(1, [
      [1, 7, 7, [255, 255, 255, 255]],
      [2, 7, 7, [255, 255, 255, 128]],
      [3, 7, 7, [0, 0, 255, 255]],
    ]);
    const runs = new SpriteRuns(rgba, width, CELL, 1, COLS);
    const r = new DotRaster(40, 40);
    r.put(runs, 3, 10, 10, 255);
    expect(at(r.data, 40, 17, 17)).toEqual([0, 0, 255, 255]);
    r.put(runs, 1, 10, 10, 255);
    expect(at(r.data, 40, 17, 17)).toEqual([255, 255, 255, 255]);
    // two half-alpha whites on nothing: 128, then 128 + 128 x 127 / 255
    r.put(runs, 2, 0, 0, 255);
    expect(at(r.data, 40, 7, 7)).toEqual([128, 128, 128, 128]);
    r.put(runs, 2, 0, 0, 255);
    expect(at(r.data, 40, 7, 7)).toEqual([192, 192, 192, 192]);
    // a white at globalAlpha 0.5 over blue: half of each
    r.put(runs, 3, 20, 20, 255);
    r.put(runs, 1, 20, 20, 128);
    expect(at(r.data, 40, 27, 27)).toEqual([128, 128, 255, 255]);
    // alpha 0 draws nothing
    r.put(runs, 1, 0, 20, 0);
    expect(at(r.data, 40, 7, 27)).toEqual([0, 0, 0, 0]);
  });

  test("destination over: the beam goes under her, only where she lets it through", () => {
    const { rgba, width } = atlas(1, [
      [1, 7, 7, [255, 255, 255, 255]],
      [2, 7, 7, [0, 0, 255, 128]],
    ]);
    const runs = new SpriteRuns(rgba, width, CELL, 1, COLS);
    const r = new DotRaster(30, 30);
    r.put(runs, 1, 0, 0, 255);
    r.put(runs, 2, 0, 0, 255, true);
    expect(at(r.data, 30, 7, 7)).toEqual([255, 255, 255, 255]);
    // on nothing it is the dot itself
    r.put(runs, 2, 10, 10, 255, true);
    expect(at(r.data, 30, 17, 17)).toEqual([0, 0, 128, 128]);
    // under half alpha: d + s x (255 - da) / 255
    r.put(runs, 2, 10, 10, 255);
    const over = at(r.data, 30, 17, 17);
    const r2 = new DotRaster(30, 30);
    r2.put(runs, 2, 10, 10, 255);
    r2.put(runs, 2, 10, 10, 255, true);
    expect(at(r2.data, 30, 17, 17)).toEqual(over);
  });

  test("a dot at the frame's edge keeps its inside pixels and writes nothing outside", () => {
    const corners: [number, number, number, readonly number[]][] = [];
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) corners.push([1, x, y, [0, 0, 0, 255]]);
    const { rgba, width } = atlas(1, corners);
    const runs = new SpriteRuns(rgba, width, CELL, 1, COLS);
    const r = new DotRaster(20, 10);
    r.put(runs, 1, -5, -3, 255);
    r.put(runs, 1, 15, 4, 255);
    r.put(runs, 1, 40, 40, 255);
    const lit = [...r.data.keys()].filter(
      (i) => i % 4 === 3 && (r.data[i] ?? 0) > 0,
    ).length;
    // (14 - 5) x (14 - 3) top left, (20 - 15) x (10 - 4) right; the third is off the frame
    expect(lit).toBe(9 * 10 + 5 * 6);
    expect(r.finish()).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  test("finish turns the touched box to straight alpha; a kept layer starts a frame as it was", () => {
    const { rgba, width } = atlas(1, [
      [1, 7, 7, [200, 100, 0, 128]],
      [2, 7, 7, [255, 255, 255, 255]],
    ]);
    const runs = new SpriteRuns(rgba, width, CELL, 1, COLS);
    const r = new DotRaster(30, 30);
    expect(r.finish()).toBeNull();
    r.put(runs, 1, 5, 5, 255);
    r.put(runs, 2, 6, 5, 255);
    const kept = r.snapshot();
    expect(r.finish()).toEqual({ x: 5, y: 5, w: 15, h: 14 });
    expect(at(r.data, 30, 12, 12)).toEqual([199, 100, 0, 128]);
    expect(at(r.data, 30, 13, 12)).toEqual([255, 255, 255, 255]);
    r.clear();
    expect(at(r.data, 30, 13, 12)).toEqual([0, 0, 0, 0]);
    expect(r.restore(kept)).toBe(true);
    expect(at(r.data, 30, 12, 12)).toEqual([100, 50, 0, 128]);
    expect(r.finish()).toEqual({ x: 5, y: 5, w: 15, h: 14 });
    expect(new DotRaster(10, 10).restore(kept)).toBe(false);
  });

  test("a dot maps to the canvas path's sprite and cell: quarter px radius, half px centre", () => {
    expect(spriteOf(0, 10, 20, 1)).toEqual({ s: 4 * 4 + 0, left: 3, top: 13 });
    expect(spriteOf(2, 10.5, 20.5, 1.5)).toEqual({
      s: 2 * COLS + 6 * 4 + 3,
      left: 3,
      top: 13,
    });
    expect(spriteOf(0, 10.3, 20.2, 2)?.s).toBe(8 * 4 + 1);
    // the largest step caps, a dot under an eighth of a px is not drawn
    expect(spriteOf(0, 0, 0, 40)?.s).toBe(22 * 4);
    expect(spriteOf(0, 0, 0, 0.1)).toBeNull();
  });
});
