/**
 * Mission plan strip (A28): a quiet one-line band above the composer while a
 * mission run is active, naming the run state and - when the session carries
 * an enabled action plan - opening the read-only plan review. Read-only:
 * mission controls stay in `MissionControls`; this strip never mutates.
 */

import { lazy, Suspense, useState, type JSX } from "react";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import { useSessionPlan } from "../../../lib/api/sessions.js";

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

/** Settled states keep the composer quiet - the strip is for LIVE runs. */
const SETTLED: ReadonlySet<MissionRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
]);

export function ComposerMissionStrip({
  sessionId,
  missionStatus,
}: {
  readonly sessionId: string;
  readonly missionStatus: MissionRunStatus | null;
}): JSX.Element | null {
  const [planOpen, setPlanOpen] = useState(false);
  const planQuery = useSessionPlan(sessionId);
  const plan = planQuery.data?.ok ? planQuery.data.data : null;
  if (missionStatus === null || SETTLED.has(missionStatus)) return null;
  return (
    <div
      data-vex-area="composer-mission-strip"
      data-status={missionStatus}
      className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-interactive-hover px-3 py-1 text-[12px] leading-[18px] text-ink-secondary"
    >
      <span className="vex-doto-label vex-doto-label--wide uppercase text-ink-secondary">
        Mission · {STATUS_WORD[missionStatus]}
      </span>
      {plan !== null && plan.enabled ? (
        <>
          <button
            type="button"
            aria-label="Review the mission action plan"
            className="shrink-0 text-ink-secondary underline decoration-line-4 underline-offset-2 transition-colors duration-100 hover:text-ink-primary"
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
