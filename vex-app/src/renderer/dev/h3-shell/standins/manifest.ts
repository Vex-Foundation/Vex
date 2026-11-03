/**
 * KIMM STAND-INS - dev-only art for building her section before her real art
 * arrives.
 *
 * WHAT THESE ARE. Crops of the H3 mockup captures, cut at the captures' own
 * resolution and never resampled: the captures are 1600 px images of a
 * 1440 px page, so a stand-in has about 1.1 image pixels per CSS pixel and
 * looks soft on a 2x screen. There are six portrait key moods from the
 * key-moods plate, her open section in the three moods the captures show it
 * in, and the glyph field the closed 56 px strip shows. `README.md` lists
 * every file with the capture and the box it was cut from.
 *
 * HARNESS ONLY. Nothing outside `dev/h3-shell/` may import this module. Every
 * file name starts with `kimm-standin-`, and Vite keeps that prefix when it
 * hashes an asset name, so `scripts/check-build-artifacts.mjs` can refuse a
 * production build that carries one into `dist/`. Her real files replace these
 * in plan row S4-18 (`public/art/kimm/`, registered in `BRAND_ASSETS` with
 * size limits, behind the asset seam of row S4-01), and this directory is
 * deleted then.
 *
 * WHAT THE CAPTURES DREW OVER HER. A crop keeps whatever UI the mockup laid on
 * top of her. The open sections carry the Hide Vex cell in their top-right
 * corner and the think portrait carries the running square; each of those
 * files names the box in `bakedIn`, so harness code can draw the real control
 * over it. The held portrait is the offer pose with the mockup's dimming
 * already applied, so code should not dim it again.
 *
 * URLS. Each `src` is a `new URL(<literal>, import.meta.url)`, which Vite
 * resolves both in its dev server and in a build, as
 * `features/appShell/lighterTrading/market-marks.ts` does for its local mark.
 */

/** Her portrait key moods, as the key-moods plate draws them. */
export type KimmStandinMood = "hi" | "think" | "offer" | "held" | "refused" | "rest";

/** The moods an open-section capture exists for. The others have none. */
export type KimmStandinSectionMood = "hi" | "offer" | "rest";

/** A box in image pixels: left and top included, right and bottom excluded. */
export type PixelBox = readonly [left: number, top: number, right: number, bottom: number];

/** One stand-in file. */
export interface KimmStandin {
  /** Where the harness's dev server serves the file. */
  readonly src: string;
  /** Its size in image pixels. */
  readonly width: number;
  readonly height: number;
  /** The mockup capture it was cut from, and the box in that capture's pixels. */
  readonly cutFrom: { readonly capture: string; readonly box: PixelBox };
  /** UI the capture drew over her that her real art will not carry, in this file's pixels. */
  readonly bakedIn?: { readonly what: string; readonly box: PixelBox };
}

/** Every stand-in, in one object for the harness to import. */
export interface KimmStandinManifest {
  /** Image pixels per CSS pixel in every capture (1600 px of a 1440 px page). */
  readonly pxPerCssPx: number;
  /** Her portrait key, 83 x 83, one per mood. The key cell is 76 CSS px square. */
  readonly portraits: Readonly<Record<KimmStandinMood, KimmStandin>>;
  /**
   * Her open section, 478 x 625: the figure on the blue glyph field as it
   * fills the Vex column (432 x 563 CSS px in the plate). The rightmost column
   * of the capture is the Vex column's rule and is left out.
   */
  readonly sections: Readonly<Record<KimmStandinSectionMood, KimmStandin>>;
  /**
   * The glyph field alone, 314 x 61, as the closed 56 px strip shows it. It
   * stops where the Show Vex cell starts: the field is the strip's first
   * 283 CSS px and the cell takes the other 149.
   */
  readonly strip: KimmStandin;
}

const KEY_MOODS_PLATE = "landing-r3__plate-key-moods.webp";

/** The Hide Vex cell in an open section: 138 x 56 CSS px, flush top and right. */
const HIDE_VEX_CELL = { what: "Hide Vex cell", box: [326, 0, 478, 62] } as const;

function portrait(src: string, box: PixelBox, bakedIn?: KimmStandin["bakedIn"]): KimmStandin {
  return {
    src,
    width: 83,
    height: 83,
    cutFrom: { capture: KEY_MOODS_PLATE, box },
    ...(bakedIn ? { bakedIn } : {}),
  };
}

function section(src: string, capture: string): KimmStandin {
  return {
    src,
    width: 478,
    height: 625,
    cutFrom: { capture, box: [276, 294, 754, 919] },
    bakedIn: HIDE_VEX_CELL,
  };
}

export const KIMM_STANDINS: KimmStandinManifest = {
  pxPerCssPx: 1600 / 1440,
  portraits: {
    hi: portrait(
      new URL("./kimm-standin-portrait-hi.webp", import.meta.url).href,
      [23, 131, 106, 214],
    ),
    think: portrait(
      new URL("./kimm-standin-portrait-think.webp", import.meta.url).href,
      [282, 131, 365, 214],
      { what: "running square", box: [0, 0, 16, 16] },
    ),
    offer: portrait(
      new URL("./kimm-standin-portrait-offer.webp", import.meta.url).href,
      [540, 131, 623, 214],
    ),
    held: portrait(
      new URL("./kimm-standin-portrait-held.webp", import.meta.url).href,
      [800, 131, 883, 214],
    ),
    refused: portrait(
      new URL("./kimm-standin-portrait-refused.webp", import.meta.url).href,
      [1060, 131, 1143, 214],
    ),
    rest: portrait(
      new URL("./kimm-standin-portrait-rest.webp", import.meta.url).href,
      [1319, 131, 1402, 214],
    ),
  },
  sections: {
    hi: section(
      new URL("./kimm-standin-section-hi.webp", import.meta.url).href,
      "h3-merged__welcome-open-1440.webp",
    ),
    offer: section(
      new URL("./kimm-standin-section-offer.webp", import.meta.url).href,
      "h3-merged__approval-open-1440.webp",
    ),
    rest: section(
      new URL("./kimm-standin-section-rest.webp", import.meta.url).href,
      "h3-merged__portfolio-open-1440.webp",
    ),
  },
  strip: {
    src: new URL("./kimm-standin-strip-field.webp", import.meta.url).href,
    width: 314,
    height: 61,
    cutFrom: { capture: "h3-merged__welcome-closed-1440.webp", box: [276, 294, 590, 355] },
  },
};
