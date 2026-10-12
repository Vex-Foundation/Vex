/**
 * A sprite (bird, eagle, any RGBA image) rebuilt as white pixel blocks with
 * dithered motion trails: the look of the VEX prints, where the animals are
 * pixels and the photograph never is.
 *
 * Split in two so motion can cache the expensive part:
 *   spriteGrid()      downsample and classify (needs getImageData; cache it
 *                     per pose and size)
 *   drawSpriteGrid()  the seeded tears, drops, trails, drips and strays
 *                     (cheap, re-seeded every frame step)
 *
 * Pixelation happens here, never in the image file.
 */

import {
  type PixelSource,
  type Plotter,
  context2d,
  createCanvas,
  ditherCell,
  rng,
  smoothstep,
  sourceSize,
} from "./core.js";

/** How luminance (and alpha) are read from the source pixels. */
export type LumaMode =
  /** Blue and lavender RGBA sprites (the far birds): L = (R + G) / 510, alpha from the file. */
  | "rg"
  /** White on black sources: alpha = smoothstep(0.08, 0.30, luma), L = luma. */
  | "white-on-black"
  /** White RGBA sprites with their alpha extracted (the eagle): alpha from the file, L = luma. */
  | "luma";

export interface SpriteGridOptions {
  /** Sprite width in CSS px. */
  readonly w: number;
  /** CSS px per block. */
  readonly cell: number;
  /** Mirror horizontally (sources that face left, so the animal flies right). */
  readonly flip?: boolean;
  /** Alpha threshold below which a cell is empty (0.42). */
  readonly athr?: number;
  /** Luminance below which a cell is shadow (0.40). */
  readonly dark?: number;
  /** Lattice mode: silhouette edge solid, interior opens up. */
  readonly lattice?: boolean;
  /** Natural lattice: highlights solid, shadows a sparse dither, deepest shadow open. */
  readonly natural?: boolean;
  /** Natural: probability a shadow cell opens into a gap (0.22 near, 0.30 far). */
  readonly shadowOpen?: number;
  /** Natural: dither density of the remaining shadow cells (0.45 to 0.5). */
  readonly shadow?: number;
  /** Non natural lattice: luminance above which a cell opens (0.72). */
  readonly open?: number;
  /** Non natural lattice: mid tone dither density (0.42). */
  readonly mid?: number;
  readonly lumaMode?: LumaMode;
}

export interface SpriteGrid {
  readonly gw: number;
  readonly gh: number;
  /** 0 empty, 1 solid, 2 dither, 3 open gap. */
  readonly type: Uint8Array;
  readonly dens: Float32Array;
}

export function spriteGrid(img: PixelSource, o: SpriteGridOptions): SpriteGrid {
  const { width: iw, height: ih } = sourceSize(img);
  const cell = o.cell;
  const gw = Math.max(4, Math.round(o.w / cell));
  const gh = Math.max(3, Math.round((gw * ih) / iw));
  const off = createCanvas(gw, gh);
  const oc = context2d(off, true);
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = "high";
  if (o.flip === true) {
    oc.translate(gw, 0);
    oc.scale(-1, 1);
  }
  oc.drawImage(img, 0, 0, gw, gh);
  const d = oc.getImageData(0, 0, gw, gh).data;
  const type = new Uint8Array(gw * gh);
  const dens = new Float32Array(gw * gh);
  const athr = o.athr ?? 0.42;
  const dark = o.dark ?? 0.4;
  const mode = o.lumaMode ?? "rg";
  const lum = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = (j * gw + i) * 4;
      const r = d[k] ?? 0;
      const g = d[k + 1] ?? 0;
      const b = d[k + 2] ?? 0;
      let a = (d[k + 3] ?? 0) / 255;
      let L: number;
      if (mode === "rg") {
        L = (r + g) / 510;
      } else {
        L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (mode === "white-on-black") a = smoothstep(0.08, 0.3, L);
      }
      if (a < athr) continue;
      lum[j * gw + i] = L;
      if (L < dark) {
        type[j * gw + i] = 1;
      } else {
        type[j * gw + i] = 2;
        dens[j * gw + i] = Math.min(1, 0.38 + (1 - L) * 0.55);
      }
    }
  }
  if (o.lattice === true) {
    const filled = (i: number, j: number) =>
      i >= 0 && j >= 0 && i < gw && j < gh && (type[j * gw + i] ?? 0) > 0;
    const t2 = type.slice();
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (!type[k]) continue;
        const edge =
          !filled(i - 1, j) ||
          !filled(i + 1, j) ||
          !filled(i, j - 1) ||
          !filled(i, j + 1);
        const L = lum[k] ?? 0;
        if (edge) {
          t2[k] = 1;
          continue;
        }
        if (o.natural === true) {
          if (L >= dark) {
            t2[k] = 1;
            continue;
          }
          const h = ((i * 73856093) ^ (j * 19349663)) >>> 0;
          if ((h % 100) / 100 < (o.shadowOpen ?? 0.35)) {
            t2[k] = 3;
            continue;
          }
          t2[k] = 2;
          dens[k] = o.shadow ?? 0.5;
          continue;
        }
        if (L >= (o.open ?? 0.72)) {
          t2[k] = 3;
          continue;
        }
        if (L >= dark) {
          t2[k] = 2;
          dens[k] = o.mid ?? 0.42;
          continue;
        }
        t2[k] = 1;
      }
    }
    type.set(t2);
  }
  return { gw, gh, type, dens };
}

export interface SpriteDrawOptions {
  /** Top left in device px (already snapped). */
  readonly X0: number;
  readonly Y0: number;
  /** Device px per block (already snapped: Math.round(cell * dpr)). */
  readonly c: number;
  readonly seed?: number;
  /** +1 flying right (trails to the left), -1 flying left. */
  readonly dir?: number;
  /**
   * Frozen and sharp: the body only, no tears, drops, trails, drips or
   * strays. The held line of a pending approval.
   */
  readonly crisp?: boolean;
  /** Probability a row tears one cell against the motion (0.04 near, 0.10 far). */
  readonly tear?: number;
  /** Probability a cell drops to sparse dither (0.025 near, 0.05 far). */
  readonly drop?: number;
  /** Stray blocks, as a fraction of grid cells (0.003 near, 0.006 far). */
  readonly strays?: number;
  /** Probability a column grows a dotted drip (0.07 near, 0.10 far). */
  readonly vert?: number;
  /** Fraction of rows with a motion trail (0.30 to 0.70). */
  readonly trail?: number;
  /** Trail length scale in cells (6 to 22). */
  readonly trailLen?: number;
}

/** Draw a classified grid with seeded glitches and trails. Same seed, same pixels. */
export function drawSpriteGrid(
  ctx: Plotter,
  g: SpriteGrid,
  o: SpriteDrawOptions,
): void {
  const { gw, gh, type, dens } = g;
  const { X0, Y0, c } = o;
  const crisp = o.crisp === true;
  const R = rng(o.seed ?? 1);
  const dir = o.dir ?? 1;
  // row tears: shift a few rows by one cell against the motion
  const shift = new Int8Array(gh);
  if (!crisp) {
    for (let j = 0; j < gh; j++) if (R() < (o.tear ?? 0.1)) shift[j] = -dir;
  }
  const drop = o.drop ?? 0.05;
  for (let j = 0; j < gh; j++) {
    const sj = shift[j] ?? 0;
    for (let i = 0; i < gw; i++) {
      const t = type[j * gw + i];
      if (!t || t === 3) continue;
      const x = X0 + (i + sj) * c;
      const y = Y0 + j * c;
      if (t === 1) {
        if (!crisp && R() < drop) {
          ditherCell(ctx, x, y, c, 0.35);
          continue;
        }
        ctx.fillRect(x, y, c, c);
      } else {
        if (!crisp && R() < drop * 0.6) continue;
        ditherCell(ctx, x, y, c, dens[j * gw + i] ?? 0);
      }
    }
  }
  if (crisp) return;
  // horizontal dithered motion trails behind the trailing edge
  const trail = o.trail ?? 0.32;
  const tl = o.trailLen ?? 10;
  for (let j = 0; j < gh; j++) {
    let edge = -1;
    if (dir > 0) {
      for (let i = 0; i < gw; i++) {
        if (type[j * gw + i]) {
          edge = i;
          break;
        }
      }
    } else {
      for (let i = gw - 1; i >= 0; i--) {
        if (type[j * gw + i]) {
          edge = i;
          break;
        }
      }
    }
    if (edge < 0 || R() > trail) continue;
    const L = Math.round(2 + R() * R() * tl * 1.6);
    const half = R() < 0.35; // some streaks are half a block tall
    const v0 = half ? (R() < 0.5 ? 0 : 2) : 0;
    const v1 = half ? v0 + 2 : 4;
    const sj = shift[j] ?? 0;
    for (let t = 1; t <= L; t++) {
      const i = edge - dir * t + sj;
      const f = 1 - t / (L + 1);
      ditherCell(ctx, X0 + i * c, Y0 + j * c, c, 0.12 + 0.58 * Math.pow(f, 0.9), {
        v0,
        v1,
      });
    }
  }
  // vertical dotted drips above or below some columns
  const vert = o.vert ?? 0.1;
  for (let i = 0; i < gw; i++) {
    if (R() > vert) continue;
    let top = -1;
    let bot = -1;
    for (let j = 0; j < gh; j++) {
      if (type[j * gw + i]) {
        if (top < 0) top = j;
        bot = j;
      }
    }
    if (top < 0) continue;
    const up = R() < 0.5;
    const n = 1 + Math.floor(R() * 3);
    const u0 = Math.floor(R() * 3);
    for (let t = 1; t <= n; t++) {
      const j = up ? top - t : bot + t;
      ditherCell(ctx, X0 + i * c, Y0 + j * c, c, 0.55 * (1 - t / (n + 1)) + 0.2, {
        u0,
        u1: u0 + 1,
      });
    }
  }
  // a few stray blocks shaken loose behind the body
  const strays = Math.round((o.strays ?? 0.006) * gw * gh);
  for (let s = 0; s < strays; s++) {
    for (let tries = 0; tries < 30; tries++) {
      const i = Math.floor(R() * gw);
      const j = Math.floor(R() * gh);
      if (type[j * gw + i] !== 1) continue;
      const di = -dir * (2 + Math.floor(R() * 7));
      const dj = Math.floor(R() * 5) - 2;
      ctx.fillRect(X0 + (i + di) * c, Y0 + (j + dj) * c, c, c);
      break;
    }
  }
}
