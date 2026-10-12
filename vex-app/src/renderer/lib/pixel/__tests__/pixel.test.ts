/**
 * The pixel core is deterministic: the generator, the dither and the sprite
 * draw give the same blocks for the same seed, which is what lets a still
 * frame be the same frame on every load. Pure arithmetic only: the canvas
 * side is covered through the flock engine's suite.
 */

import { describe, expect, it } from "vitest";
import { BoundsPlotter, ditherCell, rng, type Plotter } from "../core.js";
import { drawSpriteGrid, type SpriteGrid } from "../sprite.js";

class Recorder implements Plotter {
  readonly rects: [number, number, number, number][] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push([x, y, w, h]);
  }
}

/** A 6 x 4 grid: a solid outline around a dithered body, one open gap. */
function grid(): SpriteGrid {
  const gw = 6;
  const gh = 4;
  const type = new Uint8Array(gw * gh);
  const dens = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const edge = i === 0 || j === 0 || i === gw - 1 || j === gh - 1;
      type[j * gw + i] = edge ? 1 : 2;
      dens[j * gw + i] = 0.5;
    }
  }
  type[1 * gw + 2] = 3;
  return { gw, gh, type, dens };
}

describe("rng", () => {
  it("repeats its sequence for a seed and differs across seeds", () => {
    const a = rng(21);
    const b = rng(21);
    const c = rng(22);
    const sa = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(sa);
    expect([c(), c(), c()]).not.toEqual(sa);
    for (const v of sa) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("ditherCell", () => {
  it("lights none, half and all of the 16 Bayer dots", () => {
    const count = (dens: number) => {
      const r = new Recorder();
      ditherCell(r, 0, 0, 8, dens);
      return r.rects.length;
    };
    expect(count(0)).toBe(0);
    expect(count(0.5)).toBe(8);
    expect(count(1)).toBe(16);
  });
});

describe("drawSpriteGrid", () => {
  it("draws the same blocks for the same seed", () => {
    const a = new Recorder();
    const b = new Recorder();
    const o = { X0: 0, Y0: 0, c: 8, seed: 21, trail: 0.6, trailLen: 12 };
    drawSpriteGrid(a, grid(), o);
    drawSpriteGrid(b, grid(), o);
    expect(b.rects).toEqual(a.rects);
    const c = new Recorder();
    drawSpriteGrid(c, grid(), { ...o, seed: 22 });
    expect(c.rects).not.toEqual(a.rects);
  });

  it("crisp draws the body only: no trail behind it, no stray, no drip", () => {
    const r = new BoundsPlotter();
    drawSpriteGrid(r, grid(), { X0: 80, Y0: 80, c: 8, seed: 3, crisp: true, trail: 1, trailLen: 20, strays: 1, vert: 1 });
    expect(r.minX).toBe(80);
    expect(r.minY).toBe(80);
    expect(r.maxX).toBe(80 + 6 * 8);
    expect(r.maxY).toBe(80 + 4 * 8);
  });

  it("trails run behind the motion (to the left when flying right)", () => {
    const r = new BoundsPlotter();
    drawSpriteGrid(r, grid(), { X0: 400, Y0: 80, c: 8, seed: 3, dir: 1, trail: 1, trailLen: 20, tear: 0, drop: 0, strays: 0, vert: 0 });
    expect(r.minX).toBeLessThan(400);
    expect(r.maxX).toBe(400 + 6 * 8);
  });
});
