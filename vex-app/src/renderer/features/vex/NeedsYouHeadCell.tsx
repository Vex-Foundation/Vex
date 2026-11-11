/**
 * NEEDS YOU IN THE HEADER (docs/design/H3-DESKTOP.md section 6.2; the
 * owner's D2 plates, 2026-11-09): a cell of the header row over the chat,
 * after the chat's title and before the network statement. NEEDS YOU in
 * caps and its count, muted at zero (VEX Cloud's `b[data-zero]`).
 *
 * The whole cell is one key, and a press OPENS THE NEEDS YOU PAGE: it never
 * approves, rejects or decides anything, and it never opens a card's keys by
 * itself. The page lists every decision and each card there keeps its own
 * gate (section 4.3). The count is the console's own read (`useNeedsYou`,
 * the same model her column's Needs you list draws), so the two never
 * disagree: a count nobody verified is not a number, so while the first read
 * runs or after a failed read the cell says the words alone.
 *
 * It stands in the agent shell and Studio. The Lighter desk keeps its
 * approved plate, which has no Needs you header control (section 4.8), and
 * under 1024 the console line carries Needs you and its Review (section
 * 1.10), so the cell leaves the row there (title-bar.css).
 */

import { useId, type JSX } from "react";
import { useUiStore } from "../../stores/uiStore.js";
import { useNeedsYou } from "./useVexPresence.js";
import { needsYouCountText } from "./VexConsole.js";

/** The cell's word, in sentence case: the sheet sets the caps. */
export const NEEDS_YOU_HEAD_WORD = "Needs you";

/** What the key does, said after its words. */
export const NEEDS_YOU_HEAD_HINT = "Opens the Needs you page.";

/** Open the Needs you page, at its first decision. Never decides one. */
export function openNeedsYouPage(): void {
  useUiStore.getState().setShellRoute({ kind: "needsYou", origin: null, approvalId: null });
}

export function NeedsYouHeadCell(): JSX.Element {
  const needsYou = useNeedsYou();
  const count = needsYouCountText(needsYou);
  const hintId = useId();
  const zero = count === "0";
  return (
    <div data-vex-head-cell="needs" className="vex-shell-head__needs">
      <button
        type="button"
        className="vex-head-needs"
        data-vex-area="needs-you-head"
        data-state={needsYou.status}
        aria-label={count === null ? NEEDS_YOU_HEAD_WORD : `${NEEDS_YOU_HEAD_WORD}: ${count}`}
        aria-describedby={hintId}
        onClick={openNeedsYouPage}
      >
        <span className="vex-head-needs__word" aria-hidden="true">
          {NEEDS_YOU_HEAD_WORD}
        </span>
        {count === null ? null : (
          <span className="vex-head-needs__count vex-num" data-zero={zero ? "" : undefined} aria-hidden="true">
            {count}
          </span>
        )}
      </button>
      <span id={hintId} hidden>
        {NEEDS_YOU_HEAD_HINT}
      </span>
    </div>
  );
}
