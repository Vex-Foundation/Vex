/**
 * KIMM'S FILES IN THE BRAND ASSET REGISTRY (docs/design/H3-DESKTOP.md
 * sections 1.5, 1.6 and 3.5; plan rows S4-01 and S4-18).
 *
 * Her art is VEX Cloud's ready-made set (its `apps/web/public/kimm/v1/stills/`,
 * byte copies, `src/renderer/public/art/kimm/NOTICE.md`), in
 * `src/renderer/public/art/kimm/`, which the renderer's Kimm asset seam
 * (`src/renderer/components/vex/kimm/kimm-assets.ts`) draws from.
 * `check-build-artifacts.mjs` spreads these entries into `BRAND_ASSETS`, so
 * each file is checked like any other brand asset: present in
 * dist/renderer/, decodes, WebP, its pinned width and height, its byte
 * budget, no EXIF, IPTC or XMP.
 *
 * THE BUDGETS, set on 8 November 2026 with the files in hand (each about a
 * fifth over the largest file of its kind, so a re-encode of the same render
 * fits and a different render does not slip in unseen):
 *   - her chips, 150 x 150, one per drawn mood: 8 KB (8,192 bytes) each.
 *     The largest is 6,138 bytes (`chip-hi.webp`). Closed, a chip is the only
 *     Kimm file that loads (section 3.5);
 *   - her section stills, 720 wide, one per drawn mood: 96 KB (98,304 bytes)
 *     each. The largest is 81,544 bytes (`still-refused.webp`). Loaded only
 *     when her section first opens (S4-05);
 *   - the field's baked frame, 780 x 652: 24 KB (24,576 bytes); it is 20,358;
 *   - the field's frame from a 1600 window, 1536 x 1972: 52 KB (53,248
 *     bytes); it is 43,684.
 * Raise one only with the file in hand and the reason beside it.
 *
 * AWAITED ENTRIES. The registry can still hold a file registered before it
 * exists (`awaited: true`, width and height `null`): skipped while absent
 * from the renderer's public source, refused once it arrives until its size
 * is pinned (`brandAssetPlan`). None of Kimm's entries is awaited now.
 *
 * Data plus one pure decision, so the seam's tests can read the same list the
 * build check enforces.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Her moods drawn from a file of their own, in the seam's order
 * (`KIMM_DRAWN_MOODS`): the mood plate's (`landing-r3__plate-key-moods`) and
 * VEX Cloud's `signed`. Held has no file: it is offer's, dimmed by the sheet
 * (`kimm-assets.ts`, "HELD IS OFFER, DIMMED").
 */
export const KIMM_MOODS = Object.freeze(["hi", "think", "offer", "signed", "refused", "rest"]);

/** Where her files sit, relative to the renderer's public root (and to dist/renderer/). */
export const KIMM_ART_DIR = "art/kimm";

/** The byte budgets above. */
export const KIMM_BUDGETS = Object.freeze({
  chip: 8 * 1024,
  still: 96 * 1024,
  fieldStill: 24 * 1024,
  fieldStillWide: 52 * 1024,
});

/** Each section still's height (720 wide; each pose has its own height, as Cloud's `SECTION_HEIGHT`). */
export const KIMM_STILL_HEIGHTS = Object.freeze({
  hi: 1033,
  think: 1096,
  offer: 1044,
  signed: 1042,
  refused: 1104,
  rest: 1032,
});

function pinned(file, width, height, maxBytes) {
  return Object.freeze({ file, format: "webp", width, height, maxBytes });
}

/** Every file the seam draws from, as `BRAND_ASSETS` entries. */
export const KIMM_BRAND_ASSETS = Object.freeze([
  ...KIMM_MOODS.map((mood) => pinned(`${KIMM_ART_DIR}/chip-${mood}.webp`, 150, 150, KIMM_BUDGETS.chip)),
  ...KIMM_MOODS.map((mood) =>
    pinned(`${KIMM_ART_DIR}/still-${mood}.webp`, 720, KIMM_STILL_HEIGHTS[mood], KIMM_BUDGETS.still),
  ),
  pinned(`${KIMM_ART_DIR}/field-still.webp`, 780, 652, KIMM_BUDGETS.fieldStill),
  pinned(`${KIMM_ART_DIR}/field-still-wide.webp`, 1536, 1972, KIMM_BUDGETS.fieldStillWide),
]);

/**
 * What the build check does with one registry entry:
 *   - `check`: an ordinary entry, or an awaited one whose file is in the
 *     renderer's public source: checked in full;
 *   - `awaiting`: an awaited entry whose file is not in the source yet:
 *     skipped, and said so;
 *   - `unpinned`: an awaited file that has arrived while its width or height
 *     is still `null`: a failure until the registry pins them.
 * `publicDir` is the renderer's public source (`src/renderer/public`).
 */
export function brandAssetPlan(entry, publicDir) {
  if (entry.awaited !== true) return "check";
  if (!existsSync(path.join(publicDir, entry.file))) return "awaiting";
  if (entry.width === null || entry.height === null) return "unpinned";
  return "check";
}
