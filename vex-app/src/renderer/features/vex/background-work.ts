/**
 * BACKGROUND WORK: the missions that keep working while the user looks at
 * something else (docs/design/R3-MINIMAL.md section 5). Read from the sessions
 * list, which already carries every session's `missionStatus`; the open
 * session is excluded because its own state is the state word.
 *
 * Pure. A mission is background work while its run is `running`, or
 * `paused_wake` (sleeping on a wake it will answer by itself); both are
 * listed in `items` with their own word. Only a `running` mission is
 * COUNTED: the count, the label and the summary say "running", so a sleeping
 * mission never adds to "2 missions running" and is never the one the
 * summary names. A mission paused by the user, waiting on an approval or a
 * decision, or on an error is not background work: it needs the user, so it
 * belongs to Needs you (or to nothing at all).
 */

import type { MissionRunStatus, SessionListItem } from "@shared/schemas/sessions.js";
import { getSessionTitle } from "../appShell/sessionListModel.js";

export type BackgroundMissionStatus = "running" | "sleeping";

export interface BackgroundMission {
  readonly sessionId: string;
  readonly title: string;
  readonly status: BackgroundMissionStatus;
  /** The line under the title in the Vex sidebar: "Mission · Running". */
  readonly detail: string;
}

export interface BackgroundWork {
  /** How many background missions are RUNNING (a sleeping one is not). */
  readonly count: number;
  /** Every background mission, running or sleeping, in list order. */
  readonly items: readonly BackgroundMission[];
  /** "1 mission running" or "2 missions running"; `null` with none running. */
  readonly label: string | null;
  /** The label with the running mission's name when exactly one runs; else the label. */
  readonly summary: string | null;
}

export const NO_BACKGROUND_WORK: BackgroundWork = {
  count: 0,
  items: [],
  label: null,
  summary: null,
};

const BACKGROUND_STATUS: Partial<Readonly<Record<MissionRunStatus, BackgroundMissionStatus>>> = {
  running: "running",
  paused_wake: "sleeping",
};

const STATUS_DETAIL: Readonly<Record<BackgroundMissionStatus, string>> = {
  running: "Mission · Running",
  sleeping: "Mission · Sleeping",
};

/** "1 mission running", "2 missions running"; `null` for none. */
export function backgroundLabelOf(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 mission running" : `${count} missions running`;
}

/**
 * The background missions of a sessions list, in the list's own order (pinned
 * first, then newest), without the open session.
 */
export function backgroundWorkOf(
  sessions: readonly SessionListItem[],
  openSessionId: string | null,
): BackgroundWork {
  const items: BackgroundMission[] = [];
  for (const row of sessions) {
    if (row.id === openSessionId) continue;
    if (row.missionStatus === null) continue;
    const status = BACKGROUND_STATUS[row.missionStatus];
    if (status === undefined) continue;
    items.push({
      sessionId: row.id,
      title: getSessionTitle(row),
      status,
      detail: STATUS_DETAIL[status],
    });
  }
  if (items.length === 0) return NO_BACKGROUND_WORK;
  const running = items.filter((item) => item.status === "running");
  const label = backgroundLabelOf(running.length);
  const only = running.length === 1 ? running[0] : undefined;
  return {
    count: running.length,
    items,
    label,
    summary: label === null ? null : only === undefined ? label : `${label} · ${only.title}`,
  };
}
