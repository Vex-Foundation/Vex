import type {
  MissionRunStatus,
  SessionListItem,
} from "@shared/schemas/sessions.js";
import type { SessionModeFilter } from "../../stores/uiStore.js";

export type SessionGroupKey = "pinned" | "today" | "yesterday" | "older";

export interface SessionGroup {
  readonly key: SessionGroupKey;
  readonly title: string;
  readonly rows: readonly SessionListItem[];
}

export interface MissionActivity {
  readonly label: string;
  readonly tone: "active" | "paused" | "stopped";
  readonly dotClass: string;
}

export const SESSION_MODE_FILTERS: ReadonlyArray<{
  readonly value: SessionModeFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agent" },
  { value: "mission", label: "Mission" },
];

const ACTIVE_MISSION_STATUSES: ReadonlySet<MissionRunStatus> = new Set(["running"]);
const PAUSED_MISSION_STATUSES: ReadonlySet<MissionRunStatus> = new Set([
  "paused_approval",
  "paused_wake",
  "paused_error",
  "paused_user_form",
]);
const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
]);

export function filterSessionsByMode(
  rows: readonly SessionListItem[],
  filter: SessionModeFilter,
): readonly SessionListItem[] {
  if (filter === "all") return rows;
  return rows.filter((row) => row.mode === filter);
}

/**
 * Case-insensitive title search for the sessions register. Search the same
 * resolved title the row renders so legacy missions (which fall back to their
 * initial goal) remain discoverable without exposing a second naming rule.
 */
export function filterSessionsByTitle(
  rows: readonly SessionListItem[],
  search: string,
): readonly SessionListItem[] {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((row) =>
    resolveSessionTitle(row).toLowerCase().includes(needle),
  );
}

export function groupSessions(rows: readonly SessionListItem[]): readonly SessionGroup[] {
  // Pinned rows live in their own bucket and are excluded from the time
  // buckets — a pinned row should not appear twice. Within the bucket we
  // sort by pinnedAt DESC so the most recently pinned row surfaces first.
  const pinned: SessionListItem[] = [];
  const today: SessionListItem[] = [];
  const yesterday: SessionListItem[] = [];
  const older: SessionListItem[] = [];

  for (const row of rows) {
    if (row.pinnedAt !== null) {
      pinned.push(row);
      continue;
    }
    const bucket = getSessionBucket(row.startedAt);
    if (bucket === "today") today.push(row);
    else if (bucket === "yesterday") yesterday.push(row);
    else older.push(row);
  }

  pinned.sort((a, b) => comparePinnedDesc(a.pinnedAt, b.pinnedAt));

  return [
    { key: "pinned", title: "Pinned", rows: pinned },
    { key: "today", title: "Today", rows: today },
    { key: "yesterday", title: "Yesterday", rows: yesterday },
    { key: "older", title: "Older", rows: older },
  ];
}

function comparePinnedDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  // ISO 8601 strings are lexicographically comparable.
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

const SESSION_TITLE_DISPLAY_MAX = 48;

/**
 * Display title resolution for a session row. Priority:
 *   1. User-entered `title` (new rows post-migration 020).
 *   2. `initialGoal` (legacy mission rows before users started typing names).
 *   3. Mode-specific default ("Mission setup" / "Agent session").
 *
 * The title is truncated with an ellipsis past 48 chars — the sidebar's
 * single-line truncation handles overflow visually but a hard cap here
 * keeps tooltips / aria-labels predictable.
 */
export function getSessionTitle(row: SessionListItem): string {
  return truncateForDisplay(resolveSessionTitle(row));
}

function resolveSessionTitle(row: SessionListItem): string {
  if (row.title !== null) {
    const trimmed = row.title.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (row.initialGoal !== null) {
    const trimmed = row.initialGoal.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return row.mode === "mission" ? "Mission setup" : "Agent session";
}

function truncateForDisplay(value: string): string {
  return value.length > SESSION_TITLE_DISPLAY_MAX
    ? `${value.slice(0, SESSION_TITLE_DISPLAY_MAX)}...`
    : value;
}

export function getMissionActivity(row: SessionListItem): MissionActivity | null {
  if (row.mode !== "mission" || row.missionStatus === null) return null;
  if (ACTIVE_MISSION_STATUSES.has(row.missionStatus)) {
    return {
      label: "Active",
      tone: "active",
      // Active = the LIVE signal → the blue accent. Signal Tape rations blue to
      // live state; bg-success read as "healthy" not "running" and clashed with
      // the open rail's accent indicator. Now one tone→colour source for both.
      dotClass: "bg-[var(--vex-accent)]",
    };
  }
  if (PAUSED_MISSION_STATUSES.has(row.missionStatus)) {
    return {
      label: "Paused",
      tone: "paused",
      dotClass: "bg-warning",
    };
  }
  if (TERMINAL_MISSION_STATUSES.has(row.missionStatus)) {
    return {
      label: "Stopped",
      tone: "stopped",
      dotClass: "bg-[var(--vex-text-3)]",
    };
  }
  return {
    label: row.missionStatus,
    tone: "paused",
    dotClass: "bg-warning",
  };
}

export function formatSessionTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const bucket = getSessionBucket(iso);
    // Force en-US so the sidebar date reads in English ("May 31") regardless
    // of the OS locale; `undefined` previously deferred to the system locale
    // (a Polish system rendered "31 maj"). Display-only — does not affect
    // bucket math, parsing, or storage.
    if (bucket === "older") {
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    }
    return d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function getSessionBucket(iso: string): "today" | "yesterday" | "older" {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "older";

  const today = startOfLocalDay(new Date());
  const sessionDay = startOfLocalDay(value);
  const diffMs = today.getTime() - sessionDay.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  return "older";
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
