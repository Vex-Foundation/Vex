/**
 * THE VEX CELL (docs/design/H3-DESKTOP.md section 6.2; the owner's D2
 * plates, 2026-11-09): the header's cell over Vex's column at the right
 * edge. "VEX" in caps at its left and, at its right end, a 44 square key with
 * the panel glyph that hides or shows her whole column:
 *
 *   [data-vex-head-cell="vex-key"] (ShellHeader's slot)
 *     .vex-head-vex__word          VEX, written "Vex" and set in caps
 *     button.vex-head-vex__key[data-vex-area="vex-key"]
 *                                  44 x 44, the panel glyph
 *
 * It replaces H3's Vex key (her portrait, her state word, the keycaps and
 * the chevron) in the shell; her state now stands in her column's state row
 * (`VexStateRow`). The Lighter desk keeps H3's key (its approved plate).
 *
 * ONE CONTROL, NAMED FOR WHAT IT DOES (VEX Cloud's EC-01, as the Vex key
 * was): "Hide Vex" while she shows, "Show Vex" while she is hidden, the name
 * following the state, `aria-controls` naming her column (her band under
 * 1024), no `aria-expanded` or `aria-pressed`. The tooltip and
 * `aria-keyshortcuts` carry the chord (Ctrl+Shift+B, Cmd+Shift+B on a Mac);
 * the state word describes the key, so a screen reader hears her state where
 * the eye reads it in her column. Every press is said once, politely, "Vex
 * shown." or "Vex hidden." (EC-24), by the announcer beside the key.
 *
 * The cell always stands, whatever she shows: hidden, the column keeps its
 * room and its rule, and the cell keeps VEX and the key, so she can come
 * back. It also holds the two announcers the Vex key held (her state word,
 * her shown or hidden press), so they speak wherever she is.
 *
 * UNDER 1024 (section 1.10) the key opens and closes her band. While the
 * band rests (`held`: a turn, a waiting card, the composer in use) the key
 * says why instead of acting: the reason joins its description and its
 * tooltip, and a press changes nothing but says the reason once, politely.
 */

import { useId, type JSX } from "react";
import { LinePanelRight } from "../../components/icons/line/index.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { studioPlatform, type StudioPlatform } from "../appShell/studio/keybindings-labels.js";
import { useVexPresence } from "./useVexPresence.js";
import { pressVexToggle, useVexClosing } from "./vex-hide.js";
import { VexSectionAnnouncer } from "./VexSectionAnnouncer.js";
import { announceVexHeld, VEX_SECTION_ID } from "./vex-section-a11y.js";
import { VexStateAnnouncer } from "./VexStateAnnouncer.js";
import { vexToggleAriaShortcut, vexToggleName, vexToggleTooltipLabel } from "./vex-toggle-shortcut.js";

/** The cell's word, in sentence case: the sheet sets the caps. */
export const VEX_HEAD_WORD = "Vex";

export interface VexHeadCellProps {
  /** She shows, as the frame solved it. */
  readonly open: boolean;
  /** Hide or show her: the frame's write of the stored choice. */
  readonly onToggle: () => void;
  /** Her band rests under 1024: why, in words; the key then acts on nothing. */
  readonly held?: string | null;
  /** The platform whose chord and spelling apply; this window's by default. */
  readonly platform?: StudioPlatform;
  /** What the key shows and hides (`aria-controls`): her column, or her band under 1024. */
  readonly controls?: string;
}

export function VexHeadCell({
  open,
  onToggle,
  held = null,
  platform = studioPlatform,
  controls = VEX_SECTION_ID,
}: VexHeadCellProps): JSX.Element {
  const presence = useVexPresence();
  const closing = useVexClosing();
  // The words change at the press (section 3.3): while a close is asked the
  // key already reads Show Vex.
  const shown = open && !closing;
  const name = vexToggleName(shown);
  const stateId = useId();
  const reasonId = useId();
  return (
    <div
      className="vex-head-vex"
      data-vex-area="vex-head-cell"
      data-vex-shown={shown ? "true" : "false"}
      data-vex-state={presence.state}
    >
      <span className="vex-head-vex__word">{VEX_HEAD_WORD}</span>
      <Tooltip label={held ?? vexToggleTooltipLabel(shown, platform)} side="bottom">
        <button
          type="button"
          className="vex-head-vex__key"
          data-vex-area="vex-key"
          data-vex-key-open={shown ? "true" : "false"}
          aria-label={name}
          aria-controls={controls}
          aria-describedby={held === null ? stateId : `${stateId} ${reasonId}`}
          aria-keyshortcuts={vexToggleAriaShortcut(platform)}
          aria-disabled={held === null ? undefined : true}
          data-vex-key-held={held === null ? undefined : ""}
          onClick={() => {
            if (held !== null) {
              announceVexHeld(held);
              return;
            }
            pressVexToggle(open, onToggle);
          }}
        >
          <LinePanelRight size={20} />
        </button>
      </Tooltip>
      <span id={stateId} hidden>
        {presence.word}
      </span>
      {held === null ? null : (
        <span id={reasonId} hidden>
          {held}
        </span>
      )}
      <VexStateAnnouncer state={presence.state} word={presence.word} live={presence.live} />
      <VexSectionAnnouncer />
    </div>
  );
}
