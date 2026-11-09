/**
 * THE CONSOLE STRIP (docs/design/H3-DESKTOP.md section 1.9; Appendix A.8):
 * on a table page with her closed, the console folds to one line under the
 * header, across the page (the shell folds the Vex column to its strip,
 * `vexSeat: "strip"` from `computeH3ShellColumns`), and the page takes the
 * whole width right of the chats. One row of cells, divided by the rule:
 *
 *   NEEDS YOU and its count    the head, as the console's
 *   the decision               the one decision as its sentence, a key that
 *                              opens it, or "Nothing needs you."
 *   the missions cell          "1 mission running on Mainnet", or "No mission
 *                              running", a key to the mission or the list
 *   (H3's strategies cell is left out: desktop has no strategies, 4.1)
 *   OPEN ACTIVITY and an arrow at the right edge, a key to Agent Scan
 *
 * UNDER 1024 THE SAME LINE IS THE CONSOLE LINE (docs/design/H3-DESKTOP.md
 * section 1.10; VEX Cloud's `.cline` from 768 to 1023), in chats and on pages
 * alike, with `band`: its first cell is her state (the square, the word and
 * the timer while a turn runs), a key named by its action that opens and
 * closes her band as the Vex key does, and says why instead while the band
 * rests; the decision gives way, and the missions cell keeps its count.
 *
 * The words, counts and keys are the console's own (`VexConsole.tsx`): the
 * same model, the same lead decision, the same missions words, the same
 * openers, so the strip and the column can never disagree. While the first
 * reads run its cells are parked covers; a read that failed says "Not
 * available" beside the cross, with no count and no Retry (VEX Cloud's
 * console line). Nothing in it decides anything.
 */

import { useId, type JSX } from "react";
import { LineChevronRight, LineMissions } from "../../components/icons/line/index.js";
import { Cover } from "../../components/ui/cover.js";
import { StateSquare } from "../../components/ui/state-square.js";
import { missionsRowOf } from "./background-work.js";
import { NEEDS_YOU_EMPTY_COPY, needsYouLeadOf } from "./needs-you.js";
import { openNeedsYouItem } from "./needs-you-open.js";
import { useAllMissions, useVexPresence } from "./useVexPresence.js";
import {
  MISSIONS_NOT_AVAILABLE,
  needsYouCountText,
  NOT_AVAILABLE,
  OpenActivityKey,
  openMissions,
  useMissionsReadFailed,
} from "./VexConsole.js";
import { VexElapsed } from "./VexElapsed.js";
import { VEX_STATE_SQUARE } from "./vex-state.js";
import { announceVexHeld, announceVexSection, VEX_SECTION_ID } from "./vex-section-a11y.js";
import { vexToggleName } from "./vex-toggle-shortcut.js";

/** The console line's own key under 1024: her band, as the frame solved it. */
export interface VexConsoleLineBand {
  /** Her band is open. */
  readonly open: boolean;
  /** It rests: why, in words; the key then acts on nothing. */
  readonly held: string | null;
  /** Open or close it: the same press as the Vex key's. */
  readonly onToggle: () => void;
}

export function VexConsoleStrip({ band }: { readonly band?: VexConsoleLineBand } = {}): JSX.Element {
  const presence = useVexPresence();
  const { needsYou } = presence;
  const missions = useAllMissions();
  const count = needsYouCountText(needsYou);
  const lead = needsYou.status === "loading" ? null : needsYouLeadOf(needsYou.items);
  const row = missions === null ? null : missionsRowOf(missions);
  // The missions count, the line's short word for the row (Cloud's `.cl-short`).
  const missionsCount = row === null ? null : (/^\d+/.exec(row.lead)?.[0] ?? "0");
  const missionsFailed = useMissionsReadFailed(missions);
  const wordId = useId();
  const reasonId = useId();
  const countId = useId();
  return (
    <div className="vex-strip" data-vex-area="vex-console-strip" data-band={band === undefined ? undefined : ""}>
      {band === undefined ? null : (
        <div className="vex-strip__cell vex-strip__state">
          <button
            type="button"
            className="vex-strip__key"
            data-vex-area="vex-console-line-key"
            aria-label={vexToggleName(band.open)}
            aria-controls={VEX_SECTION_ID}
            aria-describedby={band.held === null ? wordId : `${wordId} ${reasonId}`}
            aria-disabled={band.held === null ? undefined : true}
            title={band.held ?? undefined}
            onClick={() => {
              if (band.held !== null) {
                announceVexHeld(band.held);
                return;
              }
              band.onToggle();
              // Said once, politely, at the press, as every toggle of her
              // section says it (EC-24; `VexSectionAnnouncer`).
              announceVexSection(!band.open);
            }}
          >
            <StateSquare state={VEX_STATE_SQUARE[presence.state]} className="vex-strip__square" />
            <span id={wordId} className="vex-strip__word">
              {presence.word}
            </span>
            {presence.timerStartedAt === null ? null : (
              <VexElapsed startedAtMs={presence.timerStartedAt} className="vex-strip__timer" decorative />
            )}
            {band.held === null ? null : (
              <span id={reasonId} hidden>
                {band.held}
              </span>
            )}
          </button>
        </div>
      )}
      <div className="vex-strip__cell vex-strip__head">
        {band !== undefined && lead !== null ? (
          // Under 1024 the decision gives way, and the header has no Needs
          // you control (section 4.8): the head itself is the Review key to
          // the decision that leads, so it stays a press away.
          <button
            type="button"
            className="vex-strip__key"
            data-vex-area="vex-console-line-needs"
            aria-label={`${lead.go}: ${lead.title}`}
            aria-describedby={count === null ? undefined : countId}
            onClick={() => {
              openNeedsYouItem(lead);
            }}
          >
            <span className="vex-console__label">Needs you</span>
            {count === null ? null : <span className="vex-console__count vex-num">{count}</span>}
            <LineChevronRight size={14} className="vex-console__chevron" />
            {count === null ? null : (
              <span id={countId} hidden>
                {`Needs you: ${count}`}
              </span>
            )}
          </button>
        ) : (
          <>
            <span className="vex-console__label">Needs you</span>
            {count === null ? null : <span className="vex-console__count vex-num">{count}</span>}
          </>
        )}
      </div>
      <div className="vex-strip__cell vex-strip__decision" data-vex-area="vex-strip-decision">
        {needsYou.status === "loading" ? (
          <span className="vex-strip__cover" role="status" aria-label="Loading">
            <Cover width="60%" />
          </span>
        ) : needsYou.status === "unknown" && lead === null ? (
          <span className="vex-strip__na">
            <StateSquare state="error" />
            {NOT_AVAILABLE}
          </span>
        ) : lead === null ? (
          <span className="vex-console__empty">{NEEDS_YOU_EMPTY_COPY}</span>
        ) : (
          <button
            type="button"
            className="vex-strip__key"
            aria-label={`${lead.go}: ${lead.title}`}
            onClick={() => {
              openNeedsYouItem(lead);
            }}
          >
            <span className="vex-strip__text">{lead.title}</span>
            <LineChevronRight size={14} className="vex-console__chevron" />
          </button>
        )}
      </div>
      <div className="vex-strip__cell vex-strip__missions" data-vex-area="vex-strip-missions">
        {row === null ? (
          missionsFailed ? (
            <span className="vex-strip__na">
              <StateSquare state="error" />
              {MISSIONS_NOT_AVAILABLE}
            </span>
          ) : (
            <span className="vex-strip__cover" aria-hidden="true">
              <Cover width="160px" />
            </span>
          )
        ) : (
          <button
            type="button"
            className="vex-strip__key"
            onClick={() => {
              openMissions(row);
            }}
          >
            <LineMissions size={16} className="vex-console__icon" />
            <span className="vex-strip__text">{row.lead}</span>
            {band === undefined || missionsCount === null ? null : (
              <span className="vex-strip__short vex-num" aria-hidden="true">{missionsCount}</span>
            )}
          </button>
        )}
      </div>
      <div className="vex-strip__fill" aria-hidden />
      <div className="vex-strip__cell vex-strip__activity">
        <OpenActivityKey />
      </div>
    </div>
  );
}
