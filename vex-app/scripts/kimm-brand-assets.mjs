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

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * HER LIVE MODEL (owner decision, 15 November 2026: Kimm moves on desktop as
 * she does on VEX Cloud). Byte copies of VEX Cloud's
 * `apps/web/public/kimm/v1/lib/` and `apps/web/public/kimm/v1/model/`, under
 * the same names in `art/kimm/live/lib/` and `art/kimm/live/model/`
 * (`src/renderer/public/art/kimm/NOTICE.md`), named by the renderer only in
 * `src/renderer/components/vex/kimm/kimm-assets.ts` and loaded only by
 * `kimm-embed.ts`:
 *   - `lib/`: Live2D Cubism Core 5.0.0 (wasm2js: it defines its own
 *     `WebAssembly` object and compiles nothing, so the CSP needs no
 *     `'wasm-unsafe-eval'`), PIXI 6.5.10, the `@pixi/unsafe-eval` 6.5.10 shim
 *     (so PIXI needs no `'unsafe-eval'`) and pixi-live2d-display 0.4.0, in
 *     that load order;
 *   - `model/`: her settings, the moc (`kimm.moc.wasm` is a renamed MOC3, not
 *     WebAssembly: its first bytes are `MOC3`), physics, the idle loop and
 *     three textures (4096 x 4096, 4096 x 4096, 4096 x 2048, WebP, no
 *     metadata).
 * Each file is pinned by its exact size and sha256, the same pins as VEX
 * Cloud's `tests/guards/expected/kimm.expected.json`: a file that differs by
 * one byte, a file that is missing, and a file in the folder that is not
 * pinned all fail the build (`check-build-artifacts.mjs`, gate 6b) and the
 * seam's tests. 15,074,293 bytes in all (libraries 790,631, model
 * 14,283,662). Change a file only with a new pin and the reason beside it.
 */
export const KIMM_LIVE_DIR = `${KIMM_ART_DIR}/live`;

function live(file, bytes, sha256) {
  return Object.freeze({ file: `${KIMM_LIVE_DIR}/${file}`, bytes, sha256 });
}

export const KIMM_LIVE_FILES = Object.freeze([
  live("lib/live2dcubismcore.min.js", 206_492, "942783587666a3a1bddea93afd349e26f798ed19dcd7a52449d0ae3322fcff7c"),
  live("lib/pixi.min.js", 460_333, "403f2f2ee8145fa17f60c5c89403056efe2680e5096ec2762036486914ed19c5"),
  live("lib/unsafe-eval.min.js", 3_884, "94bb4bfdbd015087772ee03bc4117e253c326e8ca73a61646bd331b22f6847ad"),
  live("lib/cubism4.min.js", 119_922, "af1267e6d52759b245766c578d905bfa025b532d5c3cc727c370957c4409e21b"),
  live("model/kimm.model3.json", 379, "5e19da7aebb789ff08acb16e3e5c682d36a5f486b6cd7f17a48e00f99fb60b30"),
  live("model/kimm.moc.wasm", 11_488_768, "97c42011aa3de77dd0c883768583ce754aeb8d47f50d6cf6cd978cb7709f0683"),
  live("model/kimm.physics3.json", 124_647, "99de7fdc8cc5ef0d85d24aa0b44a374a8d616dbca56f9eb5f08ebff398af7d84"),
  live("model/idle.motion3.json", 3_964, "0b94d9d33b2e208468a01214947138b9753f4310a4b0aa21c13d33b6d0b6950a"),
  live("model/t0_4096.webp", 1_004_750, "2f742973f6f84f6b65234cf19b5ac8ed76a54c6d7621badc4ca08ff52b0cf0c8"),
  live("model/t1_4096.webp", 1_061_820, "41c0178c5a87b245ce18c15cac064e911afe0af1d128674defad183110aee339"),
  live("model/t2_4096.webp", 599_334, "6cb03bb0cc3ded61fb7fd596cc64453fda057d2b2b689f33da7e39e5da475cec"),
]);

/** Every file under `dir` (relative to `root`), as paths relative to `root` with `/` separators. */
function filesUnder(root, dir) {
  const full = path.join(root, dir);
  if (!existsSync(full)) return [];
  const found = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(root, relative));
    else found.push(relative);
  }
  return found;
}

/**
 * What is wrong with her live files under `root` (the renderer's public
 * source, or dist/renderer/ after a build): a pinned file missing or
 * different in size or sha256, and any file in the folder that is not
 * pinned. An empty list means the folder holds exactly the pinned bytes.
 */
export function kimmLiveFindings(root) {
  const findings = [];
  const pinned = new Set(KIMM_LIVE_FILES.map((entry) => entry.file));
  for (const entry of KIMM_LIVE_FILES) {
    const full = path.join(root, entry.file);
    if (!existsSync(full)) {
      findings.push(`${entry.file}: pinned but missing`);
      continue;
    }
    const size = statSync(full).size;
    if (size !== entry.bytes) {
      findings.push(`${entry.file}: ${size} bytes, pinned ${entry.bytes}`);
      continue;
    }
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (sha256 !== entry.sha256) findings.push(`${entry.file}: sha256 ${sha256} differs from its pin`);
  }
  for (const file of filesUnder(root, KIMM_LIVE_DIR)) {
    if (!pinned.has(file)) findings.push(`${file}: ships but is not pinned`);
  }
  return findings.sort();
}
