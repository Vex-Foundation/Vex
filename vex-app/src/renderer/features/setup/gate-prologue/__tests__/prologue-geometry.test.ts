/**
 * Prologue geometry — the fibonacci lattice and the Y-rotation projection.
 *
 * Properties, not fixtures: every lattice point must land ON the unit sphere,
 * the distribution must not clump at a pole, and rotation must preserve the
 * radius while moving depth. These catch the sign and normalisation mistakes
 * that make a "globe" read as a flat ring.
 */

import { describe, expect, it } from "vitest";

import {
  fibonacciSpherePoint,
  rotateYProject,
} from "../prologue-geometry.js";

const COUNT = 2000;

describe("fibonacciSpherePoint", () => {
  it("places every point on the unit sphere", () => {
    for (const i of [0, 1, 7, 500, 1999]) {
      const p = fibonacciSpherePoint(i, COUNT);
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 6);
    }
  });

  it("spreads latitudes across the full sphere without occupying a pole", () => {
    const first = fibonacciSpherePoint(0, COUNT);
    const last = fibonacciSpherePoint(COUNT - 1, COUNT);
    expect(first.y).toBeGreaterThan(0.99);
    expect(first.y).toBeLessThan(1);
    expect(last.y).toBeLessThan(-0.99);
    expect(last.y).toBeGreaterThan(-1);
  });

  it("distributes points evenly between the hemispheres", () => {
    let north = 0;
    for (let i = 0; i < COUNT; i++) {
      if (fibonacciSpherePoint(i, COUNT).y > 0) north++;
    }
    expect(north).toBe(COUNT / 2);
  });

  it("is deterministic — same index, same point, no PRNG", () => {
    expect(fibonacciSpherePoint(42, COUNT)).toEqual(
      fibonacciSpherePoint(42, COUNT),
    );
  });

  it("degrades to the origin for an empty lattice instead of dividing by zero", () => {
    expect(fibonacciSpherePoint(0, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("rotateYProject", () => {
  it("is the identity projection at angle 0", () => {
    const p = { x: 0.6, y: 0.5, z: 0.8 };
    const r = rotateYProject(p, 0);
    expect(r.x).toBeCloseTo(0.6, 6);
    expect(r.y).toBeCloseTo(0.5, 6);
    expect(r.depth).toBeCloseTo(0.8, 6);
  });

  it("swings x into depth at a quarter turn", () => {
    const r = rotateYProject({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 6);
    expect(r.depth).toBeCloseTo(-1, 6);
  });

  it("preserves the point's distance from the Y axis (a rigid rotation)", () => {
    const p = fibonacciSpherePoint(137, COUNT);
    for (const angle of [0.3, 1.1, 2.7, 5.9]) {
      const r = rotateYProject(p, angle);
      expect(Math.hypot(r.x, r.depth)).toBeCloseTo(Math.hypot(p.x, p.z), 6);
      expect(r.y).toBe(p.y);
    }
  });

  it("keeps the projected silhouette inside the unit circle", () => {
    for (let i = 0; i < 200; i++) {
      const r = rotateYProject(fibonacciSpherePoint(i, 200), i * 0.11);
      expect(Math.hypot(r.x, r.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
