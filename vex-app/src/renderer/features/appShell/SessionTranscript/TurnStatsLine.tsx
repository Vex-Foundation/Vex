/**
 * The turn-stats line under the tail of a settled turn (gap A17): the last
 * turn's usage — tokens in/out, cache-hit share, cost — in the Doto
 * micro-stat register. Mounted only while no turn is in flight; an empty or
 * unresolved usage read renders nothing (never an error surface).
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
    <div
      data-vex-turn-stats=""
      className="vex-stat-doto flex items-center gap-2 pl-9"
    >
      {groups.map((group, i) => (
        <span key={group} className="flex items-center gap-2">
          {i > 0 ? (
            // 2x2 separator dot — the tool-row header's sep grammar.
            <span
              aria-hidden
              className="h-[2px] w-[2px] rounded-[1px] bg-ink-caption"
            />
          ) : null}
          <span>{group}</span>
        </span>
      ))}
    </div>
  );
}
