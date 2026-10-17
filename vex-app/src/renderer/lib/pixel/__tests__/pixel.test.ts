/**
 * The pixel core is deterministic: the generator and the dither give the same
 * blocks for the same seed, which is what lets a still frame be the same
 * frame on every load. Pure arithmetic only: the canvas side is exercised by
 * the K2 engine's suites, which draw through `createCanvas` and `BAYER`.
 */

import { describe, expect, it } from "vitest";
import { BoundsPlotter, ditherCell, rng, type Plotter } from "../core.js";

class Recorder implements Plotter {
  readonly rects: [number, number, number, number][] = [];
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push([x, y, w, h]);
  }
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

describe("BoundsPlotter", () => {
  it("starts empty and grows to the box of everything plotted", () => {
    const r = new BoundsPlotter();
    expect(r.empty).toBe(true);
    r.fillRect(80, 40, 8, 8);
    r.fillRect(120, 64, 4, 4);
    expect(r.empty).toBe(false);
    expect([r.minX, r.minY, r.maxX, r.maxY]).toEqual([80, 40, 124, 68]);
  });

  it("bounds a dithered cell inside the cell it was given", () => {
    const r = new BoundsPlotter();
    ditherCell(r, 16, 24, 8, 1);
    expect(r.minX).toBeGreaterThanOrEqual(16);
    expect(r.minY).toBeGreaterThanOrEqual(24);
    expect(r.maxX).toBeLessThanOrEqual(24);
    expect(r.maxY).toBeLessThanOrEqual(32);
  });
});
