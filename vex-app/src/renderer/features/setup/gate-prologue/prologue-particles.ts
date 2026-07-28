/**
 * PROLOGUE PARTICLE MODEL — every per-particle constant the cold open needs.
 *
 * Split from `GatePrologue.tsx` so the renderer owns only the acts: this
 * module answers "where does particle i live in each of the three worlds",
 * the renderer answers "which world are we in right now, and how far".
 *
 * Each particle carries three positions plus its paint constants:
 *
 *   • the LETTERFORM target, normalised to the mark box, so one number
 *     scales it from the hero size down into the loader ring;
 *   • its seat on the unit sphere (fibonacci lattice, index-derived);
 *   • its STAR-FIELD seat, normalised to the viewport so a resize cannot
 *     strand a particle off screen.
 *
 * The letterform targets come from the SAME sampler VexSigil uses
 * (`lib/sigil-sampler.ts`) — the mark's shape has exactly one source. All
 * randomness is one seeded PRNG stream consumed in index order, so a given
 * build always draws the identical constellation.
 */

import {
  mulberry32,
  sampleSigilTargets,
} from "../../../lib/sigil-sampler.js";
import { fibonacciSpherePoint } from "./prologue-geometry.js";

/** Seed for the prologue's own particle roll ("VEXP"). */
const PROLOGUE_SEED = 0x56455850;
/** Stagger consumes at most this much of the flight, so all land in time. */
const MAX_STAGGER_FRACTION = 0.45;

export interface PrologueParticles {
  readonly count: number;
  /** Letterform targets, normalised to the mark box (both axes ÷ sample width). */
  readonly normX: Float32Array;
  readonly normY: Float32Array;
  /** Unit-sphere lattice position. */
  readonly sphX: Float32Array;
  readonly sphY: Float32Array;
  readonly sphZ: Float32Array;
  /** Star-field position, normalised to the viewport (0…1). */
  readonly starX: Float32Array;
  readonly starY: Float32Array;
  /** Per-particle break-orbit stagger, as a fraction of the act (0…0.45). */
  readonly delay: Float32Array;
  readonly sizePx: Float32Array;
  /** Palette channel: 0 body, 1–2 sparks (~85/15 split, as the sigil). */
  readonly colorIdx: Uint8Array;
}

/**
 * Sample the monogram and derive the particle set. Returns null whenever
 * the shared sampler cannot produce a mark (no 2D context, unreadable
 * pixels, empty sample) — the caller treats that as "skip the prologue".
 */
export function buildPrologueParticles(
  image: HTMLImageElement,
): PrologueParticles | null {
  const sample = sampleSigilTargets(image);
  if (sample === null) return null;
  const { width, height, count, coords } = sample;

  const prng = mulberry32(PROLOGUE_SEED);
  const normX = new Float32Array(count);
  const normY = new Float32Array(count);
  const sphX = new Float32Array(count);
  const sphY = new Float32Array(count);
  const sphZ = new Float32Array(count);
  const starX = new Float32Array(count);
  const starY = new Float32Array(count);
  const delay = new Float32Array(count);
  const sizePx = new Float32Array(count);
  const colorIdx = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    // NOTE (noUncheckedIndexedAccess): every index is loop-bounded, so the
    // `?? 0` fallbacks only satisfy the compiler and never fire.
    // Normalise BOTH axes by the sample WIDTH so the mark keeps its aspect.
    normX[i] = ((coords[i * 2] ?? 0) - width / 2) / width;
    normY[i] = ((coords[i * 2 + 1] ?? 0) - height / 2) / width;

    const p = fibonacciSpherePoint(i, count);
    sphX[i] = p.x;
    sphY[i] = p.y;
    sphZ[i] = p.z;

    starX[i] = prng();
    starY[i] = prng();
    delay[i] = prng() * MAX_STAGGER_FRACTION;
    sizePx[i] = 1.5 + prng() * 0.7;
    const roll = prng();
    colorIdx[i] = roll < 0.85 ? 0 : roll < 0.925 ? 1 : 2;
  }

  return {
    count,
    normX,
    normY,
    sphX,
    sphY,
    sphZ,
    starX,
    starY,
    delay,
    sizePx,
    colorIdx,
  };
}
