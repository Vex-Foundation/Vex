/**
 * THE VEXING CONSTELLATION — every per-particle constant the loop needs,
 * derived ONCE from the shared sampler.
 *
 * `lib/sigil-sampler.ts` stays the single source of truth for the letterform;
 * this module is its third consumer and adds only what a LOOPING scene needs
 * that the one-shot assembly did not: a scatter seat that is both where a
 * particle flies in FROM and where it disperses back TO, so the cycle closes on
 * itself instead of drifting, plus a bounded stagger expressed as a fraction of
 * the act (the act length lives in `phases.ts`, so a cadence change cannot
 * silently rescale the stagger).
 *
 * Deterministic by construction: one seeded PRNG walked in index order, so a
 * remount rebuilds the identical constellation and the mark never flickers into
 * a different shape between cycles.
 */

import {
  DPR_CAP,
  mulberry32,
  sampleSigilTargets,
} from "../../../lib/sigil-sampler.js";

/** Seed for this scene's PRNG ("VEXN") — distinct from VexSigil's. */
const VEXING_SEED = 0x5645584e;

/** Fraction of an act spent staggering; the rest is a particle's own flight. */
export const STAGGER_FRACTION = 0.35;

export { DPR_CAP };

export interface VexingParticles {
  readonly count: number;
  /** Sample-space dimensions — cover-fit into the box at draw time. */
  readonly width: number;
  readonly height: number;
  readonly targetX: Float32Array;
  readonly targetY: Float32Array;
  /** Scatter seat: the assembly's start AND the dispersal's destination. */
  readonly outX: Float32Array;
  readonly outY: Float32Array;
  /** Per-particle stagger, as a fraction of the act, in [0,1). */
  readonly delay: Float32Array;
  readonly sizePx: Float32Array;
  /** 0 = body tone, 1–2 = the two spark tones (~85/15, as the sigil). */
  readonly colorIdx: Uint8Array;
}

/**
 * Rasterise the loaded monogram once and derive the constellation. Returns
 * null on any sampler failure (no 2D context, unreadable pixels, empty mark) —
 * the caller falls back to the plain <img>, never to an empty field.
 */
export function buildVexingParticles(
  image: HTMLImageElement,
): VexingParticles | null {
  const sample = sampleSigilTargets(image);
  if (sample === null) return null;
  const { width, height, count, coords } = sample;

  const prng = mulberry32(VEXING_SEED);
  const targetX = new Float32Array(count);
  const targetY = new Float32Array(count);
  const outX = new Float32Array(count);
  const outY = new Float32Array(count);
  const delay = new Float32Array(count);
  const sizePx = new Float32Array(count);
  const colorIdx = new Uint8Array(count);

  /** Scatter reference: the mark's half-diagonal (VexSigil's proven value). */
  const scatterRadius = 0.5 * Math.hypot(width, height);
  for (let i = 0; i < count; i++) {
    const tx = coords[i * 2] ?? 0;
    const ty = coords[i * 2 + 1] ?? 0;
    targetX[i] = tx;
    targetY[i] = ty;
    const angle = prng() * Math.PI * 2;
    // 40–120% of the half-diagonal beyond the target — far enough that the
    // mark genuinely dissolves, near enough that it never leaves the box's
    // cover-fit frame as a visible spray.
    const distance = (0.4 + prng() * 0.8) * scatterRadius;
    outX[i] = tx + Math.cos(angle) * distance;
    outY[i] = ty + Math.sin(angle) * distance;
    delay[i] = prng();
    sizePx[i] = 1.6 + prng() * 0.6;
    const roll = prng();
    colorIdx[i] = roll < 0.85 ? 0 : roll < 0.925 ? 1 : 2;
  }

  return {
    count,
    width,
    height,
    targetX,
    targetY,
    outX,
    outY,
    delay,
    sizePx,
    colorIdx,
  };
}
