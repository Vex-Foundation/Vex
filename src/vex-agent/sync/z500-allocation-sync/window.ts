/**
 * Schedule-window identity — pure clock math, no IO.
 *
 * The window id is the scheduled UTC midnight in ISO form. Deriving it from
 * the clock alone (never from stored state) is what makes the idempotency
 * identity stable across processes, restarts, and downtime: every worker
 * that looks at the same instant names the same window.
 */

import { Z500_SCHEDULED_TOLERANCE_MS } from "./config.js";

export interface ScheduleWindow {
  /** "2026-08-28T00:00:00.000Z" — the UNIQUE claim key. */
  readonly windowId: string;
  /** The scheduled instant (00:00 UTC of the window's day). */
  readonly scheduledAt: Date;
  /**
   * 'scheduled' when `now` sits within the on-time tolerance of the window
   * start; 'catch-up' otherwise — the first tick after a restart or downtime
   * claims the CURRENT window late and says so. Older missed windows are
   * never claimed at all, which is exactly the spec's "one missed run →
   * exactly one catch-up evaluation using the latest valid source data".
   */
  readonly triggerType: "scheduled" | "catch-up";
}

/** The window `now` belongs to: today's 00:00 UTC. */
export function computeWindow(now: Date): ScheduleWindow {
  const scheduledAt = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0,
  ));
  const lateness = now.getTime() - scheduledAt.getTime();
  return {
    windowId: scheduledAt.toISOString(),
    scheduledAt,
    triggerType: lateness <= Z500_SCHEDULED_TOLERANCE_MS ? "scheduled" : "catch-up",
  };
}
