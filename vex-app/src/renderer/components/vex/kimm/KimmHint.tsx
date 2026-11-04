/**
 * THE FIRST CLOSE TEACHES THE WAY BACK, ONCE (docs/design/H3-DESKTOP.md
 * section 3.5 and Appendix A.3; plan row S4-15): the first time her section
 * closes, the key's name and its keycaps, "Show Vex" and Ctrl, Shift, B (⌘,
 * ⇧, B on a Mac), stand under the Vex key for 2.4 seconds, over Vex's column
 * only. Cloud shows it once per browser; desktop once per profile, behind a
 * saved flag (`kimmHintShown` in the persisted layout store). Under reduced
 * motion and Save-Data it still shows, without its fade.
 *
 * This component draws the hint; the mount (`features/vex/VexPortraitPlate.tsx`)
 * decides when: on a close, never on a mount that starts closed, only while
 * the flag is unset, and it sets the flag as the hint shows, so a second close
 * (in this window or any later one) never shows it. The words are a status
 * (`role="status"`), so a screen reader hears the way back too. It takes no
 * pointer: it teaches the key, it is not one.
 */

import type { JSX } from "react";

/** How long the hint stands: printed, "for 2.4 s". */
export const KIMM_HINT_MS = 2400;

export interface KimmHintProps {
  /** The chord's keys as the hint spells them: title case, or the Mac glyphs. */
  readonly keys: readonly string[];
}

export function KimmHint({ keys }: KimmHintProps): JSX.Element {
  return (
    <div role="status" data-vex-area="kimm-hint" className="vex-kimm-hint">
      <span className="vex-kimm-hint__name">Show Vex</span>
      <span className="vex-kimm-hint__caps">
        {keys.map((key) => (
          <kbd key={key} className="vex-kimm-hint__cap">
            {key}
          </kbd>
        ))}
      </span>
    </div>
  );
}
