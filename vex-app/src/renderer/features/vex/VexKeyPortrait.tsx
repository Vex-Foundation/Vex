/**
 * THE VEX KEY'S PORTRAIT CELL (docs/design/H3-DESKTOP.md section 1.6): the
 * key's first cell, 76 x 76, VEX Cloud's `.vk-face` (the H3 mockup's
 * app.css, 2026-11-05). Both of its pictures stand in the cell at once, and
 * the key's sheet crossfades them over 200ms as her section opens or closes
 * (at once under reduced motion and Save-Data):
 *
 *   - CLOSED, her face: one cell of Kimm's mood sprite, the mood
 *     `kimmMoodOf(state)` names, drawn by her portrait key
 *     (`components/vex/kimm/KimmPortraitKey.tsx`, plan row S4-03) from the
 *     nearest art set (the stand-ins in the H3 harness). While her sprite is
 *     missing, as it is until her art arrives, the closed cell is drawn
 *     empty: no stand-in face and no blue token, since H3's one blue fills
 *     primary keys only.
 *   - OPEN, the portrait glyph (Cloud's DG-1 `portrait`, a framed bust: the
 *     frame she left) in ink 2 at 20, on the open ground (`--vex-alias-cell-
 *     open`, Cloud's `--vx-cell-open`). The direction is the chevron cell's,
 *     never the glyph's.
 *
 * Whether she is open is the key's (`data-open` on the cell, as the press
 * left it): this file draws the two pictures and nothing else. Her face
 * keeps its closed drawing while she is open, so the crossfade has a face to
 * fade; it is her mood's cell of the one sprite, already loaded (section
 * 3.5: "Closed costs little").
 */

import type { JSX } from "react";
import { KimmPortraitKey } from "../../components/vex/kimm/KimmPortraitKey.js";
import type { KimmMood } from "../../components/vex/kimm/kimm-assets.js";
import { kimmMoodOf } from "./kimm-mood.js";
import type { VexState } from "./vex-state.js";

export interface VexKeyPortraitProps {
  /** Her presence state, for the mood her face shows while closed (S4-03). */
  readonly state: VexState;
  /** The mood where the place names its own (the stage's approved moods); `kimmMoodOf(state)` by default. */
  readonly mood?: KimmMood;
}

/**
 * The portrait glyph on Cloud's filled 24 grid (its `glyphs.svg#portrait`,
 * a DRAFT drawing, D-24): a square frame and, inside it, a bust.
 */
export function PortraitGlyph(): JSX.Element {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="vex-key__pic"
    >
      <path
        fillRule="evenodd"
        d="M3 3h18v18H3zM5 5v14h1.6c.5-3 2.7-5 5.4-5s4.9 2 5.4 5H19V5zm7 1.8a3.2 3.2 0 110 6.4 3.2 3.2 0 010-6.4z"
      />
    </svg>
  );
}

export function VexKeyPortrait({ state, mood }: VexKeyPortraitProps): JSX.Element {
  return (
    <>
      <KimmPortraitKey mood={mood ?? kimmMoodOf(state)} open={false} className="vex-key__chip" />
      <PortraitGlyph />
    </>
  );
}
