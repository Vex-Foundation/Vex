/**
 * KIMM'S SECTION (docs/design/H3-DESKTOP.md sections 1.5, 3 and 3.6; plan rows
 * S4-04 to S4-11): her figure on its blue ground, a fixed box laid OVER Vex's
 * column, with her corner key in its top right.
 *
 * THE BOX. Not a row of the column: a box over it, whose size is a function
 * of the window alone. Its left and width are the column's; its top is the
 * foot of the console's top block (the Needs you head 43, its row 64, the
 * missions row 40 and their rule: 148 under the header, desktop having no
 * strategies row, section 4.1); its foot is one pixel above the bottom row.
 * At 1440 x 900 that is 248, 224 and 603 high (section 1.5, "Desktop's
 * box"): 423 at a 720-high window, 503 at 800. Nothing about her enters the
 * frame's grid, and nothing in the column moves under her: the console
 * stands where it stands and she covers its rest. That is the second leg of
 * the money rule (section 3.6): a waiting card beside her never moves.
 *
 * WHAT IS IN IT, back to front: her ground (Kimm's blue gradient, one of the
 * two gradients H3 allows, section 2), her figure for her mood, and the
 * corner key. The figure is her art for the mood (`KimmArtSet.sections`); a
 * mood whose art is `missing` shows the ground alone, never another mood's
 * figure and never a placeholder. Her art comes from the nearest
 * `KimmArtProvider` (the shipped art in the app, the stand-ins in the H3
 * harness).
 *
 * THE CORNER KEY is the same control as the Vex key in the header, in the
 * same corner whatever her state (section 3.3): HIDE VEX and a cross while
 * she is open, a solid 56-high cell on a dark translucent fill over her
 * ground (138 wide, measured). Its name is the action, and its tooltip adds
 * the chord ("Hide Vex (Ctrl+Shift+B)", Appendix A.9). It writes the same
 * stored choice the Vex key writes (`onOpenChange`).
 *
 * THE MOUNT. This component draws; the feature that mounts it
 * (`features/vex/VexPortraitPlate.tsx`, in the Vex column where K2's print
 * window stood) maps her presence state to her mood, reads the platform's
 * chord and writes the store.
 *
 * The figure is decorative (`aria-hidden`): her state is said in words by the
 * Vex key and the console, so nothing depends on the picture.
 */

import type { JSX } from "react";
import { LineClose } from "../../icons/line/index.js";
import { isKimmArtReady, type KimmMood } from "./kimm-assets.js";
import { useKimmArt } from "./kimm-art-context.js";

/** The Vex toggle's chord on this platform, as the corner key spells it. */
export interface KimmShortcut {
  /** As a person reads it: `Ctrl+Shift+B`, `⇧⌘B`. */
  readonly label: string;
  /** As `aria-keyshortcuts` takes it: `Control+Shift+B`, `Meta+Shift+B`. */
  readonly aria: string;
}

export interface KimmSectionProps {
  /** Her mood: `kimmMoodOf` of Vex's presence state. */
  readonly mood: KimmMood;
  /** The corner key's press: show (true) or hide (false) her section. */
  readonly onOpenChange: (open: boolean) => void;
  /** The chord that does the same from anywhere, for the key's tooltip. */
  readonly shortcut?: KimmShortcut;
}

export function KimmSection({ mood, onOpenChange, shortcut }: KimmSectionProps): JSX.Element {
  const art = useKimmArt();
  const figure = art.sections[mood];
  return (
    <div
      data-vex-area="kimm-section"
      data-kimm-mood={mood}
      data-kimm-art={isKimmArtReady(figure) ? "ready" : "missing"}
      className="vex-kimm"
    >
      <div aria-hidden="true" className="vex-kimm__body">
        <div className="vex-kimm__ground" />
        {isKimmArtReady(figure) ? (
          <img
            src={figure.src}
            alt=""
            width={figure.width}
            height={figure.height}
            draggable={false}
            decoding="async"
            className="vex-kimm__figure"
          />
        ) : null}
      </div>
      <button
        type="button"
        data-vex-area="kimm-key"
        title={shortcut === undefined ? undefined : `Hide Vex (${shortcut.label})`}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => onOpenChange(false)}
        className="vex-kimm__key"
      >
        <span>Hide Vex</span>
        <LineClose size={14} />
      </button>
    </div>
  );
}
