/**
 * How Kimm is framed in a box (SK KIMM.md 4 and 10; vex-home `kimm.js:128-149`, the fixed `kimm-embed.js` `fit()`,
 * H3 `stage.js:39-41, 96, 105-112`). Pure: the live model and the tests call the same functions.
 *
 * Her measures are in model units (`KM`, `kimm.js:22`): the model is 4426 x 9169, the top of her hair at 315, the
 * centre line of her face at x 2250, her widest pose 3300. A fit puts her face on a vertical line of the box
 * (`align`, the centre by default), her hair `headroom` px under the box's top (or under an element placed over her
 * head, the arc, which scales with her), and `span` model units of her between the hair and the box's foot, unless
 * her widest pose would not fit `widthFill` of the box's width.
 *
 * The box is measured by its `clientWidth`/`clientHeight`, never a transformed rect (the 24 px defect of
 * `kimm.js:131`, SK KIMM.md 4 and 11.3).
 *
 * DESKTOP PORT (owner decision 2026-11-15): VEX Cloud's `apps/web/src/components/kimm/kimm-fit.ts` without its phone
 * rules (`cropFit`: desktop's window floor is 1000), plus desktop's own seats (`kimmSeatFit`). Desktop draws her
 * still in two seats of `KimmPanel` (kimm.css): on the lock screen her section still stands on the panel's foot at
 * the panel's height less 64; in D2's portrait card it stands 48 from the top at 88% of the width. Her live figure
 * takes the still's own frame in each, so she fades in where her still stood and no layout changes.
 */

/** Her measures in model units (`kimm.js:22`, SK KIMM.md 4). */
export const KM = {
  /** The top of her hair. */
  head: 315,
  /** The centre line of her face. */
  face: 2250,
  /** Her widest pose. */
  wide: 3300,
  /** The bottom of her feet. */
  foot: 8921,
  /** The model's own size. */
  width: 4426,
  height: 9169,
  /** The arc's height in px at scale 1 (vex-home's risk arc, the embed's `arc.height` default). */
  arc: 194,
} as const;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

/**
 * The landing's span (`kimm.js:133`): 4300 units on a laptop (head to hips) down to 3000 on a big screen (head to
 * waist), by the column's height: `t = clamp((H - 620) / 640, 0, 1)`.
 */
export function landingSpan(height: number): number {
  return 4300 - 1300 * clamp((height - 620) / 640, 0, 1);
}

/**
 * Her section's span (H3 `stage.js:41`): the landing's on a tall section, shortened on a short one (under 620) so
 * she keeps her width and is cut by the foot line, as the home cuts her by its copy line.
 */
export function sectionSpan(height: number): number {
  return height >= 620 ? landingSpan(height) : lerp(3000, 4300, clamp((height - 400) / 220, 0, 1));
}

/** An element over her head that scales with her (the embed's `arc`; vex-home's risk arc, the home's suggestion arc). */
export interface KimmArcFit {
  /** Its top in px from the box's top (12). */
  readonly top?: number;
  /** Its height in px at scale 1 (194). */
  readonly height?: number;
  /** The gap in px between it and her hair at scale 1 (6). */
  readonly gap?: number;
}

/** What a box asks of the fit; functions receive the box's width and height. */
export interface KimmFitOptions {
  /** Model units from her hair to the box's foot (default `landingSpan(H)`). */
  readonly span?: number | ((width: number, height: number) => number);
  /** Px above her hair when there is no arc (default 0). */
  readonly headroom?: number | ((width: number, height: number) => number);
  /** The share of the box's width her widest pose may take (0.92). */
  readonly widthFill?: number | ((width: number, height: number) => number);
  /** Her face line as a share of the box's width (0.5). */
  readonly align?: number;
  /** An element over her head that scales with her; replaces `headroom`. */
  readonly arc?: KimmArcFit;
}

/** A solved fit, in the box's px. */
export interface KimmFit {
  /** The model's scale. */
  readonly s: number;
  /** The top of her hair. */
  readonly head: number;
  /** Her face line. */
  readonly faceX: number;
  /** The model's x and y (its top left). */
  readonly x: number;
  readonly y: number;
  readonly span: number;
  /** The arc's scale (`--rk-s` in vex-home) and its top, when the box has an arc. */
  readonly arc: { readonly k: number; readonly top: number } | null;
}

const resolve = (
  value: number | ((width: number, height: number) => number) | undefined,
  width: number,
  height: number,
  fallback: number,
): number => (typeof value === "function" ? value(width, height) : value === undefined ? fallback : value);

/**
 * The fit of the embed (`kimm-embed.js` `fit()`): with an arc, three passes of `k = clamp(s x 5.6, 0.55, 1.15)`,
 * `head = top + height x k + gap`, `s = min((H - head) / span, W x fill / 3300)`, then the arc's `k` from the last
 * `s` (vex-home `kimm.js:136-142`).
 */
export function fitKimm(boxWidth: number, boxHeight: number, options: KimmFitOptions = {}): KimmFit {
  const W = Math.max(1, boxWidth);
  const H = Math.max(1, boxHeight);
  const span = resolve(options.span, W, H, landingSpan(H));
  const fill = resolve(options.widthFill, W, H, 0.92);
  const faceX = W * (options.align ?? 0.5);
  let s: number;
  let head: number;
  let arc: KimmFit["arc"] = null;
  if (options.arc) {
    const top = options.arc.top ?? 12;
    const height = options.arc.height ?? KM.arc;
    const gap = options.arc.gap ?? 6;
    let k = 0.8;
    s = 0.14;
    head = 0;
    for (let pass = 0; pass < 3; pass++) {
      k = clamp(s * 5.6, 0.55, 1.15);
      head = top + height * k + gap;
      s = Math.min((H - head) / span, (W * fill) / KM.wide);
    }
    k = clamp(s * 5.6, 0.55, 1.15);
    head = top + height * k + gap;
    arc = { k, top };
  } else {
    head = resolve(options.headroom, W, H, 0);
    s = Math.min((H - head) / span, (W * fill) / KM.wide);
  }
  return {
    s,
    head,
    faceX,
    x: faceX - KM.face * s,
    y: head - KM.head * s,
    span,
    arc,
  };
}

/**
 * Her section's fit (H3 `stage.js:96, 107-109`): on a section 380 tall or more, the section span, 52 px over her hair
 * and 0.92 of the width; on a shorter one (the stub while it wipes) she grows to fill it (`u` from 75 to 380).
 */
export function sectionFitOptions(): KimmFitOptions {
  const u = (height: number): number => clamp((height - 75) / (380 - 75), 0, 1);
  return {
    span: (_width, height) => lerp(1700, sectionSpan(height), u(height)),
    headroom: (_width, height) => lerp(4, 52, u(height)),
    widthFill: (_width, height) => lerp(3, 0.92, u(height)),
  };
}

/** Her section still's width in image px (`still-*.webp`, 720 wide). */
export const KIMM_STILL_WIDTH = 720;

/** Her rest still's height in image px: the lock seat sizes every still by its height, and rest is the one it waits on. */
export const KIMM_STILL_REST_HEIGHT = 1032;

/**
 * Model units per pixel of her section still. VEX Cloud frames, in the same section, her still at 88% of the width
 * (48 from the top) and her live figure at 0.92 of the width for her widest pose (52 over her hair): one still pixel
 * is 0.88 x 3300 / (0.92 x 720) units, about 4.384.
 */
export const KIMM_STILL_UNITS_PER_PX = (0.88 * KM.wide) / (0.92 * KIMM_STILL_WIDTH);

/** Her hair stands this many still pixels under the still's top (Cloud's 52 against 48, in its 432 wide section). */
export const KIMM_STILL_HAIR_PX = (4 * KIMM_STILL_WIDTH) / (0.88 * 432);

/** Where `KimmPanel` stands her (kimm.css): the lock screen's half, or D2's portrait card. */
export type KimmSeat = "lock" | "card";

/** Where her still stands in a box of a seat, in the box's px: its top and its width. */
export function kimmStillFrame(seat: KimmSeat, width: number, height: number): { readonly top: number; readonly width: number } {
  if (seat === "card") return { top: 48, width: 0.88 * width };
  const tall = Math.max(1, height - 64);
  return { top: 64, width: (tall * KIMM_STILL_WIDTH) / KIMM_STILL_REST_HEIGHT };
}

/**
 * How far her live layer bleeds past the panel on every side (kimm.css, `.vex-kimm-panel__live`), so the lock
 * screen's depth can shift her figure (at most 10 px, `KIMM_PARALLAX`) without uncovering an edge; the panel clips it.
 */
export const KIMM_LIVE_BLEED = 16;

/**
 * Her live fit in a seat: the scale and hair line of the still the seat draws (`kimmStillFrame`), her face on the
 * box's centre line as the still is centred, cut by the box's foot as the still is. Both terms of `fitKimm` give the
 * same scale, so neither the box's height nor its width moves her off her still's frame. The box is her live layer,
 * `bleed` px larger than the panel on every side; the still's frame is solved in the panel and moved into the layer.
 */
export function kimmSeatFit(seat: KimmSeat, bleed: number = KIMM_LIVE_BLEED): KimmFitOptions {
  const solve = (width: number, height: number): { readonly s: number; readonly head: number } => {
    const frame = kimmStillFrame(seat, Math.max(1, width - 2 * bleed), Math.max(1, height - 2 * bleed));
    const k = frame.width / KIMM_STILL_WIDTH;
    return { s: k / KIMM_STILL_UNITS_PER_PX, head: bleed + frame.top + KIMM_STILL_HAIR_PX * k };
  };
  return {
    headroom: (width, height) => solve(width, height).head,
    span: (width, height) => {
      const { s, head } = solve(width, height);
      return Math.max(1, height - head) / s;
    },
    widthFill: (width, height) => (solve(width, height).s * KM.wide) / Math.max(1, width),
  };
}
