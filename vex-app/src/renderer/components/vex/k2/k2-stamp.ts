/**
 * K2's dots, stamped: every round dot of her screen and of her beam is copied from a small atlas
 * (one sprite per ink and per quarter device px of radius, with half pixel offsets) instead of being
 * built as an arc of a path and filled. A frame of her is some 7,000 dots: stamping them costs a
 * fraction of building and filling the paths, on the GPU and on the CPU alike.
 *
 * The atlas is drawn once per theme and scale; `stamp` draws a frame's dots (map px) through her
 * transform (device px = o + k * map), ink by ink in her paint order.
 */
import { context2dOf, scratchCanvas, type Scratch } from "./k2-assets.js";
import type { Dots, Ink } from "./k2-portrait.js";

/** A sprite cell, device px: room for the largest dot (a highlight at the 1.2 scale and ratio 2). */
const CELL = 14;
const HALF = CELL / 2;
/** Radius steps per device px, and the largest step. */
const STEPS = 4;
const MAX_STEP = 22;
const VARIANTS = 4;

/** An ink's colour (CSS) and its alpha. */
export interface InkStyle {
  readonly color: string;
  readonly alpha: number;
}

export class Stamper {
  #atlas: Scratch | null = null;
  #key = "";
  readonly #row = new Map<string, number>();

  /** Draws the atlas for these inks (no-op when they did not change). */
  build(inks: Readonly<Record<string, InkStyle>>): void {
    const names = Object.keys(inks);
    const key = names
      .map((n) => `${n}:${inks[n]?.color}:${inks[n]?.alpha}`)
      .join("|");
    if (key === this.#key && this.#atlas !== null) return;
    this.#key = key;
    const W = CELL * (MAX_STEP + 1) * VARIANTS;
    const H = CELL * names.length;
    const cv = scratchCanvas(W, H);
    const ctx = context2dOf(cv);
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
  }

  /**
   * Stamps one ink's dots: (x, y, r) triples in map px, device px = (ox + k x, oy + k y), radius
   * k r, at `alpha`.
   */
  stampInk(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    name: string,
    list: readonly number[],
    k: number,
    ox: number,
    oy: number,
    alpha = 1,
  ): void {
    const atlas = this.#atlas;
    const row = this.#row.get(name);
    if (atlas === null || row === undefined || list.length === 0) return;
    ctx.globalAlpha = alpha;
    const sy0 = row * CELL;
    for (let n = 0; n < list.length; n += 3) {
      const step = Math.min(
        MAX_STEP,
        Math.round((list[n + 2] ?? 0) * k * STEPS),
      );
      if (step < 1) continue;
      const px = Math.round((ox + k * (list[n] ?? 0)) * 2) / 2;
      const py = Math.round((oy + k * (list[n + 1] ?? 0)) * 2) / 2;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const v = (px > ix ? 1 : 0) + (py > iy ? 2 : 0);
      ctx.drawImage(
        atlas,
        (step * VARIANTS + v) * CELL,
        sy0,
        CELL,
        CELL,
        ix - HALF,
        iy - HALF,
        CELL,
        CELL,
      );
    }
    ctx.globalAlpha = 1;
  }

  /** Stamps a frame of her, ink by ink in her paint order. */
  stamp(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dots: Dots,
    order: readonly Ink[],
    k: number,
    ox: number,
    oy: number,
    alpha = 1,
  ): void {
    for (const ink of order)
      this.stampInk(ctx, ink, dots.lists[ink], k, ox, oy, alpha);
  }
}
