/**
 * KIMM'S FILES IN THE BRAND ASSET REGISTRY (docs/design/H3-DESKTOP.md
 * sections 1.5, 1.6 and 3.5; plan rows S4-01 and S4-18).
 *
 * Her art comes from the designer and is not in the repo yet. These are the
 * files the renderer's Kimm asset seam
 * (`src/renderer/components/vex/kimm/kimm-assets.ts`) expects under
 * `src/renderer/public/art/kimm/`, registered before they exist so their
 * budgets are set before the first byte lands rather than read off whatever
 * arrives. `check-build-artifacts.mjs` spreads them into `BRAND_ASSETS`.
 *
 * AWAITED, THEN ENFORCED. Every entry here is `awaited`: while its file is
 * absent from the renderer's public source it is reported as awaited and
 * skipped, so the build passes today; the moment the file is in the source
 * it is checked like any other brand asset (present in dist/renderer/,
 * decodes, its format, its byte budget, no EXIF, IPTC or XMP). Its width and
 * height are not known until the art exists, so they are `null` here, and an
 * arrived file whose dimensions are still `null` fails until S4-18 pins them:
 * a file in the bundle with no pinned size is a file nobody checked.
 * Keyed on the source, not on dist/, so a file that is in the source but did
 * not reach the build is a failure, never a skip.
 *
 * THE BUDGETS, chosen on 4 November 2026 before the art exists:
 *   - the key's mood sprite, every drawn mood in one file: 30 KB (30,720
 *     bytes).
 *     The mockup's sprite is 28.5 KB (`stills/key-moods.webp` on the mood
 *     plate); closed, it is the only Kimm file that loads (section 3.5);
 *   - her open section, one per mood: 400 KB (409,600 bytes) each. Loaded only
 *     when her section first opens (S4-05);
 *   - the closed strip's glyph field frame: 64 KB (65,536 bytes). The strip is
 *     432 x 56 CSS px at 1440, 864 x 112 at 2x; the mockup crop of it
 *     (314 x 61) is 11.6 KB lossless.
 * Raise one only with the file in hand and the reason beside it.
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
  keyMoods: 30 * 1024,
  section: 400 * 1024,
  strip: 64 * 1024,
});

function awaited(file, maxBytes) {
  return Object.freeze({ file, format: "webp", width: null, height: null, maxBytes, awaited: true });
}

/** Every file the seam expects, as `BRAND_ASSETS` entries. */
export const KIMM_BRAND_ASSETS = Object.freeze([
  awaited(`${KIMM_ART_DIR}/key-moods.webp`, KIMM_BUDGETS.keyMoods),
  ...KIMM_MOODS.map((mood) => awaited(`${KIMM_ART_DIR}/section-${mood}.webp`, KIMM_BUDGETS.section)),
  awaited(`${KIMM_ART_DIR}/strip.webp`, KIMM_BUDGETS.strip),
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
