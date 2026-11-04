/**
 * THE VEX KEY'S PORTRAIT CELL (docs/design/H3-DESKTOP.md section 1.6): the
 * key's first cell, 76 x 76.
 *
 *   - OPEN, the fold glyph (a bar over an up chevron) on the raised fill: she
 *     has stepped down into her section, and the key folds her back up.
 *   - CLOSED, her face: one cell of Kimm's mood sprite, the mood
 *     `kimmMoodOf(state)` names, drawn by her portrait key
 *     (`components/vex/kimm/KimmPortraitKey.tsx`, plan row S4-03) from the
 *     nearest art set (the stand-ins in the H3 harness). While her sprite is
 *     missing, as it is until her art arrives (S4-18), the closed cell is
 *     drawn empty: no stand-in face and no blue token, since H3's one blue
 *     fills primary keys only.
 *
 * THE SEAM FOR S4-03. This file is the whole of the portrait: `VexKey` hands
 * it whether her section is open and her presence state, and draws its cell
 * around whatever it returns. Kimm's portrait key fills the closed branch here
 * (from `kimm-mood.ts` and `components/vex/kimm/`), and nothing in `VexKey`
 * changes. Closed, only this mood sprite loads (section 3.5: "Closed costs
 * little").
 */

import type { JSX } from "react";
import { LineSvg } from "../../components/icons/line/index.js";
import { KimmPortraitKey } from "../../components/vex/kimm/KimmPortraitKey.js";
import { kimmMoodOf } from "./kimm-mood.js";
import type { VexState } from "./vex-state.js";

export interface VexKeyPortraitProps {
  /** Her section is open (the key folds her up), as the key reads it at the press. */
  readonly open: boolean;
  /** Her presence state, for the mood her face shows while closed (S4-03). */
  readonly state: VexState;
}

/** The fold glyph: a bar, and under it an up chevron. */
function FoldGlyph(): JSX.Element {
  return (
    <LineSvg size={20}>
      <path d="M3.5 4h9" />
      <path d="M4 11.5l4-4 4 4" />
    </LineSvg>
  );
}

export function VexKeyPortrait({ open, state }: VexKeyPortraitProps): JSX.Element | null {
  if (open) return <FoldGlyph />;
  return <KimmPortraitKey mood={kimmMoodOf(state)} open={false} />;
}
