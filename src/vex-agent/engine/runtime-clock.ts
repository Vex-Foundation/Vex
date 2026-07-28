/**
 * Runtime clock - one small time model shared by prompt rendering and
 * autonomy scheduling. Timestamps stay in ISO UTC for persistence; local time
 * is rendered only as operator/model context.
 */

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface PendingWakeClockInput {
  dueAt: Date | string;
  reason: string | null;
}

export interface RuntimeClockInput {
  now?: Date;
  timezone?: string;
  sessionStartedAt?: Date | string | null;
  missionRunStartedAt?: Date | string | null;
  missionDeadline?: Date | string | null;
  pendingWake?: PendingWakeClockInput | null;
}

export interface RuntimeClockSnapshot {
  currentTimeUtc: string;
  currentTimeLocal: string;
  timezone: string;
  sessionStartedAt: string | null;
  sessionElapsed: string | null;
  missionRunStartedAt: string | null;
  missionRunElapsed: string | null;
  missionDeadline: string | null;
  missionDeadlineState: string | null;
  pendingWakeDueAt: string | null;
  pendingWakeState: string | null;
  pendingWakeReason: string | null;
}

export function currentDate(): Date {
  return new Date();
}

export function toIso(value: Date): string {
  return value.toISOString();
}

export function buildRuntimeClockSnapshot(input: RuntimeClockInput = {}): RuntimeClockSnapshot {
  const now = input.now ?? currentDate();
  const timezone = normalizeTimezone(input.timezone);
  const nowMs = now.getTime();
  const sessionStartedAt = normalizeDateLike(input.sessionStartedAt);
  const missionRunStartedAt = normalizeDateLike(input.missionRunStartedAt);
  const missionDeadline = normalizeDateLike(input.missionDeadline);
  const pendingWakeDueAt = normalizeDateLike(input.pendingWake?.dueAt ?? null);

  return {
    currentTimeUtc: toIso(now),
    currentTimeLocal: formatLocalDateTime(now, timezone),
    timezone,
    sessionStartedAt,
    sessionElapsed: elapsedSince(sessionStartedAt, nowMs),
    missionRunStartedAt,
    missionRunElapsed: elapsedSince(missionRunStartedAt, nowMs),
    missionDeadline,
    missionDeadlineState: relativeState(missionDeadline, nowMs),
    pendingWakeDueAt,
    pendingWakeState: relativeState(pendingWakeDueAt, nowMs),
    pendingWakeReason: input.pendingWake?.reason ?? null,
  };
}

/**
 * Invariant time doctrine — belongs to the STATIC cache prefix, not to the
 * per-turn clock layer that used to re-send it every turn. Deterministic text
 * (no timestamps): the volatile values stay in `buildRuntimeClockPrompt`.
 */
export function buildTimeRulesPrompt(): string {
  return [
    "# Time Rules",
    "",
    "- The Runtime Clock block in the turn state carries the current time; treat its Current time UTC as the source of truth for now/today/later.",
    "- Persisted timestamps are ISO UTC. The local time shown next to them is operator context only — never compute with it.",
  ].join("\n");
}

export interface RuntimeClockPromptOptions {
  /**
   * True only while a mission RUN is active. Wake scheduling (`loop_defer`) and
   * the "Pending wake" concept exist only in that phase; emitting them in an
   * agent session is ~60 tokens per turn of instructions the session cannot act
   * on (amendment 3).
   */
  missionRunActive: boolean;
}

export function buildRuntimeClockPrompt(
  snapshot: RuntimeClockSnapshot,
  options: RuntimeClockPromptOptions = { missionRunActive: false },
): string {
  const lines: string[] = [];

  lines.push("# Runtime Clock");
  lines.push("");
  lines.push(`Current time UTC: ${snapshot.currentTimeUtc}`);
  lines.push(`Current time local (${snapshot.timezone}): ${snapshot.currentTimeLocal}`);
  lines.push(formatStartedLine("Session started", snapshot.sessionStartedAt, snapshot.sessionElapsed));
  if (snapshot.missionRunStartedAt) {
    lines.push(formatStartedLine(
      "Mission run started",
      snapshot.missionRunStartedAt,
      snapshot.missionRunElapsed,
    ));
  }
  if (snapshot.missionDeadline) {
    lines.push(`Mission deadline: ${snapshot.missionDeadline} (${snapshot.missionDeadlineState ?? "unknown"})`);
  }
  if (options.missionRunActive) {
    lines.push(snapshot.pendingWakeDueAt
      ? `Pending wake: ${snapshot.pendingWakeDueAt} (${snapshot.pendingWakeState ?? "unknown"}; reason: ${snapshot.pendingWakeReason ?? "none"})`
      : "Pending wake: none");
    lines.push("");
    lines.push("- You do not observe time while deferred; a wake means the executor resumed you after real time passed.");
    lines.push("- To wait, call `loop_defer(after_ms=60000, reason=\"...\")` for a relative wait or `loop_defer(wake_at=\"2026-01-01T00:00:00Z\", reason=\"...\")` for an exact ISO time.");
    lines.push("- Before using deadline_reached or scheduling another wake, compare live state against this Runtime Clock.");
    if (snapshot.missionDeadline) {
      lines.push("- The mission auto-finalizes when this deadline passes. Any positions still open at that point are reported as unresolved, not closed automatically.");
    }
  }

  return lines.join("\n");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const absoluteMs = Math.max(0, Math.round(Math.abs(ms)));
  const days = Math.floor(absoluteMs / MS_PER_DAY);
  const hours = Math.floor((absoluteMs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((absoluteMs % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((absoluteMs % MS_PER_MINUTE) / MS_PER_SECOND);

  if (days > 0) return `${days}d ${pad2(hours)}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${seconds}s`;
}

function formatStartedLine(label: string, iso: string | null, elapsed: string | null): string {
  return iso ? `${label}: ${iso} (${elapsed ?? "elapsed: unknown"})` : `${label}: unknown`;
}

/**
 * Elapsed time since a start timestamp. A start in the FUTURE (clock skew, a
 * mis-stored `started_at`) is reported as such instead of being folded to a
 * positive "elapsed" by `formatDuration`'s magnitude semantics — this layer is
 * declared the source of truth for now/today/later, and `deadline_reached`
 * decisions are made from it.
 */
function elapsedSince(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const startMs = Date.parse(iso);
  if (!Number.isFinite(startMs)) return null;
  const delta = nowMs - startMs;
  if (delta < 0) return `not started yet — starts in ${formatDuration(-delta)}`;
  return `elapsed: ${formatDuration(delta)}`;
}

function relativeState(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return null;
  const delta = targetMs - nowMs;
  if (delta >= 0) return `in ${formatDuration(delta)}`;
  return `overdue by ${formatDuration(delta)}`;
}

function normalizeDateLike(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? date.toISOString() : null;
}

function normalizeTimezone(value: string | null | undefined): string {
  const candidate = value?.trim()
    || process.env.TZ?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
  try {
    // Validate timezone support. Offset-only or invalid strings can throw.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return "UTC";
  }
}

function formatLocalDateTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
