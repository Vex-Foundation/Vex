/**
 * KIMM'S ART, ONE SEAM (docs/design/H3-DESKTOP.md sections 1.5, 1.6 and 3.5;
 * plan rows S4-01 to S4-05 and S4-18). The one place that says which file
 * each of her moods, her open section and her closed strip are drawn from.
 * Every Kimm surface (the Vex key's portrait cell, her section, the strip)
 * reads her art through a `KimmArtSet`, so no component names a path.
 *
 * THE MOODS. The six printed on the mood plate (`landing-r3__plate-key-moods`),
 * in its order, and the still VEX Cloud draws after a fill (`signed`, its
 * mockup's `js/data.js`): hi (the V sign), think (the hand at her mouth),
 * offer (the open palm), held (the open palm, dimmed), signed (after a
 * fill), refused (the whole anger mark), rest. Cloud uses the same list
 * (section 4.11). Which Vex state shows which mood is
 * `features/vex/kimm-mood.ts`, not this file.
 *
 * HELD IS OFFER, DIMMED. Cloud draws held as the offer pose under its scrim:
 * the same picture at half its light (the mood plate's held cell measures
 * 0.50 of the offer cell's). So held has no file of its own: it is drawn
 * from offer's (`KIMM_ART_MOOD`), and the sheet dims it (kimm.css, the
 * figure and the portrait at `data-kimm-mood="held"`). A designer's file for
 * it is never asked for.
 *
 * THE FILES, under `public/art/kimm/` (served at `/art/kimm/`):
 *   - `key-moods.webp`: the key's mood sprite, every drawn mood in one file,
 *     so a change of mood never waits on a request. Closed, it is the only
 *     Kimm file that loads (section 3.5). Each drawn mood is one cell of it.
 *   - `section-{mood}.webp`: her open section, her figure on its blue ground,
 *     one per drawn mood. Loaded only when her section first opens (S4-05).
 *   - `strip.webp`: the closed strip's frame of the glyph field.
 * Their byte budgets are pinned in the build check's brand asset registry
 * (`scripts/kimm-brand-assets.mjs`, spread into `BRAND_ASSETS` in
 * `scripts/check-build-artifacts.mjs`), where the reasons are.
 *
 * NOT HERE YET. None of her art is in the repo: it comes from the designer
 * (plan section 4.5). So every piece is `missing` today, and `missing` names
 * the file it waits for. A surface renders `missing` as no art at all: never
 * a placeholder figure, a sample, or a stand-in passed off as her
 * (`AGENTS.md`: no mock presented as production). When a file lands, S4-18
 * adds it to `KIMM_ARRIVED` with its pixel size (and the sprite's cells to
 * `KIMM_KEY_MOOD_CELLS`), pins the same size in the registry, and the piece
 * turns `ready`. The seam's test holds the two honest both ways: a piece is
 * `missing` exactly while its file is absent from `public/art/kimm/`.
 *
 * THE STAND-INS. The H3 harness has dev-only crops of the mockup
 * (`src/renderer/dev/h3-shell/standins/`). This module never imports them,
 * and the build check refuses any production module that does. The harness
 * builds its own `KimmArtSet` from its manifest and hands it to the surface
 * it renders, which is why every surface takes a set rather than reading
 * `KIMM_SHIPPED_ART` itself.
 *
 * Pure data: no React, no IO, no fetch.
 */

/** Her moods: the mood plate's order, with Cloud's `signed` before refused. */
export const KIMM_MOODS = ["hi", "think", "offer", "held", "signed", "refused", "rest"] as const;

export type KimmMood = (typeof KIMM_MOODS)[number];

/** The moods drawn from a file of their own: every mood but held. */
export const KIMM_DRAWN_MOODS = ["hi", "think", "offer", "signed", "refused", "rest"] as const;

export type KimmDrawnMood = (typeof KIMM_DRAWN_MOODS)[number];

/** Which mood's art each mood is drawn from: held is offer's, dimmed by the sheet. */
export const KIMM_ART_MOOD: Readonly<Record<KimmMood, KimmDrawnMood>> = {
  hi: "hi",
  think: "think",
  offer: "offer",
  held: "offer",
  signed: "signed",
  refused: "refused",
  rest: "rest",
};

/** Where her art sits under the renderer's public root, and where it is served. */
export const KIMM_ART_DIR = "art/kimm";
export const KIMM_ART = `/${KIMM_ART_DIR}/`;

/** Every file the seam expects, relative to the renderer's public root. */
export const KIMM_FILES = {
  keyMoods: `${KIMM_ART_DIR}/key-moods.webp`,
  sections: {
    hi: `${KIMM_ART_DIR}/section-hi.webp`,
    think: `${KIMM_ART_DIR}/section-think.webp`,
    offer: `${KIMM_ART_DIR}/section-offer.webp`,
    signed: `${KIMM_ART_DIR}/section-signed.webp`,
    refused: `${KIMM_ART_DIR}/section-refused.webp`,
    rest: `${KIMM_ART_DIR}/section-rest.webp`,
  },
  strip: `${KIMM_ART_DIR}/strip.webp`,
} as const satisfies {
  readonly keyMoods: string;
  readonly sections: Readonly<Record<KimmDrawnMood, string>>;
  readonly strip: string;
};

/** An image her art is drawn from: where it is served and its size in image pixels. */
export interface KimmImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** A box in image pixels: left and top included, right and bottom excluded. */
export type KimmPixelBox = readonly [left: number, top: number, right: number, bottom: number];

/** One mood's portrait: its cell of the key's mood sprite. */
export interface KimmPortraitCell {
  readonly sheet: KimmImage;
  readonly cell: KimmPixelBox;
}

/**
 * One piece of her art. `missing` while its file is not in the app, naming
 * the file it waits for; a surface draws no art for it. `ready` once the file
 * is there, with what to draw.
 */
export type KimmArt<Ready extends object = KimmImage> =
  | { readonly state: "missing"; readonly file: string }
  | ({ readonly state: "ready" } & Ready);

/** Everything a Kimm surface draws from. */
export interface KimmArtSet {
  readonly portraits: Readonly<Record<KimmMood, KimmArt<KimmPortraitCell>>>;
  readonly sections: Readonly<Record<KimmMood, KimmArt>>;
  readonly strip: KimmArt;
}

/**
 * The files that are in the app, with their pixel sizes, keyed by their path
 * under the public root. EMPTY: none of her art has arrived. S4-18 adds each
 * file as it lands, with the size its `BRAND_ASSETS` entry pins.
 */
const KIMM_ARRIVED: Readonly<Partial<Record<string, { readonly width: number; readonly height: number }>>> = {};

/**
 * Each drawn mood's cell of the key's mood sprite, in the sprite's pixels;
 * `null` until the sprite arrives and its layout is read from the file
 * itself. Held takes offer's cell (`KIMM_ART_MOOD`).
 */
const KIMM_KEY_MOOD_CELLS: Readonly<Record<KimmDrawnMood, KimmPixelBox>> | null = null;

function shipped(file: string): KimmArt {
  const size = KIMM_ARRIVED[file];
  if (size === undefined) return { state: "missing", file };
  return { state: "ready", src: `/${file}`, width: size.width, height: size.height };
}

function shippedPortrait(mood: KimmMood): KimmArt<KimmPortraitCell> {
  const sheet = shipped(KIMM_FILES.keyMoods);
  if (sheet.state === "missing" || KIMM_KEY_MOOD_CELLS === null) {
    return { state: "missing", file: KIMM_FILES.keyMoods };
  }
  return {
    state: "ready",
    sheet: { src: sheet.src, width: sheet.width, height: sheet.height },
    cell: KIMM_KEY_MOOD_CELLS[KIMM_ART_MOOD[mood]],
  };
}

function byMood<T>(of: (mood: KimmMood) => T): Readonly<Record<KimmMood, T>> {
  return {
    hi: of("hi"),
    think: of("think"),
    offer: of("offer"),
    held: of("held"),
    signed: of("signed"),
    refused: of("refused"),
    rest: of("rest"),
  };
}

/** Her art as the app ships it. Every piece is `missing` until her files arrive. */
export const KIMM_SHIPPED_ART: KimmArtSet = {
  portraits: byMood(shippedPortrait),
  sections: byMood((mood) => shipped(KIMM_FILES.sections[KIMM_ART_MOOD[mood]])),
  strip: shipped(KIMM_FILES.strip),
};

/** Whether a piece of her art can be drawn. */
export function isKimmArtReady<Ready extends object>(
  art: KimmArt<Ready>,
): art is { readonly state: "ready" } & Ready {
  return art.state === "ready";
}
