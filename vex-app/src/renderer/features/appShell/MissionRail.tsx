/**
 * MISSION RAIL — the DESK RULE header's mission/plan status cluster. It
 * carries the mission/plan status KEYS (compact clickable `PremiumBadge`
 * pills) that open the contract / plan review dialogs. Formerly a fixed 200px
 * column between chat and BOOK; the badges now sit inline in the header's
 * center zone so the chat column can center in the freed width. The tall
 * contract + plan cards used to live inline in `SessionPanel`, which pushed
 * `MissionControls` + the Accept footer below the fold (the bug this cluster
 * resolves); the cluster keeps only the compact badges in the layout and moves
 * the full review surfaces into top-layer `<dialog>`s where the Accept action
 * is pinned and can never be scrolled away.
 *
 * Render gate (decided in the redesign plan): the cluster renders only in the
 * active session view, and only when the session is mission-mode OR plan-mode
 * is enabled. A plain agent session with plan-mode off gets NO cluster (render
 * nothing — never a broken empty frame). The gate is computed from the same
 * TanStack Query hooks the modals use, so the cluster and modals always agree.
 *
 * Badge state derivation (§4 of the plan):
 *   - Mission badge mirrors the contract diff state machine
 *     (preparing / ready / accepted / stale), but "ready" additionally requires
 *     the plan to be ready when plan-mode is on — a `plan_missing` plan keeps
 *     the mission at "preparing" with a plan-needed hint (matches the engine
 *     `plan_missing` block in the modal footer).
 *   - Plan badge mirrors the plan state (preparing while authoring / ready while
 *     pending acceptance / accepted), and surfaces an "awaiting resume" stale
 *     marker when an accepted plan's run is parked. Plan Mode itself is retired
 *     from the UI (no session can enable it again — `PlanSwitch` is gone), so
 *     this badge only ever surfaces for a legacy session that already carries
 *     `plan.enabled === true`; it is labelled "Legacy plan" so it reads as a
 *     recovery affordance, never a live feature.
 *
 * Modal open-state lives in `uiStore` (`reviewModal`), NOT local `useState`:
 * `MissionControls`' "Review & accept contract" bar (mounted in the session
 * body, a different tree branch than this header cluster) needs to open the
 * SAME dialog this component owns, so the state has to be shared, not local.
 * MUTUAL EXCLUSION is still free — `reviewModal` is a single enum value, so
 * opening one dialog closes the other. The state is UI-ephemeral (never
 * persisted, never crosses IPC).
 *
 * Trust boundary: 100% renderer presentation over existing hooks. No new IPC,
 * no `src/vex-agent`/DB/wallet imports, and no plan CONTENT is read here — the
 * cluster only derives badge states; the modals own the content render.
 */

import { useMemo } from "react";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type {
  MissionDraftDto,
  MissionGetDiffResult,
} from "@shared/schemas/mission.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import type { PlanGetResult } from "@shared/schemas/session-plan.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  useMissionDiff,
  useMissionDraft,
  useRenewableMissionSource,
} from "../../lib/api/mission.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { useSession, useSessionPlan } from "../../lib/api/sessions.js";
import { useUiStore } from "../../stores/uiStore.js";
import { MissionContractModal } from "./MissionContractModal.js";
import { PlanDisplayModal } from "./PlanDisplayModal.js";
import { PremiumBadge, type PremiumBadgeState } from "./PremiumBadge.js";
import {
  missionReadinessBadgeState,
  resolveMissionReadiness,
} from "./mission-readiness.js";
import {
  cancelMissionContractRequest,
  requestMissionContract,
} from "./mission-contract-request.js";

export interface MissionRailProps {
  readonly activeSessionId: string | null;
}

export function MissionRail({
  activeSessionId,
}: MissionRailProps): JSX.Element | null {
  const sessionId = activeSessionId ?? "";
  const detailQuery = useSession(activeSessionId);
  const session = readSession(detailQuery.data);

  const draftQuery = useMissionDraft(activeSessionId);
  const draft = readDraft(draftQuery.data);
  const diffQuery = useMissionDiff(activeSessionId, draft?.missionId ?? null);
  const diff = readDiff(diffQuery.data);
  const planQuery = useSessionPlan(activeSessionId);
  const plan = readPlan(planQuery.data);
  // Pending/failed plan read = UNKNOWN plan state; the READY badge below must
  // treat unknown as still-preparing (same rule as MissionControls' bar).
  const planKnown = planQuery.data?.ok === true;

  const isMission = session?.mode === "mission";
  const planEnabled = plan?.enabled === true;
  // Gate: active session AND (mission-mode OR plan-enabled). A plain agent
  // session with plan-mode off earns no cluster.
  const shouldRender =
    activeSessionId !== null && session !== null && (isMission || planEnabled);

  // Runtime + renewable-source reads, fired ONLY for mission sessions. Both
  // hooks coerce a null sessionId to "" and gate on length, so a non-mission
  // session passes null and fires no IPC. Placed unconditionally above the
  // early return to honour the rules of hooks.
  const runtimeQuery = useRuntimeState(isMission ? activeSessionId : null);
  const renewableQuery = useRenewableMissionSource(
    isMission ? activeSessionId : null,
  );
  // hasActiveRun: a running/paused run (mirrors MissionControls' runtime unwrap).
  const hasActiveRun =
    runtimeQuery.data?.ok === true && runtimeQuery.data.data.hasActiveRun === true;
  // runtimeStatus: read alongside hasActiveRun so the badge can surface the
  // paused_error state (MissionControls' standing alert) — never derived from
  // status alone, since a stale/inconsistent status without an active run
  // must not paint the badge red.
  const runtimeStatus: RuntimeStateDto["status"] =
    runtimeQuery.data?.ok === true ? runtimeQuery.data.data.status : null;
  // hasRenewable: a non-null renewable source means a terminal accepted mission
  // exists (completed/failed/stopped/cancelled), proving the contract was accepted.
  const hasRenewable =
    renewableQuery.data?.ok === true && renewableQuery.data.data !== null;

  const open = useUiStore((s) => s.reviewModal);
  const setReviewModal = useUiStore((s) => s.setReviewModal);

  const mission = useMemo(
    () =>
      deriveMissionBadge(
        isMission,
        draft,
        diff,
        plan,
        planKnown,
        hasActiveRun,
        hasRenewable,
        runtimeStatus,
      ),
    [isMission, draft, diff, plan, planKnown, hasActiveRun, hasRenewable, runtimeStatus],
  );
  const planBadge = useMemo(
    () => derivePlanBadge(plan, session?.missionStatus ?? null),
    [plan, session?.missionStatus],
  );

  if (!shouldRender) return null;

  // Mission setup (mission-mode, no run started yet) accepts the plan TOGETHER
  // with the contract via the unified `mission.acceptContract` step — withhold
  // the plan modal's standalone "Accept plan" to avoid two competing accepts.
  const suppressPlanAccept =
    isMission && (session?.missionStatus ?? null) === null;

  return (
    <div
      data-vex-area="mission-rail"
      role="group"
      aria-label="Mission and plan status"
      className="flex min-w-0 items-center gap-2"
    >
      {mission !== null ? (
        <PremiumBadge
          compact
          label="Mission"
          state={mission.state}
          shimmer={mission.shimmer}
          expanded={open === "mission"}
          // The one NON-DISMISSIBLE surface that always carries the action.
          // VS Code's trust banner is dismissible and persists that, but its
          // status-bar entry has no close, so the way in is never gone; the
          // MISSION badge is our equivalent. It participates in the same
          // request lifecycle as every other entry point, so a blocked
          // capability waiting on the contract settles from here too.
          onClick={() => {
            if (open === "mission") {
              setReviewModal("none");
              cancelMissionContractRequest(sessionId);
              return;
            }
            setReviewModal("mission");
            void requestMissionContract({ sessionId, reason: "user" });
          }}
        />
      ) : null}

      {planBadge !== null ? (
        // Legacy-recovery affordance, not a live-feature control: Plan Mode
        // can never be turned on again, so a session only reaches this badge
        // by already carrying an enabled plan from before the retirement.
        <PremiumBadge
          compact
          label="Legacy plan"
          state={planBadge.state}
          shimmer={planBadge.shimmer}
          expanded={open === "plan"}
          onClick={() => setReviewModal(open === "plan" ? "none" : "plan")}
        />
      ) : null}

      {/* Modals are always mounted (cheap) so open/close is pure state; the
       * native <dialog> only enters the top layer when `open`. The render gate
       * guarantees a session exists here. */}
      {isMission && session !== null ? (
        <MissionContractModal
          sessionId={sessionId}
          permission={session.permission}
          open={open === "mission"}
          onOpenChange={(next) => {
            setReviewModal(next ? "mission" : "none");
            // Dismissal without a decision is `cancelled`, the third outcome,
            // never a silent false. The accept path settles `granted`/`refused`
            // itself before this runs, and settle is idempotent.
            if (!next) cancelMissionContractRequest(sessionId);
          }}
        />
      ) : null}
      {planEnabled ? (
        <PlanDisplayModal
          sessionId={sessionId}
          missionStatus={session?.missionStatus ?? null}
          suppressAccept={suppressPlanAccept}
          open={open === "plan"}
          onOpenChange={(next) => setReviewModal(next ? "plan" : "none")}
        />
      ) : null}
    </div>
  );
}

interface BadgeDerivation {
  readonly state: PremiumBadgeState;
  readonly shimmer: boolean;
}

/**
 * Mirror the modal's contract state machine, then apply the cross-cut rule:
 * "Mission Ready" requires the contract awaiting acceptance AND (plan-mode off
 * OR the plan is ready). A `plan_missing` plan keeps the mission at "preparing"
 * so the badge never invites an accept the engine would refuse.
 *
 * Returns null when there is no mission to surface (non-mission session) so the
 * cluster simply omits the Mission badge.
 */
function deriveMissionBadge(
  isMission: boolean,
  draft: MissionDraftDto | null,
  diff: ReadyDiff | null,
  plan: PlanGetResult | null,
  planKnown: boolean,
  hasActiveRun: boolean,
  hasRenewable: boolean,
  runtimeStatus: RuntimeStateDto["status"],
): BadgeDerivation | null {
  if (!isMission) return null;
  // Standing paused_error alert's badge counterpart (issue #42): override to
  // "error" only when an active run's own status confirms the pause — never
  // on status alone, since a stale status without an active run is a
  // defensive inconsistent-state case, not a live error.
  if (hasActiveRun && runtimeStatus === "paused_error") {
    return { state: "error", shimmer: false };
  }
  // A mission past contract-acceptance is "accepted" — never "preparing".
  // hasActiveRun covers running/paused; hasRenewable (a non-null renewable
  // source) covers terminal accepted missions (completed/failed/stopped/
  // cancelled). Once accepted the draft drops out of `getDraftForSession`
  // (draft === null), which would otherwise fall through to "preparing".
  //
  // The `draft === null` guard on the renewable branch is load-bearing:
  // `getRenewableSourceForSession` returns the OLD terminal accepted mission
  // for the session whenever one exists and does NOT exclude sessions that
  // also have a fresh draft. After `mission.renew` a new status='draft'
  // mission is inserted under the same root_session_id, and after
  // `mission.edit` the parent mission returns to draft while its accepted-
  // contract columns stay set — in both cases hasRenewable stays true while a
  // current draft exists. Gating on `draft === null` lets that fresh draft
  // fall THROUGH to the normal draft/ready/stale derivation instead of being
  // masked as "accepted" by a stale renewable source. hasActiveRun stays
  // unconditional: a live run is authoritative regardless of any draft.
  //
  // Pass-1 trade-off: a failed/stopped/cancelled mission reuses the `accepted`
  // badge whose caption reads "Accepted" — here it means "contract accepted /
  // no accept action pending", not "mission succeeded". A dedicated
  // RUNNING/DONE state is a deferred Stage-2 follow-up.
  if (hasActiveRun || (draft === null && hasRenewable)) {
    return { state: "accepted", shimmer: false };
  }
  // Below the run-level overrides, the badge is a pure projection of THE shared
  // readiness selector, the same one `MissionControls` and the contract modal
  // read. The previous hand-rolled chain here is what let the three surfaces
  // drift apart. `setupStalled` is deliberately not fed in: the stall is a
  // liveness detail of the drafting state, and the badge for drafting is
  // Preparing either way; the notice and the modal carry the distinction.
  const state = missionReadinessBadgeState(
    resolveMissionReadiness({ draft, diff, plan, planKnown, setupStalled: false }),
  );
  return { state, shimmer: state === "ready" };
}

/**
 * Legacy-recovery badge state, derived from the plan the same way it always
 * was. Hidden (null) when plan-mode is off — condition is exactly
 * `plan.enabled === true`, so an accepted-and-still-enabled plan keeps
 * surfacing the badge (it is the only exit ramp for that session).
 *   - enabled, no markdown        → preparing (authoring)
 *   - enabled, markdown, !accepted → ready (shimmer — awaiting your acceptance)
 *   - accepted + run parked        → stale (awaiting resume)
 *   - accepted                     → accepted
 */
function derivePlanBadge(
  plan: PlanGetResult | null,
  missionStatus: string | null,
): BadgeDerivation | null {
  if (plan === null || !plan.enabled) return null;
  const hasPlan = plan.planMd.length > 0;
  if (!hasPlan) return { state: "preparing", shimmer: false };
  if (!plan.accepted) return { state: "ready", shimmer: true };
  if (missionStatus === "paused_plan_acceptance") {
    return { state: "stale", shimmer: false };
  }
  return { state: "accepted", shimmer: false };
}

/**
 * Plan-mode on with an empty body → the engine's `plan_missing` block. The
 * definition moved into `mission-readiness.ts` alongside the rest of the
 * readiness predicate; re-exported here for existing importers.
 */
export { planMissing } from "./mission-readiness.js";

type ReadyDiff = Extract<MissionGetDiffResult, { outcome: "ready" }>;

function readSession(
  // useSession resolves Result<SessionListItem | null> (null = unknown id).
  data: Result<SessionListItem | null> | undefined,
): SessionListItem | null {
  if (!data || !data.ok) return null;
  return data.data;
}

function readDraft(
  data: Result<MissionDraftDto | null> | undefined,
): MissionDraftDto | null {
  if (!data || !data.ok) return null;
  return data.data;
}

function readDiff(
  data: Result<MissionGetDiffResult> | undefined,
): ReadyDiff | null {
  if (!data || !data.ok) return null;
  if (data.data.outcome !== "ready") return null;
  return data.data;
}

function readPlan(
  data: Result<PlanGetResult> | undefined,
): PlanGetResult | null {
  if (!data || !data.ok) return null;
  return data.data;
}
