/**
 * SIGIL SAMPLER — the monogram → particle-target pipeline, shared.
 *
 * Extracted verbatim from `features/appShell/VexSigil.tsx` (2026-07-27) when
 * the setup gate's cinematic prologue needed the SAME letterform targets:
 * two particle stages sampling the same mark independently would be two
 * sources of truth for the signature's shape. Behavior-preserving — the
 * constants, the alpha threshold, the grid/refine/thin ladder and the PRNG
 * are unchanged, so VexSigil's particle count band and paint palette are
 * byte-identical to before the move.
 *
 * Lives in `lib/` because both consumers are features and import direction
 * is one-way (features → lib). It is pure DOM+math with no React.
 *
 * What is NOT here: the per-particle ASSEMBLY constants (scattered starts,
 * stagger, flight easing). Those describe one animation, and the prologue's
 * acts need entirely different ones — VexSigil keeps its own.
 */

/** Fixed offscreen sampling width — particle count is DPR-independent. */
const SAMPLE_WIDTH = 220;
/** A pixel is part of the mark when its alpha clears this (of 255). */
const ALPHA_THRESHOLD = 128;
/** Default sampling grid step (px in sample space). */
const GRID_STEP = 2;
const MIN_PARTICLES = 1500;
const MAX_PARTICLES = 3000;
/** Stride-thinning lands here when the raw grid overshoots MAX_PARTICLES. */
const THIN_TARGET = 2400;

/** Landing engine caps devicePixelRatio at 1.5. */
export const DPR_CAP = 1.5;

/**
 * A sigil palette is exactly three "r,g,b" canvas-paint channels (JS values,
 * never Tailwind classes): the body tone plus two accent sparks. The
 * constellation paints ~85% body, ~15% sparks.
 */
export type SigilPalette = readonly [string, string, string];

/** Default (VEX) palette — paper #f3f4f7 body with periwinkle cobalt sparks
 * #8ba2ff / #7d92ff (the white signature with cobalt life). */
const PAPER_RGB = "243,244,247";
export const DEFAULT_SIGIL_PALETTE: SigilPalette = [
  PAPER_RGB,
  "139,162,255",
  "125,146,255",
];

/** dim / base / bright — the shimmer flips between the outer two. */
export const ALPHA_LEVELS = [0.75, 0.9, 1] as const;
export const BASE_ALPHA_IDX = 1;

/** Build the 9 fill styles for a palette (styleIdx = colorIdx * 3 + alphaIdx). */
export function buildSigilStyles(palette: SigilPalette): readonly string[] {
  return palette.flatMap((rgb) =>
    ALPHA_LEVELS.map((alpha) => `rgba(${rgb},${alpha})`),
  );
}

/** Tiny deterministic PRNG (mulberry32) — seeded once at sample time. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collect [x0,y0, x1,y1, …] sample-space targets on a `step` grid. */
function collectGridPoints(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  step: number,
): number[] {
  // NOTE (noUncheckedIndexedAccess): every index below is provably in
  // bounds (loop-bounded), so the `?? 0` fallbacks in this module only
  // satisfy the compiler and never fire.
  const coords: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > ALPHA_THRESHOLD) {
        coords.push(x, y);
      }
    }
  }
  return coords;
}

/** The mark's letterform targets in SAMPLE space. */
export interface SigilSample {
  /** Sample-space dimensions (cover-fit into a box at draw time). */
  readonly width: number;
  readonly height: number;
  readonly count: number;
  /** Flat [x0,y0, x1,y1, …], length === count * 2. */
  readonly coords: readonly number[];
}

/**
 * ONE-time sampling: rasterize the loaded monogram at the working
 * resolution and read its ImageData once. Opaque pixels on a 2px grid
 * become targets; the grid refines to 1px for sparse art and dense results
 * are stride-thinned so the count lands in the 1500–3000 band.
 *
 * Returns null when sampling is impossible (no 2D context, unreadable
 * pixels, empty mark) — every caller treats that as "fall back", never as
 * an empty constellation.
 */
export function sampleSigilTargets(image: HTMLImageElement): SigilSample | null {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) return null;

  const sampleW = SAMPLE_WIDTH;
  const sampleH = Math.max(
    1,
    Math.round((naturalHeight / naturalWidth) * SAMPLE_WIDTH),
  );
  const offscreen = document.createElement("canvas");
  offscreen.width = sampleW;
  offscreen.height = sampleH;
  let sampleCtx: CanvasRenderingContext2D | null = null;
  try {
    sampleCtx = offscreen.getContext("2d", { willReadFrequently: true });
  } catch {
    sampleCtx = null;
  }
  if (sampleCtx === null) return null;

  sampleCtx.drawImage(image, 0, 0, sampleW, sampleH);
  let data: Uint8ClampedArray;
  try {
    data = sampleCtx.getImageData(0, 0, sampleW, sampleH).data;
  } catch {
    // Unreadable pixels (e.g. a tainted canvas) — surface as fallback.
    return null;
  }

  let coords = collectGridPoints(data, sampleW, sampleH, GRID_STEP);
  if (coords.length / 2 < MIN_PARTICLES) {
    coords = collectGridPoints(data, sampleW, sampleH, 1);
  }
  let count = coords.length / 2;
  if (count === 0) return null;
  if (count > MAX_PARTICLES) {
    const stride = count / THIN_TARGET;
    const thinned: number[] = [];
    for (let k = 0; Math.floor(k * stride) < count; k++) {
      const i = Math.floor(k * stride);
      thinned.push(coords[i * 2] ?? 0, coords[i * 2 + 1] ?? 0);
    }
    coords = thinned;
    count = coords.length / 2;
  }

  return { width: sampleW, height: sampleH, count, coords };
}
