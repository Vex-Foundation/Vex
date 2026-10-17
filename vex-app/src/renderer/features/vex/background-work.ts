/**
 * BACKGROUND WORK: the missions that keep working while the user looks at
 * something else (docs/design/R3-MINIMAL.md section 5). Read from the sessions
 * list, which already carries every session's `missionStatus`; the open
 * session is excluded because its own state is the state word.
 *
 * Pure. A mission counts while its run is `running`, or `paused_wake`
 * (sleeping on a wake it will answer by itself). A mission paused by the user,
 * waiting on an approval or a decision, or on an error is not background work:
 * it needs the user, so it belongs to Needs you (or to nothing at all).
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
  readonly count: number;
  readonly items: readonly BackgroundMission[];
  /** "1 mission running" or "2 missions running"; `null` with none. */
  readonly label: string | null;
  /** The label with the mission's name when exactly one runs; else the label. */
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
  const label = backgroundLabelOf(items.length);
  const only = items.length === 1 ? items[0] : undefined;
  return {
    count: items.length,
    items,
    label,
    summary: label === null ? null : only === undefined ? label : `${label} · ${only.title}`,
  };
}
