/**
 * KIMM'S STAND-IN ART AS AN ART SET - the dev-only crops of the mockup
 * (`standins/manifest.ts`) in the shape every Kimm surface draws from
 * (`KimmArtSet`, `components/vex/kimm/kimm-assets.ts`), so the harness can
 * hand them to the real shell through `KimmArtProvider` while the app itself
 * ships every piece `missing` until her files arrive (plan row S4-18).
 *
 * HARNESS ONLY, like the manifest it reads: nothing outside `dev/h3-shell/`
 * imports this module, and the build check refuses a production build that
 * carries a stand-in into `dist/`.
 *
 * What maps where:
 *   - portraits: each mood's stand-in is its own 83 x 83 file, so each is a
 *     one-cell "sheet" whose cell is the whole file. Her real art is one
 *     sprite with six cells (`key-moods.webp`); the surface draws either the
 *     same way.
 *   - sections: the captures show her open section in three moods (hi, offer,
 *     rest). The other three (think, held, refused) have no capture, so they
 *     stay `missing` here as in the app: her section then shows its ground
 *     and the glyph field with no figure, never another mood's figure.
 *   - strip: the closed strip's glyph field.
 *
 * The open crops carry the mockup's Hide Vex cell in their top-right corner
 * (`bakedIn`); her section draws its real corner key over that box.
 */

import type { KimmArt, KimmArtSet, KimmImage, KimmMood, KimmPortraitCell } from "../../components/vex/kimm/kimm-assets.js";
import { KIMM_STANDINS, type KimmStandin } from "./standins/manifest.js";

function image(standin: KimmStandin): KimmImage {
  return { src: standin.src, width: standin.width, height: standin.height };
}

function portrait(standin: KimmStandin): KimmArt<KimmPortraitCell> {
  return { state: "ready", sheet: image(standin), cell: [0, 0, standin.width, standin.height] };
}

function section(mood: KimmMood): KimmArt {
  const standin = mood === "hi" || mood === "offer" || mood === "rest" ? KIMM_STANDINS.sections[mood] : null;
  if (standin === null) return { state: "missing", file: `the mockup has no ${mood} section to stand in` };
  return { state: "ready", ...image(standin) };
}

export const KIMM_STANDIN_ART: KimmArtSet = {
  portraits: {
    hi: portrait(KIMM_STANDINS.portraits.hi),
    think: portrait(KIMM_STANDINS.portraits.think),
    offer: portrait(KIMM_STANDINS.portraits.offer),
    held: portrait(KIMM_STANDINS.portraits.held),
    refused: portrait(KIMM_STANDINS.portraits.refused),
    rest: portrait(KIMM_STANDINS.portraits.rest),
  },
  sections: {
    hi: section("hi"),
    think: section("think"),
    offer: section("offer"),
    held: section("held"),
    refused: section("refused"),
    rest: section("rest"),
  },
  strip: { state: "ready", ...image(KIMM_STANDINS.strip) },
};
