/**
 * PROLOGUE GEOMETRY — the globe act's maths, isolated and pure.
 *
 * Act II parks every particle on a sphere and spins it. Two pieces:
 *
 *   1. A fibonacci lattice, which is the standard way to place N points
 *      near-uniformly on a sphere without the pole clustering a naive
 *      lat/long grid produces. Point `i` is derived from `i` alone, so the
 *      distribution is deterministic with no PRNG and no allocation.
 *   2. Rotation about Y plus an ORTHOGRAPHIC projection — no perspective
 *      divide, which keeps the silhouette a true circle (a planet framed
 *      too close) and keeps the maths branch-free.
 *
 * Depth is returned rather than applied: the renderer uses it to dim the
 * far hemisphere, which is what reads as a solid rotating body instead of a
 * flat ring of dots.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Golden angle — π(3−√5). The lattice's angular step. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Point `index` of a `count`-point fibonacci lattice on the UNIT sphere.
 * Points are offset by a half step so neither pole is occupied exactly.
 */
export function fibonacciSpherePoint(index: number, count: number): Vec3 {
  if (count <= 0) return { x: 0, y: 0, z: 0 };
  // y walks (1 … −1) exclusive; r is the circle radius at that latitude.
  const y = 1 - (2 * index + 1) / count;
  const clampedY = y > 1 ? 1 : y < -1 ? -1 : y;
  const r = Math.sqrt(Math.max(0, 1 - clampedY * clampedY));
  const theta = GOLDEN_ANGLE * index;
  return { x: Math.cos(theta) * r, y: clampedY, z: Math.sin(theta) * r };
}

export interface ProjectedPoint {
  /** Unit-space screen coordinates, before radius scaling. */
  readonly x: number;
  readonly y: number;
  /** Rotated z: +1 nearest the camera, −1 farthest. */
  readonly depth: number;
}

/** Rotate about the Y axis, then project orthographically. */
export function rotateYProject(point: Vec3, angleRad: number): ProjectedPoint {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x * cos + point.z * sin,
    y: point.y,
    depth: point.z * cos - point.x * sin,
  };
}
