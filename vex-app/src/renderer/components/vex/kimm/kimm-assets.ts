/**
 * KIMM'S ART, ONE SEAM (docs/design/H3-DESKTOP.md sections 1.5, 1.6 and 3.5;
 * plan rows S4-01 to S4-05 and S4-18). The one place that says which file
 * each of her moods and her section's ground are drawn from. Every Kimm
 * surface (the Vex key's portrait cell, her section) reads her art through a
 * `KimmArtSet`, so no component names a path. Closed, her section is its own
 * top 56 (section 1.5): the strip has no file of its own.
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
 * THE FILES, under `public/art/kimm/` (served at `/art/kimm/`): VEX Cloud's
 * ready-made renders of her (its `apps/web/public/kimm/v1/stills/`, byte
 * copies under the same names; `public/art/kimm/NOTICE.md` says where they
 * came from):
 *   - `chip-{mood}.webp`, 150 x 150: her face in the Vex key's portrait cell,
 *     one per drawn mood, as Cloud's header draws it (`KimmStill` "chip").
 *     Closed, a chip is the only Kimm file that loads (section 3.5).
 *   - `still-{mood}.webp`, 720 wide (1032 to 1104 tall by pose): her figure
 *     in her open section, one per drawn mood. Loaded only when her section
 *     first opens (S4-05).
 *   - `field-still.webp` (780 x 652) and `field-still-wide.webp` (1536 x
 *     1972, from a 1600 window): the glyph field's baked frame, her section's
 *     ground until the live field has painted (section 1.5).
 * Cloud's phone stills (head to chest, 1040 x 589) are not taken: desktop's
 * window floor is 1000 wide and its band (1000 to 1023) frames the section
 * still. Its `key-moods.webp` sprite is the home page's, not the header's.
 * Their pixel sizes are pinned here (`KIMM_ARRIVED`) and, with their byte
 * budgets, in the build check's brand asset registry
 * (`scripts/kimm-brand-assets.mjs`, spread into `BRAND_ASSETS` in
 * `scripts/check-build-artifacts.mjs`), where the reasons are. A file that
 * leaves the folder turns its piece `missing`: a surface then draws no art
 * for it, never a placeholder or another mood's figure (`AGENTS.md`: no mock
 * presented as production). The seam's test holds the two honest both ways.
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
  chips: {
    hi: `${KIMM_ART_DIR}/chip-hi.webp`,
    think: `${KIMM_ART_DIR}/chip-think.webp`,
    offer: `${KIMM_ART_DIR}/chip-offer.webp`,
    signed: `${KIMM_ART_DIR}/chip-signed.webp`,
    refused: `${KIMM_ART_DIR}/chip-refused.webp`,
    rest: `${KIMM_ART_DIR}/chip-rest.webp`,
  },
  stills: {
    hi: `${KIMM_ART_DIR}/still-hi.webp`,
    think: `${KIMM_ART_DIR}/still-think.webp`,
    offer: `${KIMM_ART_DIR}/still-offer.webp`,
    signed: `${KIMM_ART_DIR}/still-signed.webp`,
    refused: `${KIMM_ART_DIR}/still-refused.webp`,
    rest: `${KIMM_ART_DIR}/still-rest.webp`,
  },
  field: {
    still: `${KIMM_ART_DIR}/field-still.webp`,
    wide: `${KIMM_ART_DIR}/field-still-wide.webp`,
  },
} as const satisfies {
  readonly chips: Readonly<Record<KimmDrawnMood, string>>;
  readonly stills: Readonly<Record<KimmDrawnMood, string>>;
  readonly field: { readonly still: string; readonly wide: string };
};

/** An image her art is drawn from: where it is served and its size in image pixels. */
export interface KimmImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** A box in image pixels: left and top included, right and bottom excluded. */
export type KimmPixelBox = readonly [left: number, top: number, right: number, bottom: number];

/** One mood's portrait: a cell of a sheet (her chip is a sheet whose one cell is the whole file). */
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
  /** The glyph field's baked frame: under a 1600 window, and from 1600. */
  readonly field: { readonly still: KimmArt; readonly wide: KimmArt };
}

/**
 * The files that are in the app, with their pixel sizes, keyed by their path
 * under the public root: the same sizes their `BRAND_ASSETS` entries pin.
 */
const KIMM_ARRIVED: Readonly<Partial<Record<string, { readonly width: number; readonly height: number }>>> = {
  [KIMM_FILES.chips.hi]: { width: 150, height: 150 },
  [KIMM_FILES.chips.think]: { width: 150, height: 150 },
  [KIMM_FILES.chips.offer]: { width: 150, height: 150 },
  [KIMM_FILES.chips.signed]: { width: 150, height: 150 },
  [KIMM_FILES.chips.refused]: { width: 150, height: 150 },
  [KIMM_FILES.chips.rest]: { width: 150, height: 150 },
  [KIMM_FILES.stills.hi]: { width: 720, height: 1033 },
  [KIMM_FILES.stills.think]: { width: 720, height: 1096 },
  [KIMM_FILES.stills.offer]: { width: 720, height: 1044 },
  [KIMM_FILES.stills.signed]: { width: 720, height: 1042 },
  [KIMM_FILES.stills.refused]: { width: 720, height: 1104 },
  [KIMM_FILES.stills.rest]: { width: 720, height: 1032 },
  [KIMM_FILES.field.still]: { width: 780, height: 652 },
  [KIMM_FILES.field.wide]: { width: 1536, height: 1972 },
};

function shipped(file: string): KimmArt {
  const size = KIMM_ARRIVED[file];
  if (size === undefined) return { state: "missing", file };
  return { state: "ready", src: `/${file}`, width: size.width, height: size.height };
}

/** Her portrait: her mood's chip, a sheet whose one cell is the whole file. */
function shippedPortrait(mood: KimmMood): KimmArt<KimmPortraitCell> {
  const chip = shipped(KIMM_FILES.chips[KIMM_ART_MOOD[mood]]);
  if (chip.state === "missing") return chip;
  return {
    state: "ready",
    sheet: { src: chip.src, width: chip.width, height: chip.height },
    cell: [0, 0, chip.width, chip.height],
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

/** Her art as the app ships it. */
export const KIMM_SHIPPED_ART: KimmArtSet = {
  portraits: byMood(shippedPortrait),
  sections: byMood((mood) => shipped(KIMM_FILES.stills[KIMM_ART_MOOD[mood]])),
  field: { still: shipped(KIMM_FILES.field.still), wide: shipped(KIMM_FILES.field.wide) },
};

/** Whether a piece of her art can be drawn. */
export function isKimmArtReady<Ready extends object>(
  art: KimmArt<Ready>,
): art is { readonly state: "ready" } & Ready {
  return art.state === "ready";
}
