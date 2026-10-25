/**
 * The run strip above the composer field (docs/design/R3-MINIMAL.md section
 * 7): 44 high, a 1px rule on three sides (the composer's own top edge closes
 * it), the state as a fill and a word ("Mission · Running"), then only real
 * facts after a quiet divider, and at the right end only the controls that
 * apply. A mission paused on an error takes the 1.5px ink frame.
 *
 * The KEYS are not drawn here. `MissionControls` owns every mission control
 * (one set of mutation hooks, so a control in flight disables the others and
 * Recover in the transcript shares that gate) and portals the running
 * mission's keys into the `controls` cell this strip publishes
 * (`mission-strip-slot.ts`); a refusal line lands in the `notes` cell above
 * the strip. This file never mutates anything.
 *
 * TWO SOURCES, ONE STRIP. A mission session reads the run STATUS (its states
 * are run-lifecycle states). An agent session has no run row at all, so it
 * reads the session ACTIVITY projection - which is why a full-autonomy agent
 * used to show nothing here while it was mid-run or parked on a wake. It has
 * no keys here: an agent stops through the composer's own Stop agent.
 *
 * FACTS ONLY. The contract's limits are not readable once a run has started
 * (the draft read stops at `ready`), so a running mission shows its word
 * alone rather than limits from memory; a sleeping one shows the wake time
 * from the same `pausedWake` the sleep card reads; a mission paused on an
 * error says it is not monitoring the market.
 */

import { lazy, Suspense, useCallback, useState, type JSX } from "react";
import type { RuntimeActivity } from "@shared/schemas/runtime.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import { usePendingApprovals } from "../../../lib/api/approvals.js";
import { useRuntimeState } from "../../../lib/api/runtime.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";
import { cn } from "../../../lib/utils.js";
import { Swatch, type SwatchState } from "../../../components/ui/swatch.js";
import {
  useSessionLeaseHeld,
  useStreamPreview,
} from "../../../stores/streamStore.js";
import { ElapsedCounter } from "../TurnIsland/ElapsedCounter.js";
import { resolveComposerLiveStep, type ComposerLiveStep } from "./composer-live-step.js";
import {
  formatWakeTime,
  readSessionActivityReadout,
} from "../session-activity-readout.js";
import {
  clearMissionStripCell,
  setMissionStripCell,
  type MissionStripCell,
} from "../MissionControls/mission-strip-slot.js";

// Lazy: the plan modal pulls the markdown pipeline - loaded on first open.
const PlanDisplayModal = lazy(async () => ({
  default: (await import("../PlanDisplayModal.js")).PlanDisplayModal,
}));

/** The run's state in words, sentence case (sections 5.2 and 7). */
const STATUS_WORD: Readonly<Record<MissionRunStatus, string>> = {
  running: "Running",
  paused_approval: "Waiting for approval",
  paused_user: "Paused",
  paused_wake: "Sleeping",
  paused_error: "Paused on error",
  paused_plan_acceptance: "Plan review",
  paused_user_form: "Awaiting form",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  cancelled: "Cancelled",
};

/**
 * The fill beside each word (section 1.6): solid while it runs, the target
 * while a decision, a signature or a form is awaited, the dotted outline
 * while it is paused or asleep, the ink cross on an error.
 */
const STATUS_SWATCH: Readonly<Record<MissionRunStatus, SwatchState>> = {
  running: "done",
  paused_approval: "awaiting",
  paused_user: "sleeping",
  paused_wake: "sleeping",
  paused_error: "error",
  paused_plan_acceptance: "awaiting",
  paused_user_form: "awaiting",
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

/** Proposal copy (section 7): what a mission paused on an error is not doing. */
const NOT_MONITORING = "Not monitoring the market";

/** The transcript's fallback poll for pending approvals; one query key, shared. */
const PENDING_APPROVALS_REFETCH_MS = 60_000;

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
  // Only a MISSION session has an action plan to review or a run to read; an
  // agent session passes null, which this repo's hooks read as "not for this
  // session" (no IPC).
  const missionSessionId = mode === "mission" ? sessionId : null;
  const planQuery = useSessionPlan(missionSessionId);
  const plan = planQuery.data?.ok ? planQuery.data.data : null;
  // The same runtime read the composer already holds (one query key), for the
  // sleeping run's wake time.
  const runtimeQuery = useRuntimeState(missionSessionId);
  const wakeDueAt =
    runtimeQuery.data?.ok === true
      ? runtimeQuery.data.data.pausedWake?.dueAt
      : undefined;

  // The cells the run's keys and refusal line portal into. React 19 ref
  // cleanups withdraw exactly the element this strip published.
  const controlsRef = useCellRef(sessionId, "controls");
  const notesRef = useCellRef(sessionId, "notes");

  // The turn's live row, read from the same stream store, lease push and
  // pending-approvals query the transcript reads (`composer-live-step.ts`).
  const preview = useStreamPreview(sessionId);
  const leaseHeld = useSessionLeaseHeld(sessionId);
  const pendingQuery = usePendingApprovals(sessionId, {
    refetchInterval: PENDING_APPROVALS_REFETCH_MS,
  });
  const awaitingApproval =
    pendingQuery.data?.ok === true && pendingQuery.data.data.length > 0;

  const band = resolveBand(mode, missionStatus, activity, wakeDueAt);
  if (band === null) return null;
  const inkFrame = mode === "mission" && missionStatus === "paused_error";
  const running =
    mode === "mission"
      ? missionStatus === "running"
      : band.activityState === "running";
  const live = resolveComposerLiveStep(running, preview, awaitingApproval, leaseHeld);
  const text =
    live?.label != null
      ? `${mode === "mission" ? "Mission" : "Agent"} · ${live.label}`
      : band.text;
  const fact: StripFact | null =
    live?.detail != null ? { label: live.detail, figure: null } : band.fact;
  return (
    <div
      data-vex-area="composer-mission-strip"
      data-status={band.dataStatus}
      data-vex-activity={band.activityState ?? undefined}
      data-vex-live-step={liveStepState(live)}
      className="flex w-full flex-col"
    >
      {mode === "mission" ? (
        <div ref={notesRef} data-vex-cell="mission-notes" />
      ) : null}
      <div
        className={cn(
          "flex h-11 min-w-0 items-center gap-3.5 bg-surface-base pl-3.5 pr-2 text-[13.5px] leading-none text-ink-primary",
          inkFrame
            ? "border-[1.5px] border-b-0 border-rule-ink"
            : "border border-b-0 border-rule",
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="inline-flex shrink-0 text-accent-primary">
            {live !== null && !live.awaiting ? (
              <LiveDots />
            ) : (
              <Swatch state={live?.awaiting ? "awaiting" : band.swatch} size={10} />
            )}
          </span>
          <span className="truncate font-medium">{text}</span>
        </span>
        {fact !== null ? (
          <>
            <span aria-hidden className="h-4 w-px shrink-0 bg-rule-quiet" />
            <span className="inline-flex min-w-0 items-baseline gap-1.5 truncate text-[12.5px] text-ink-tertiary">
              {fact.label}
              {fact.figure !== null ? " " : null}
              {fact.figure !== null ? (
                <span className="font-mono vex-num text-[12.5px] tracking-[-0.01em] text-ink-primary">
                  {fact.figure}
                </span>
              ) : null}
            </span>
          </>
        ) : null}
        <span className="min-w-0 flex-1" />
        {live?.startedAtMs != null ? (
          <span
            data-vex-strip-clock=""
            aria-hidden
            className="shrink-0 text-[12px] text-accent-primary"
          >
            <ElapsedCounter startedAtMs={live.startedAtMs} />
          </span>
        ) : null}
        {missionStatus !== null && plan !== null && plan.enabled ? (
          <button
            type="button"
            aria-label="Review the mission action plan"
            className="shrink-0 text-[13px] font-medium text-accent-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus"
            onClick={() => setPlanOpen(true)}
          >
            View plan
          </button>
        ) : null}
        {mode === "mission" ? (
          <span
            ref={controlsRef}
            data-vex-cell="mission-controls"
            className="inline-flex shrink-0 items-center"
          />
        ) : null}
      </div>
      {planOpen && missionStatus !== null ? (
        <Suspense fallback={null}>
          <PlanDisplayModal
            sessionId={sessionId}
            missionStatus={missionStatus}
            open={planOpen}
            onOpenChange={setPlanOpen}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * The moving dots while a run works (owner request 2026-10-25): three dots in
 * the one blue rise in turn (`.vex-live-dots`, chronos-motion.css). Held
 * still under reduced motion.
 */
function LiveDots(): JSX.Element {
  return (
    <span data-vex-live-dots="" className="vex-live-dots">
      <span />
      <span />
      <span />
    </span>
  );
}

/** `data-vex-live-step`: moving, awaiting, or absent while no run is live. */
function liveStepState(live: ComposerLiveStep | null): string | undefined {
  if (live === null) return undefined;
  return live.awaiting ? "awaiting" : "moving";
}

/** A stable callback ref that publishes one strip cell for the session. */
function useCellRef(
  sessionId: string,
  cell: MissionStripCell,
): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return undefined;
      setMissionStripCell(sessionId, cell, element);
      return () => clearMissionStripCell(sessionId, cell, element);
    },
    [sessionId, cell],
  );
}

interface StripFact {
  /** The fact in words ("Wakes at"). */
  readonly label: string;
  /** Its figure in mono, or null when the fact is words alone. */
  readonly figure: string | null;
}

interface StripBand {
  /** The state in words: "Mission · Running", "Agent · Sleeping". */
  readonly text: string;
  /** `data-status` - the mission run status, or the activity state. */
  readonly dataStatus: string;
  /** `data-vex-activity` - present only on the activity-driven band. */
  readonly activityState: string | null;
  /** The fill beside the word. */
  readonly swatch: SwatchState;
  /** One real fact after the divider, or none. */
  readonly fact: StripFact | null;
}

/** "Wakes at {time}", or nothing when the time does not parse. */
function wakeFact(iso: string | null | undefined): StripFact | null {
  if (iso === null || iso === undefined) return null;
  const at = formatWakeTime(iso);
  return at === null ? null : { label: "Wakes at", figure: at };
}

/**
 * WHICH band to show, or none.
 *
 * Mission: a live run's status word, nothing while settled or absent. Agent:
 * the activity word, and nothing at all while idle, because a band that says
 * "Idle" over an idle composer is chrome, not information.
 */
function resolveBand(
  mode: "mission" | "agent",
  missionStatus: MissionRunStatus | null,
  activity: RuntimeActivity | null,
  wakeDueAt: string | undefined,
): StripBand | null {
  if (mode === "mission") {
    if (missionStatus === null || SETTLED.has(missionStatus)) return null;
    return {
      text: `Mission · ${STATUS_WORD[missionStatus]}`,
      dataStatus: missionStatus,
      activityState: null,
      swatch: STATUS_SWATCH[missionStatus],
      fact:
        missionStatus === "paused_wake"
          ? wakeFact(wakeDueAt)
          : missionStatus === "paused_error"
            ? { label: NOT_MONITORING, figure: null }
            : null,
    };
  }
  if (activity === null || activity.kind === "none") return null;
  const readout = readSessionActivityReadout(activity);
  // Unreadable state: no band at all, rather than a band that guesses a word.
  if (readout === null) return null;
  return {
    text: `Agent · ${readout.label}`,
    dataStatus: readout.state,
    activityState: readout.state,
    swatch:
      readout.state === "running"
        ? "done"
        : readout.state === "sleeping"
          ? "sleeping"
          : "idle",
    // The wake time only when it is readable: the state word alone is still
    // true, and "Wakes at Invalid Date" is not.
    fact: wakeFact(readout.nextWakeAt),
  };
}
