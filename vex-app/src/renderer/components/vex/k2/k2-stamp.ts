/**
 * K2's dots, stamped: every round dot of her screen and of her beam is copied from a small atlas
 * (one sprite per ink and per quarter device px of radius, with half pixel offsets) instead of being
 * built as an arc of a path and filled.
 *
 * The atlas is drawn once per theme and scale (canvas arcs, so the dots keep their exact shapes) and
 * read back once into runs of premultiplied pixels (`SpriteRuns`). A frame's dots are then blended in
 * memory (`DotRaster`, source over, the canvas's own rule) and put on the canvas in one call: a frame
 * of her is 6,000 to 13,000 dots, and one canvas call per dot cost 15 to 45 ms a frame on a software
 * canvas (headless Chromium), the blend in memory a few ms. Where the atlas cannot be read back the
 * dots are drawn one `drawImage` each, as before.
 *
 * `begin` starts a frame, `stamp` and `stampInk` add its dots (map px) through her transform (device
 * px = o + k * map), ink by ink in her paint order, and `end` puts it on the canvas.
 */
import { context2dOf, type Scratch, type Scratch2D, scratchCanvas } from "./k2-assets.js";
import type { Dots, Ink } from "./k2-portrait.js";

/** A sprite cell, device px: room for the largest dot (a highlight at the 1.2 scale and ratio 2). */
export const CELL = 14;
const HALF = CELL / 2;
/** Radius steps per device px, and the largest step. */
const STEPS = 4;
const MAX_STEP = 22;
const VARIANTS = 4;
/** Sprites per atlas row (one row per ink). */
export const COLS = (MAX_STEP + 1) * VARIANTS;

/** An ink's colour (CSS) and its alpha. */
export interface InkStyle {
  readonly color: string;
  readonly alpha: number;
}

/** x / 255, rounded, for x in 0..65025. */
export const div255 = (x: number): number => (x + 128 + ((x + 128) >> 8)) >> 8;

/** The platform stores a Uint32 little end first (RGBA pixel = A << 24 | B << 16 | G << 8 | R). */
export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;

/** A packed premultiplied pixel at an 8-bit alpha (each channel x a8 / 255, rounded, in pairs). */
export function scalePixel(s: number, a8: number): number {
  let rb = (s & 0xff00ff) * a8 + 0x800080;
  rb = ((rb + ((rb >>> 8) & 0xff00ff)) >>> 8) & 0xff00ff;
  let ag = ((s >>> 8) & 0xff00ff) * a8 + 0x800080;
  ag = ((ag + ((ag >>> 8) & 0xff00ff)) >>> 8) & 0xff00ff;
  return (rb | (ag << 8)) >>> 0;
}

/** Source over for packed premultiplied pixels: s + d x (255 - sa) / 255 per channel. */
function over(u: Uint32Array, i: number, s: number): void {
  const sa = s >>> 24;
  const d = u[i] as number;
  if (sa === 255 || d === 0) {
    u[i] = s;
    return;
  }
  u[i] = s + scalePixel(d, 255 - sa);
}

/** 255 / a for each alpha (premultiplied to straight). */
const UNPRE = Float64Array.from({ length: 256 }, (_, a) => (a > 0 ? 255 / a : 0));

/** Destination over: the pixel goes under what is there (d + s x (255 - da) / 255 per channel). */
function under(u: Uint32Array, i: number, s: number): void {
  const d = u[i] as number;
  const da = d >>> 24;
  if (da === 255) return;
  u[i] = d === 0 ? s : d + scalePixel(s, 255 - da);
}

/** A frame's pixels kept to start later frames from (premultiplied), with the box they touch. */
export interface RasterLayer {
  readonly px: Uint32Array;
  readonly box: readonly [number, number, number, number];
}

/**
 * An atlas's sprites as runs of pixels: for each sprite (row * `cols` + column) its non-empty pixels'
 * cell positions and premultiplied colours (packed, `LITTLE_ENDIAN`), read from the atlas's
 * (straight alpha) RGBA.
 */
export class SpriteRuns {
  readonly start: Int32Array;
  readonly cx: Uint8Array;
  readonly cy: Uint8Array;
  readonly px: Uint32Array;
  #offW = -1;
  #off: Int32Array = new Int32Array(0);

  constructor(rgba: ArrayLike<number>, width: number, cell: number, rows: number, cols: number) {
    const n = rows * cols;
    this.start = new Int32Array(n + 1);
    let count = 0;
    for (let s = 0; s < n; s++) {
      const x0 = (s % cols) * cell;
      const y0 = Math.floor(s / cols) * cell;
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++)
          if ((rgba[((y0 + y) * width + x0 + x) * 4 + 3] ?? 0) > 0) count++;
    }
    this.cx = new Uint8Array(count);
    this.cy = new Uint8Array(count);
    this.px = new Uint32Array(count);
    let p = 0;
    for (let s = 0; s < n; s++) {
      this.start[s] = p;
      const x0 = (s % cols) * cell;
      const y0 = Math.floor(s / cols) * cell;
      for (let y = 0; y < cell; y++)
        for (let x = 0; x < cell; x++) {
          const i = ((y0 + y) * width + x0 + x) * 4;
          const a = rgba[i + 3] ?? 0;
          if (a === 0) continue;
          this.cx[p] = x;
          this.cy[p] = y;
          this.px[p] =
            (div255((rgba[i] ?? 0) * a) |
              (div255((rgba[i + 1] ?? 0) * a) << 8) |
              (div255((rgba[i + 2] ?? 0) * a) << 16) |
              (a << 24)) >>>
            0;
          p++;
        }
    }
    this.start[n] = p;
  }

  /** Each pixel's offset from its cell's corner in a frame `w` px wide (kept for that width). */
  offsets(w: number): Int32Array {
    if (w !== this.#offW) {
      const off = new Int32Array(this.px.length);
      for (let p = 0; p < off.length; p++)
        off[p] = (this.cy[p] as number) * w + (this.cx[p] as number);
      this.#off = off;
      this.#offW = w;
    }
    return this.#off;
  }
}

/**
 * A frame blended in memory: premultiplied RGBA while dots are added (source over, at an 8-bit
 * alpha like the canvas's `globalAlpha`), turned to the straight alpha of `ImageData` by `finish`
 * over the box the dots touched.
 */
export class DotRaster {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;
  readonly #u32: Uint32Array;
  #x0 = 0;
  #y0 = 0;
  #x1 = -1;
  #y1 = -1;

  constructor(w: number, h: number, data?: Uint8ClampedArray) {
    this.w = w;
    this.h = h;
    this.data = data ?? new Uint8ClampedArray(w * h * 4);
    this.#u32 = new Uint32Array(this.data.buffer, this.data.byteOffset, w * h);
    this.clear();
  }

  /** Clears the frame (every pixel transparent) and the touched box. */
  clear(): void {
    this.#u32.fill(0);
    this.#x0 = this.w;
    this.#y0 = this.h;
    this.#x1 = -1;
    this.#y1 = -1;
  }

  /** Keeps the frame so far (its pixels and touched box) to start later frames from. */
  snapshot(): RasterLayer {
    return {
      px: this.#u32.slice(),
      box: [this.#x0, this.#y0, this.#x1, this.#y1],
    };
  }

  /** Starts the frame from a kept layer of the same size (its pixels and touched box). */
  restore(layer: RasterLayer): boolean {
    if (layer.px.length !== this.#u32.length) return false;
    this.#u32.set(layer.px);
    [this.#x0, this.#y0, this.#x1, this.#y1] = layer.box;
    return true;
  }

  /**
   * Blends sprite `s` of `runs` with its cell's corner at (left, top), at alpha `a8` (0..255): over
   * what is there, or under it (`behind`, the canvas's destination over).
   */
  put(
    runs: SpriteRuns,
    s: number,
    left: number,
    top: number,
    a8: number,
    behind = false,
  ): void {
    const p0 = runs.start[s] as number;
    const p1 = runs.start[s + 1] as number;
    if (!(p1 > p0) || a8 <= 0) return;
    const W = this.w;
    const H = this.h;
    if (left >= W || top >= H || left + CELL <= 0 || top + CELL <= 0) return;
    const u = this.#u32;
    const px = runs.px;
    const full = a8 >= 255;
    const blend = behind ? under : over;
    if (left >= 0 && top >= 0 && left + CELL <= W && top + CELL <= H) {
      const off = runs.offsets(W);
      const base = top * W + left;
      if (full)
        for (let p = p0; p < p1; p++) blend(u, base + (off[p] as number), px[p] as number);
      else
        for (let p = p0; p < p1; p++) {
          const c = scalePixel(px[p] as number, a8);
          if (c !== 0) blend(u, base + (off[p] as number), c);
        }
    } else {
      const { cx, cy } = runs;
      for (let p = p0; p < p1; p++) {
        const x = left + (cx[p] as number);
        const y = top + (cy[p] as number);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const c = full ? (px[p] as number) : scalePixel(px[p] as number, a8);
        if (c !== 0) blend(u, y * W + x, c);
      }
    }
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(W - 1, left + CELL - 1);
    const y1 = Math.min(H - 1, top + CELL - 1);
    if (x0 < this.#x0) this.#x0 = x0;
    if (y0 < this.#y0) this.#y0 = y0;
    if (x1 > this.#x1) this.#x1 = x1;
    if (y1 > this.#y1) this.#y1 = y1;
  }

  /**
   * Turns the touched box to straight alpha (`ImageData`'s) and answers it, or null when no dot
   * landed. The frame is then ready for `putImageData`; `clear` starts the next one.
   */
  finish(): { x: number; y: number; w: number; h: number } | null {
    if (this.#x1 < this.#x0 || this.#y1 < this.#y0) return null;
    const u = this.#u32;
    const W = this.w;
    for (let y = this.#y0; y <= this.#y1; y++) {
      let j = y * W + this.#x0;
      for (let x = this.#x0; x <= this.#x1; x++, j++) {
        const p = u[j] as number;
        const a = p >>> 24;
        if (a === 0 || a === 255) continue;
        const f = UNPRE[a] as number;
        u[j] =
          (Math.min(255, ((p & 255) * f + 0.5) | 0) |
            (Math.min(255, (((p >>> 8) & 255) * f + 0.5) | 0) << 8) |
            (Math.min(255, (((p >>> 16) & 255) * f + 0.5) | 0) << 16) |
            (a << 24)) >>>
          0;
      }
    }
    return {
      x: this.#x0,
      y: this.#y0,
      w: this.#x1 - this.#x0 + 1,
      h: this.#y1 - this.#y0 + 1,
    };
  }
}

/**
 * The sprite (ink `row`) and cell corner of a dot at device (px, py) of device radius `rd`, or null
 * when it is too small: the radius in quarter px, the centre snapped to half px (the variants).
 */
export function spriteOf(
  row: number,
  px: number,
  py: number,
  rd: number,
): { readonly s: number; readonly left: number; readonly top: number } | null {
  const step = Math.min(MAX_STEP, Math.round(rd * STEPS));
  if (step < 1) return null;
  const hx = Math.round(px * 2) / 2;
  const hy = Math.round(py * 2) / 2;
  const ix = Math.floor(hx);
  const iy = Math.floor(hy);
  const v = (hx > ix ? 1 : 0) + (hy > iy ? 2 : 0);
  return {
    s: row * COLS + step * VARIANTS + v,
    left: ix - HALF,
    top: iy - HALF,
  };
}

export class Stamper {
  #atlas: Scratch | null = null;
  #key = "";
  readonly #row = new Map<string, number>();
  /** The atlas read back (null where it cannot be: the dots are then drawn one call each). */
  #runs: SpriteRuns | null = null;
  #img: ImageData | null = null;
  #raster: DotRaster | null = null;
  /** A frame is being blended in memory (`begin` .. `end`). */
  #open = false;
  /** The box of the last frame put on the canvas (null once a new one begins). */
  #box: { x: number; y: number; w: number; h: number } | null = null;
  /** A frame's start kept by `keep` (her settled frame's unchanging dots), by its key. */
  #layer: { key: string; layer: RasterLayer } | null = null;

  /** Draws the atlas for these inks (no-op when they did not change). */
  build(inks: Readonly<Record<string, InkStyle>>): void {
    const names = Object.keys(inks);
    const key = names.map((n) => `${n}:${inks[n]?.color}:${inks[n]?.alpha}`).join("|");
    if (key === this.#key && this.#atlas !== null) return;
    this.#key = key;
    const W = CELL * COLS;
    const H = CELL * names.length;
    const cv = scratchCanvas(W, H);
    const ctx = context2dOf(cv, true);
    if (ctx === null) return;
    this.#row.clear();
    names.forEach((name, row) => {
      const style = inks[name];
      if (style === undefined) return;
      this.#row.set(name, row);
      ctx.fillStyle = style.color;
      ctx.globalAlpha = style.alpha;
      for (let step = 1; step <= MAX_STEP; step++)
        for (let v = 0; v < VARIANTS; v++) {
          const x = (step * VARIANTS + v) * CELL + HALF + (v & 1 ? 0.5 : 0);
          const y = row * CELL + HALF + (v & 2 ? 0.5 : 0);
          ctx.beginPath();
          ctx.arc(x, y, step / STEPS, 0, 6.2832);
          ctx.fill();
        }
    });
    this.#atlas = cv;
    try {
      const px = ctx.getImageData(0, 0, W, H).data;
      this.#runs = LITTLE_ENDIAN ? new SpriteRuns(px, W, CELL, names.length, COLS) : null;
    } catch {
      this.#runs = null;
    }
  }

  /**
   * Starts a frame of `w` x `h` device px in memory (cleared); without the atlas's runs the dots go
   * straight to the canvas instead.
   */
  begin(w: number, h: number): void {
    this.#open = false;
    this.#box = null;
    if (this.#runs === null || typeof ImageData !== "function") return;
    let raster = this.#raster;
    if (raster === null || raster.w !== w || raster.h !== h) {
      this.#img = new ImageData(w, h);
      raster = new DotRaster(w, h, this.#img.data);
      this.#raster = raster;
    } else raster.clear();
    this.#open = true;
  }

  /** Puts the frame blended since `begin` on the canvas (its device px, under what follows). */
  end(ctx: Scratch2D): void {
    if (!this.#open) return;
    this.#open = false;
    const box = this.#raster?.finish() ?? null;
    if (box === null || this.#img === null) return;
    this.#box = box;
    ctx.putImageData(this.#img, 0, 0, box.x, box.y, box.w, box.h);
  }

  /**
   * Keeps the frame blended so far under `key` (with the atlas's inks), for `restore` to start
   * later frames from; nothing without the memory path.
   */
  keep(key: string): void {
    if (!this.#open || this.#raster === null) return;
    this.#layer = {
      key: `${key}|${this.#key}`,
      layer: this.#raster.snapshot(),
    };
  }

  /** Starts the frame begun from the layer kept under `key`; false when there is none to use. */
  restore(key: string): boolean {
    const kept = this.#layer;
    if (!this.#open || this.#raster === null || kept === null) return false;
    if (kept.key !== `${key}|${this.#key}`) return false;
    return this.#raster.restore(kept.layer);
  }

  /**
   * Puts the last frame blended in memory on the canvas again (her dots and her beam did not
   * change, only the coin or an actor did); false when there is none to put.
   */
  again(ctx: Scratch2D, w: number, h: number): boolean {
    const box = this.#box;
    const img = this.#img;
    if (box === null || img === null || img.width !== w || img.height !== h) return false;
    ctx.putImageData(img, 0, 0, box.x, box.y, box.w, box.h);
    return true;
  }

  /**
   * Stamps one ink's dots: (x, y, r) triples in map px, device px = (ox + k x, oy + k y), radius
   * k r, at `alpha`; `behind` puts them under what is already drawn (her beam under her).
   */
  stampInk(
    ctx: Scratch2D,
    name: string,
    list: readonly number[],
    k: number,
    ox: number,
    oy: number,
    alpha = 1,
    behind = false,
  ): void {
    const atlas = this.#atlas;
    const row = this.#row.get(name);
    if (atlas === null || row === undefined || list.length === 0) return;
    const raster = this.#open ? this.#raster : null;
    const runs = this.#runs;
    if (raster !== null && runs !== null) {
      const a8 = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      for (let n = 0; n < list.length; n += 3) {
        const sp = spriteOf(
          row,
          ox + k * (list[n] ?? 0),
          oy + k * (list[n + 1] ?? 0),
          (list[n + 2] ?? 0) * k,
        );
        if (sp !== null) raster.put(runs, sp.s, sp.left, sp.top, a8, behind);
      }
      return;
    }
    ctx.globalAlpha = alpha;
    if (behind) ctx.globalCompositeOperation = "destination-over";
    for (let n = 0; n < list.length; n += 3) {
      const sp = spriteOf(
        row,
        ox + k * (list[n] ?? 0),
        oy + k * (list[n + 1] ?? 0),
        (list[n + 2] ?? 0) * k,
      );
      if (sp === null) continue;
      ctx.drawImage(
        atlas,
        (sp.s % COLS) * CELL,
        row * CELL,
        CELL,
        CELL,
        sp.left,
        sp.top,
        CELL,
        CELL,
      );
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Stamps a frame of her, ink by ink in her paint order. */
  stamp(
    ctx: Scratch2D,
    dots: Dots,
    order: readonly Ink[],
    k: number,
    ox: number,
    oy: number,
    alpha = 1,
  ): void {
    for (const ink of order) this.stampInk(ctx, ink, dots.lists[ink], k, ox, oy, alpha);
  }
}
