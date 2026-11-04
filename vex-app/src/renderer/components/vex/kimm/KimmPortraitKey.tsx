/**
 * HER PORTRAIT IN THE VEX KEY (docs/design/H3-DESKTOP.md section 1.6; plan
 * row S4-03): what the Vex key's portrait cell shows.
 *
 *   - CLOSED, her face: one cell of the key's mood sprite, scaled so the cell
 *     fills the box edge to edge, for her mood. The key maps her presence
 *     state to the mood (`kimmMoodOf`, `features/vex/kimm-mood.ts`) and
 *     passes it in, so this component stays below the features it serves. A
 *     change of state is a change of cell on the same sheet, so it never
 *     waits on a request.
 *   - OPEN, the fold glyph (a bar over an up chevron) on the raised fill: she
 *     has stepped down into her section, and the glyph says a press folds
 *     her back up. The glyph is drawn, not art, so it shows whether her art
 *     has arrived or not.
 *   - CLOSED WITH NO ART: her sprite is `missing` until her files arrive
 *     (`kimm-assets.ts`), and a missing piece is drawn as no art at all,
 *     never a placeholder face. The cell then shows `fallback`, which the key
 *     sets to the small token it already carries, or nothing.
 *
 * THE SLOT. This is the content of the key's portrait cell and nothing more:
 * it owns no press, no name and no state word, since the key is one control
 * whose name is the action ("Show Vex", "Hide Vex"; section 1.6) and whose
 * state cell says her state in words. So it is `aria-hidden`, and the key
 * that mounts it passes the two things it already knows: her mood (from her
 * presence state) and whether her section is open, AS THE PRESS LEFT IT (the
 * words change at the press, section 3.3, and so does this cell). Today's
 * forerunner of the key, the title bar's token chip (`VexTokenChip.tsx`),
 * mounts it in place of its token at the chip's own 22px; the Vex key (plan
 * row S3-02) mounts it in its 76px portrait cell, the default `size`.
 *
 * Her art comes from the nearest `KimmArtProvider` (`kimm-art-context.tsx`):
 * the shipped art in the app, the harness's stand-ins in the H3 harness.
 */

import type { JSX, ReactNode } from "react";
import { LineSvg } from "../../icons/line/LineSvg.js";
import { cn } from "../../../lib/utils.js";
import { isKimmArtReady, type KimmMood } from "./kimm-assets.js";
import { useKimmArt } from "./kimm-art-context.js";

/** The Vex key's portrait cell, 76 x 76 (section 1.6). */
export const KIMM_KEY_CELL_PX = 76;

export interface KimmPortraitKeyProps {
  /** Her mood: `kimmMoodOf` of Vex's presence state. */
  readonly mood: KimmMood;
  /** Her section is open, as the press left it: the fold glyph instead of her face. */
  readonly open: boolean;
  /** The cell's edge in CSS px; the Vex key's 76 by default. */
  readonly size?: number;
  /** What the closed cell shows while her sprite is missing: nothing by default. */
  readonly fallback?: ReactNode;
  readonly className?: string;
}

/** A bar over an up chevron, on the line icons' 16 grid: fold her section up. */
function FoldGlyph(): JSX.Element {
  return (
    <LineSvg size={16}>
      <path d="M3.5 3.5h9M4 11.5l4-4 4 4" />
    </LineSvg>
  );
}

export function KimmPortraitKey({
  mood,
  open,
  size = KIMM_KEY_CELL_PX,
  fallback = null,
  className,
}: KimmPortraitKeyProps): JSX.Element {
  const art = useKimmArt();
  const portrait = art.portraits[mood];
  let content: ReactNode;
  if (open) {
    content = <FoldGlyph />;
  } else if (isKimmArtReady(portrait)) {
    // The cell fills the box: the whole sheet is scaled by the box over the
    // cell, then moved so the cell's corner sits on the box's corner. Sizes
    // reach the element as CSSOM properties (React's `style`), which the
    // strict CSP allows (MOTION-POLICY.md, "CSP precise semantics").
    const [left, top, right, bottom] = portrait.cell;
    const scaleX = size / (right - left);
    const scaleY = size / (bottom - top);
    content = (
      <img
        src={portrait.sheet.src}
        alt=""
        draggable={false}
        decoding="async"
        className="vex-kimm-key__sheet"
        style={{
          width: portrait.sheet.width * scaleX,
          height: portrait.sheet.height * scaleY,
          left: -left * scaleX,
          top: -top * scaleY,
        }}
      />
    );
  } else {
    content = fallback;
  }
  return (
    <span
      aria-hidden="true"
      data-vex-area="kimm-portrait-key"
      data-kimm-key={open ? "open" : "closed"}
      data-kimm-mood={mood}
      data-kimm-art={open || isKimmArtReady(portrait) ? "ready" : "missing"}
      className={cn("vex-kimm-key", className)}
      style={{ width: size, height: size }}
    >
      {content}
    </span>
  );
}
