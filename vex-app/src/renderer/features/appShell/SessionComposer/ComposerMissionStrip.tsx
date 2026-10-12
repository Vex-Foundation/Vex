/**
 * Run-state band (A28, generalized in M5): the quiet one-line band above the
 * composer field while the session is doing something (reference d3, "AGENT ·
 * RUNNING"), naming that state behind its swatch - status by fill: dot screen
 * while it runs, target while a signature or a form is awaited, hatch while it
 * is paused or asleep, the ink cross on an error - and, for a mission session
 * carrying an enabled action plan, opening the read-only plan review.
 * Read-only: mission controls stay in `MissionControls`; this band never
 * mutates.
 *
 * TWO SOURCES, ONE BAND. A mission session reads the run STATUS (its states are
 * run-lifecycle states, and `paused_wake` already has its own rich sleeping
 * banner). An agent session has no run row at all, so it reads the session
 * ACTIVITY projection - which is why a full-autonomy agent used to show
 * nothing here while it was mid-run or parked on a wake. Mission rendering is
 * unchanged, deliberately: the status word grammar below is the one the rest of
 * the mission surfaces speak.
 */

import { lazy, Suspense, useState, type JSX } from "react";
import type { RuntimeActivity } from "@shared/schemas/runtime.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import {
  formatWakeTime,
  readSessionActivityReadout,
} from "../session-activity-readout.js";

// Lazy: the plan modal pulls the markdown pipeline - loaded on first open.
const PlanDisplayModal = lazy(async () => ({
  default: (await import("../PlanDisplayModal.js")).PlanDisplayModal,
}));

/** Status words in the landing's status-as-word grammar. */
const STATUS_WORD: Readonly<Record<MissionRunStatus, string>> = {
  running: "RUNNING",
  paused_approval: "AWAITING APPROVAL",
  paused_user: "PAUSED",
  paused_wake: "SLEEPING",
  paused_error: "PAUSED ON ERROR",
  paused_plan_acceptance: "PLAN REVIEW",
  paused_user_form: "AWAITING FORM",
  completed: "COMPLETED",
  failed: "FAILED",
  stopped: "STOPPED",
  cancelled: "CANCELLED",
};

/** The fill each live run state draws (the eagle's own state grammar). */
const STATUS_SWATCH: Readonly<Record<MissionRunStatus, SwatchState>> = {
  running: "ongoing",
  paused_approval: "warning",
  paused_user: "draft",
  paused_wake: "draft",
  paused_error: "error",
  paused_plan_acceptance: "warning",
  paused_user_form: "warning",
  completed: "done",
  failed: "error",
  stopped: "idle",
  cancelled: "idle",
};

/** Settled states keep the composer quiet - the strip is for LIVE runs. */
const SETTLED: ReadonlySet<MissionRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
]);

export function ComposerMissionStrip({
  sessionId,
  mode,
  missionStatus,
  activity,
}: {
  readonly sessionId: string;
  /** Session mode - decides which of the two sources names the state. */
  readonly mode: "mission" | "agent";
  readonly missionStatus: MissionRunStatus | null;
  readonly activity: RuntimeActivity | null;
}): JSX.Element | null {
  const [planOpen, setPlanOpen] = useState(false);
  // Only a MISSION session has an action plan to review, and now that the strip
  // renders for agent sessions too, asking for one on every agent session would
  // be an IPC round trip per session whose answer this band never reads. The
  // hook self-gates on a null id (`enabled`), which is this repo's existing way
  // to say "not for this session".
  const planQuery = useSessionPlan(mode === "mission" ? sessionId : null);
  const plan = planQuery.data?.ok ? planQuery.data.data : null;
  const band = resolveBand(mode, missionStatus, activity);
  if (band === null) return null;
  return (
    <div
      data-vex-area="composer-mission-strip"
      data-status={band.dataStatus}
      data-vex-activity={band.activityState ?? undefined}
      className="flex h-[26px] items-center justify-between gap-3"
    >
      <span className="inline-flex min-w-0 items-center gap-[9px] font-mono text-[11px] uppercase leading-none tracking-status text-ink-secondary">
        <span className="inline-flex shrink-0 text-accent-primary">
          <Swatch state={band.swatch} size={9} />
        </span>
        <span className="min-w-0 truncate">{band.text}</span>
      </span>
      {missionStatus !== null && plan !== null && plan.enabled ? (
        <>
          <button
            type="button"
            aria-label="Review the mission action plan"
            className="shrink-0 font-mono text-[11px] uppercase tracking-status text-accent-primary transition-colors duration-100 hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={() => setPlanOpen(true)}
          >
            View plan
          </button>
          {planOpen ? (
            <Suspense fallback={null}>
              <PlanDisplayModal
                sessionId={sessionId}
                missionStatus={missionStatus}
                open={planOpen}
                onOpenChange={setPlanOpen}
              />
            </Suspense>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

interface StripBand {
  /** The band's copy, in the strip's status-as-word grammar. */
  readonly text: string;
  /** `data-status` - the mission run status, or the activity state. */
  readonly dataStatus: string;
  /** `data-vex-activity` - present only on the activity-driven band. */
  readonly activityState: string | null;
  /** The fill beside the word. */
  readonly swatch: SwatchState;
}

/**
 * WHICH band to show, or none.
 *
 * Mission: unchanged - a live run's status word, nothing while settled or
 * absent. Agent: the activity word, and nothing at all while idle, because a
 * band that says "IDLE" over an idle composer is chrome, not information.
 */
function resolveBand(
  mode: "mission" | "agent",
  missionStatus: MissionRunStatus | null,
  activity: RuntimeActivity | null,
): StripBand | null {
  if (mode === "mission") {
    if (missionStatus === null || SETTLED.has(missionStatus)) return null;
    return {
      text: `Mission · ${STATUS_WORD[missionStatus]}`,
      dataStatus: missionStatus,
      activityState: null,
      swatch: STATUS_SWATCH[missionStatus],
    };
  }
  if (activity === null || activity.kind === "none") return null;
  const readout = readSessionActivityReadout(activity);
  // Unreadable state: no band at all, rather than a band that guesses a word.
  if (readout === null) return null;
  const wakeAt =
    readout.nextWakeAt === null ? null : formatWakeTime(readout.nextWakeAt);
  return {
    // The wake time is appended only when it is readable: the state word alone
    // is still true, and "SLEEPING · until Invalid Date" is not.
    text:
      wakeAt === null
        ? `Agent · ${readout.label.toUpperCase()}`
        : `Agent · ${readout.label.toUpperCase()} · until ${wakeAt}`,
    dataStatus: readout.state,
    activityState: readout.state,
    swatch:
      readout.state === "running"
        ? "ongoing"
        : readout.state === "sleeping"
          ? "draft"
          : "idle",
  };
}
