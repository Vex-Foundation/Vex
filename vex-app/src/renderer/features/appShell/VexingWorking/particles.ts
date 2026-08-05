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
 * THE CLOUD IS RADIAL, AND THAT IS THE POINT (owner: "aby nie było widać ramki
 * kwadratowej z której powstaje"). Seats scattered around each particle's OWN
 * target — VexSigil's one-shot geometry — produce the letterform's bounding box
 * dilated, i.e. a SQUARE halo, and the parts that overflow the box are clipped
 * by the canvas rect, which is the hard edge that was visible. Here every seat
 * is drawn from ONE disc about the mark's centre, sized to sit INSIDE the box,
 * so nothing is ever clipped and the cloud has no edge of any shape. The rim is
 * then feathered — dimmer and smaller particles further out — so the cloud
 * fades into the backdrop instead of ending.
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

/**
 * The scatter disc's radius, in sample space. Deliberately just INSIDE half the
 * mark's shorter side: the canvas cover-fits sample space onto a square box, so
 * anything beyond `0.5 * min(w, h)` would be clipped by the canvas rect and
 * draw exactly the square edge this design exists to remove.
 */
export function scatterRadiusOf(width: number, height: number): number {
  return 0.46 * Math.min(width, height);
}

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
  /**
   * Alpha bucket (0 dim … 2 bright) used while the particle sits near its SEAT.
   * Falls off toward the rim, which is what feathers the cloud's edge. The
   * assembled mark ignores it and paints at the base level, so the letterform
   * itself is never dimmed.
   */
  readonly seatAlphaIdx: Uint8Array;
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
  const seatAlphaIdx = new Uint8Array(count);

  const centreX = width / 2;
  const centreY = height / 2;
  const scatterRadius = scatterRadiusOf(width, height);
  for (let i = 0; i < count; i++) {
    const tx = coords[i * 2] ?? 0;
    const ty = coords[i * 2 + 1] ?? 0;
    targetX[i] = tx;
    targetY[i] = ty;

    // ONE disc about the mark's centre. `sqrt` on the uniform draw is what
    // makes the seats area-uniform: without it they bunch at the middle and
    // the cloud reads as a blob with a gap around it.
    const angle = prng() * Math.PI * 2;
    const normRadius = Math.sqrt(prng());
    const radius = normRadius * scatterRadius;
    outX[i] = centreX + Math.cos(angle) * radius;
    outY[i] = centreY + Math.sin(angle) * radius;

    delay[i] = prng();
    // The feather: rim particles are smaller and dimmer, so the cloud's outer
    // reach fades out rather than terminating on a countable boundary.
    sizePx[i] = (1.6 + prng() * 0.6) * (1 - 0.35 * normRadius);
    seatAlphaIdx[i] = normRadius > 0.72 ? 0 : normRadius > 0.4 ? 1 : 2;
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
    seatAlphaIdx,
    colorIdx,
  };
}
