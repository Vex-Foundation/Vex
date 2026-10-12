/**
 * PIXEL CORE: the seeded generator, the 4x4 Bayer matrix, the canvas helpers
 * and the one dithered cell every pixel animal is built from.
 *
 * Same seed, same pixels: the generator is mulberry32, so a composition drawn
 * twice (a still frame, a capture, a test) is identical bit for bit. Browser
 * only where a canvas is created; the arithmetic is pure.
 */

/** A seeded uniform generator in [0, 1). */
export type Rng = () => number;

/** mulberry32. Same seed, same sequence, on every load. */
export function rng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 4x4 ordered dither thresholds (0..15). */
export const BAYER: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Anything that can plot an axis aligned rectangle (a 2D context, or a bounds tracker). */
export interface Plotter {
  fillRect(x: number, y: number, w: number, h: number): void;
}

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Image sources the pixel functions read (decoded image, bitmap or canvas). */
export type PixelSource =
  | HTMLImageElement
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas;

export function sourceSize(img: PixelSource): { width: number; height: number } {
  if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) {
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    };
  }
  return { width: img.width, height: img.height };
}

/** A scratch canvas: a DOM canvas on the main thread, else an OffscreenCanvas. */
export function createCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

export function context2d(canvas: AnyCanvas, readback = false): Ctx2D {
  const ctx = canvas.getContext(
    "2d",
    readback ? { willReadFrequently: true } : undefined,
  ) as Ctx2D | null;
  if (ctx === null) throw new Error("2D canvas context unavailable");
  return ctx;
}

/** Load and decode an image. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load ${src}`));
    img.src = src;
  });
}

export interface DitherOptions {
  /** Dot size as a fraction of the sub cell (default 0.62). */
  readonly dot?: number;
  /** Restrict to Bayer columns u0..u1 and rows v0..v1 (a sub band of the cell). */
  readonly u0?: number;
  readonly u1?: number;
  readonly v0?: number;
  readonly v1?: number;
}

/** One dithered cell: 4x4 ordered dots at density 0..1. x, y, c in device pixels. */
export function ditherCell(
  ctx: Plotter,
  x: number,
  y: number,
  c: number,
  dens: number,
  o: DitherOptions = {},
): void {
  const p = c / 4;
  const s = Math.max(1, Math.round(p * (o.dot ?? 0.62)));
  const u0 = o.u0 ?? 0;
  const u1 = o.u1 ?? 4;
  const v0 = o.v0 ?? 0;
  const v1 = o.v1 ?? 4;
  for (let v = v0; v < v1; v++) {
    const row = BAYER[v];
    if (row === undefined) continue;
    for (let u = u0; u < u1; u++) {
      const threshold = row[u];
      if (threshold !== undefined && threshold < dens * 16) {
        ctx.fillRect(Math.round(x + u * p), Math.round(y + v * p), s, s);
      }
    }
  }
}

/** A plotter that only records the bounding box of everything plotted (device px). */
export class BoundsPlotter implements Plotter {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  fillRect(x: number, y: number, w: number, h: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x + w > this.maxX) this.maxX = x + w;
    if (y + h > this.maxY) this.maxY = y + h;
  }
  get empty(): boolean {
    return this.maxX < this.minX;
  }
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface AlphaBounds {
  /** Image size, px. */
  readonly fw: number;
  readonly fh: number;
  /** Visible (alpha above threshold) box, image px. */
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Visible box of an image (alpha above `threshold`), sampled at `sample` px
 * wide. A sprite is placed by this box, not by its file size, so the same
 * animal lines up wherever it is drawn.
 */
export function alphaBounds(
  img: PixelSource,
  threshold = 0.42,
  sample = 96,
): AlphaBounds {
  const { width: fw, height: fh } = sourceSize(img);
  const sw = sample;
  const sh = Math.max(1, Math.round((sw * fh) / fw));
  const cv = createCanvas(sw, sh);
  const cx = context2d(cv, true);
  cx.drawImage(img, 0, 0, sw, sh);
  const d = cx.getImageData(0, 0, sw, sh).data;
  const t = Math.round(threshold * 255);
  let x0 = sw;
  let x1 = -1;
  let y0 = sh;
  let y1 = -1;
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      if ((d[(j * sw + i) * 4 + 3] ?? 0) > t) {
        if (i < x0) x0 = i;
        if (i > x1) x1 = i;
        if (j < y0) y0 = j;
        if (j > y1) y1 = j;
      }
    }
  }
  if (x1 < 0) return { fw, fh, x0: 0, x1: fw, y0: 0, y1: fh };
  const k = fw / sw;
  return { fw, fh, x0: x0 * k, x1: (x1 + 1) * k, y0: y0 * k, y1: (y1 + 1) * k };
}
