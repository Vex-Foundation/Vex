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
 * The words, counts and keys are the console's own (`VexConsole.tsx`): the
 * same model, the same lead decision, the same missions words, the same
 * openers, so the strip and the column can never disagree. While the first
 * reads run its cells are parked covers; a read that failed says "Not
 * available" beside the cross, with no count and no Retry (VEX Cloud's
 * console line). Nothing in it decides anything.
 */

import type { JSX } from "react";
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

export function VexConsoleStrip(): JSX.Element {
  const { needsYou } = useVexPresence();
  const missions = useAllMissions();
  const count = needsYouCountText(needsYou);
  const lead = needsYou.status === "loading" ? null : needsYouLeadOf(needsYou.items);
  const row = missions === null ? null : missionsRowOf(missions);
  const missionsFailed = useMissionsReadFailed(missions);
  return (
    <div className="vex-strip" data-vex-area="vex-console-strip">
      <div className="vex-strip__cell vex-strip__head">
        <span className="vex-console__label">Needs you</span>
        {count === null ? null : <span className="vex-console__count vex-num">{count}</span>}
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
