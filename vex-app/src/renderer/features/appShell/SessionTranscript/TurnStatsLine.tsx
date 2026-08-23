/**
 * The turn-stats line under the tail of a settled turn (gap A17): the last
 * TURN's usage - tokens in/out, cache-hit share, cost, and the round count when
 * the turn ran more than one model round - in the micro-label micro-stat
 * register. Mounted only while no turn is in flight; an empty or unresolved
 * usage read renders nothing (never an error surface).
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
    // `.vex-micro-label` owns the app-wide stamp register (Inter Tight
    // 11px / w600 / 0.06em / tabular-nums); colour and case are call-site
    // decisions. These are VALUES ("88.1K IN"), not an eyebrow, so no
    // uppercase. The floor colour tier is ink-secondary: ink-tertiary and
    // below are the illegibility the owner's QA reported.
    <div
      data-vex-turn-stats=""
      className="vex-micro-label flex items-center gap-2 pl-9 text-ink-secondary"
    >
      {groups.map((group, i) => (
        <span key={group} className="flex items-center gap-2">
          {i > 0 ? (
            // 2x2 separator dot - the tool-row header's sep grammar. `line-3`,
            // not `ink-caption`: caption is the disabled/decoration tier and a
            // 2px dot painted in it is invisible in both themes.
            <span
              aria-hidden
              className="h-[2px] w-[2px] rounded-[1px] bg-line-3"
            />
          ) : null}
          <span>{group}</span>
        </span>
      ))}
    </div>
  );
}
