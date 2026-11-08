/**
 * KIMM'S STAND-IN ART AS AN ART SET - the dev-only crops of the mockup
 * (`standins/manifest.ts`) in the shape every Kimm surface draws from
 * (`KimmArtSet`, `components/vex/kimm/kimm-assets.ts`), so the harness can
 * hand them to the real shell through `KimmArtProvider`, beside the art the
 * app itself ships (plan row S4-18; `?kimm=shipped` shows that instead).
 *
 * HARNESS ONLY, like the manifest it reads: nothing outside `dev/h3-shell/`
 * imports this module, and the build check refuses a production build that
 * carries a stand-in into `dist/`.
 *
 * What maps where:
 *   - portraits: each mood's stand-in is its own 83 x 83 file, so each is a
 *     one-cell "sheet" whose cell is the whole file, as her real chips are. Held is drawn from offer's crop, as the seam draws
 *     it from offer's file (`KIMM_ART_MOOD`), and the sheet dims it; the
 *     plate's own held crop, dimmed already, is not used. Signed has no crop
 *     on the plate, so it stays `missing`.
 *   - sections: the captures show her open section in three moods (hi, offer,
 *     rest), and held takes offer's. The others (think, signed, refused) have
 *     no capture, so they stay `missing` here as in the app: her section then
 *     shows its ground and the glyph field with no figure, never another
 *     mood's figure.
 *   - field: the glyph field's baked frames have no stand-in; the harness
 *     takes the app's own (`KIMM_SHIPPED_ART.field`, VEX Cloud's renders in
 *     `public/art/kimm/`, which the harness's config serves too). The strip
 *     is her section's own top 56, with no file of its own.
 *
 * The open crops carry the mockup's Hide Vex cell in their top-right corner
 * (`bakedIn`); her section draws its real corner key over that box.
 */

import {
  KIMM_ART_MOOD,
  KIMM_SHIPPED_ART,
  type KimmArt,
  type KimmArtSet,
  type KimmImage,
  type KimmMood,
  type KimmPortraitCell,
} from "../../components/vex/kimm/kimm-assets.js";
import { KIMM_STANDINS, type KimmStandin } from "./standins/manifest.js";

function image(standin: KimmStandin): KimmImage {
  return { src: standin.src, width: standin.width, height: standin.height };
}

function portrait(standin: KimmStandin): KimmArt<KimmPortraitCell> {
  return { state: "ready", sheet: image(standin), cell: [0, 0, standin.width, standin.height] };
}

function section(mood: KimmMood): KimmArt {
  const drawn = KIMM_ART_MOOD[mood];
  const standin = drawn === "hi" || drawn === "offer" || drawn === "rest" ? KIMM_STANDINS.sections[drawn] : null;
  if (standin === null) return { state: "missing", file: `the mockup has no ${mood} section to stand in` };
  return { state: "ready", ...image(standin) };
}

export const KIMM_STANDIN_ART: KimmArtSet = {
  portraits: {
    hi: portrait(KIMM_STANDINS.portraits.hi),
    think: portrait(KIMM_STANDINS.portraits.think),
    offer: portrait(KIMM_STANDINS.portraits.offer),
    held: portrait(KIMM_STANDINS.portraits.offer),
    signed: { state: "missing", file: "the mood plate has no signed portrait to stand in" },
    refused: portrait(KIMM_STANDINS.portraits.refused),
    rest: portrait(KIMM_STANDINS.portraits.rest),
  },
  sections: {
    hi: section("hi"),
    think: section("think"),
    offer: section("offer"),
    held: section("held"),
    signed: section("signed"),
    refused: section("refused"),
    rest: section("rest"),
  },
  field: KIMM_SHIPPED_ART.field,
};
