/**
 * The turn-stats line under the tail of a settled turn (gap A17): the last
 * TURN's usage - tokens in/out, cache-hit share, cost, and the round count when
 * the turn ran more than one model round - at 11.5 muted, shown on hover only
 * (docs/design/R3-MINIMAL.md section 6; the reveal is `.vex-turn-stats` in
 * chat-transcript.css). Mounted only while no turn is in flight; an empty or
 * unresolved usage read renders nothing (never an error surface).
 *
 * The figures are a ROLLUP across the turn's rounds, not one `usage_log` row:
 * input is the last round's snapshot, output and cost are turn sums. See
 * `turnUsageRollupDtoSchema` for why the two sides are deliberately asymmetric.
 */

import type { JSX } from "react";
import { useLastTurnUsage } from "../../../lib/api/usage.js";
import { turnStatGroups } from "./turnStats.js";

export function TurnStatsLine({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element | null {
  const query = useLastTurnUsage(sessionId);
  const result = query.data;
  if (result === undefined || !result.ok || result.data === null) return null;
  const groups = turnStatGroups(result.data);
  if (groups.length === 0) return null;
  return (
    // Values ("88.1K in"), tabular, on the turn's 40px edge. Hidden until
    // the turn or the line itself is hovered or focused.
    <div data-vex-turn-stats="" className="vex-reply vex-turn-stats">
      {groups.map((group, i) => (
        <span key={group} className="flex items-center gap-2">
          {i > 0 ? (
            // The middle dot between groups, as the design writes its lists.
            <span aria-hidden>·</span>
          ) : null}
          <span>{group}</span>
        </span>
      ))}
    </div>
  );
}
