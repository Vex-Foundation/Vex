/**
 * MissionContractModal — the mission contract review/accept surface, hosted in
 * a top-layer native `<dialog>` (the MISSION RAIL's `PremiumBadge` opens it).
 *
 * This wraps the SAME state machine + hooks the inline `MissionContractCard`
 * uses (`useMissionDraft` + `useMissionDiff` + `useSessionPlan` →
 * `resolvePlanGate`, `useAcceptMissionContract`, `useSetAutoRetry`). The single
 * "Accept contract & plan" action lives in the DialogFooter — `shrink-0` and
 * pinned, so it can never be pushed below the fold the way the inline card's
 * footer was (that overflow is the bug this rail/modal redesign resolves).
 *
 * The body reuses the card's presentational `CardBody` + `AutoRetrySection`,
 * plus the host-authored `LaunchCeilingsSection` (C6/C6b).
 *
 * `planUpdatedAt` token wiring is preserved EXACTLY: the renderer reads the
 * reviewed plan's `updatedAt` via `plan.get` and echoes it back to
 * `mission.acceptContract` as the stale guard ONLY when an enabled, non-empty,
 * unaccepted plan exists. No plan CONTENT crosses any new boundary — the
 * markdown is already returned by `plan.get`; the modal only echoes the
 * timestamp. On a `plan_stale` outcome the modal shows an in-modal banner and
 * refetches the plan (the accept mutation does not invalidate it), then leaves
 * the Accept button in place for re-review.
 *
 * This file is the composition; each responsibility lives in the sibling
 * `MissionContractModal/` folder (`plan-gate`, `contract-state`,
 * `accept-notice`, `FooterAction`, `LaunchCeilingsSection`).
 */

import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import {
  useAcceptMissionContract,
  useMissionDiff,
  useMissionDraft,
  useSetAutoRetry,
} from "../../lib/api/mission.js";
import { useSessionPlan } from "../../lib/api/sessions.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import {
  AutoRetrySection,
  CardBody,
} from "./MissionContractCardSections.js";
import { PremiumBadge } from "./PremiumBadge.js";
import { acceptNoticeFor, readAcceptOutcome } from "./MissionContractModal/accept-notice.js";
import {
  readDiff,
  readDraft,
  resolveCardState,
  toBadgeState,
  type CardState,
} from "./MissionContractModal/contract-state.js";
import { FooterAction } from "./MissionContractModal/FooterAction.js";
import {
  grantMissionContractRequest,
  refuseMissionContractRequest,
} from "./mission-contract-request.js";
import { LaunchCeilingsSection } from "./MissionContractModal/LaunchCeilingsSection.js";
import {
  readPlan,
  resolvePlanGate,
  type PlanReadState,
} from "./MissionContractModal/plan-gate.js";

export interface MissionContractModalProps {
  readonly sessionId: string;
  readonly permission: "full" | "restricted";
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}

export function MissionContractModal({
  sessionId,
  permission,
  open,
  onOpenChange,
}: MissionContractModalProps): JSX.Element {
  const draftQuery = useMissionDraft(sessionId);
  const draft = readDraft(draftQuery.data);
  const diffQuery = useMissionDiff(sessionId, draft?.missionId ?? null);
  const diff = readDiff(diffQuery.data);
  const planQuery = useSessionPlan(sessionId);
  // isError FIRST: a rejected ipc invoke leaves data undefined forever —
  // reading only `data` would render "loading" with no way out.
  const planReadState: PlanReadState = planQuery.isError
    ? "failed"
    : planQuery.data === undefined
      ? "loading"
      : planQuery.data.ok
        ? "known"
        : "failed";
  const planGate = resolvePlanGate(readPlan(planQuery.data), planReadState);
  const accept = useAcceptMissionContract();
  const autoRetry = useSetAutoRetry();

  const state = useMemo<CardState | null>(
    () => resolveCardState(draft, diff),
    [draft, diff],
  );

  const onAccept = (hash: string): void => {
    accept.mutate(
      {
        sessionId,
        missionId: draft?.missionId ?? "",
        contractHash: hash,
        // Unified accept (Approach A): echo the reviewed plan's `updatedAt` as a
        // stale guard ONLY when an enabled, non-empty, unaccepted plan exists.
        // Plan-mode off / no plan → omitted → default single-accept payload.
        ...(planGate.kind === "ready"
          ? { planUpdatedAt: planGate.planUpdatedAt }
          : {}),
      },
      {
        // A successful accept closes the modal so the Start mission button it
        // points at is actually reachable. Every non-`accepted` outcome (and
        // any transport failure) keeps it open for the in-modal notice.
        // Settle any pending contract request from the COMMIT, never from the
        // press: `granted` is reported only once the engine has answered
        // `accepted`, which is the point the acceptance actually exists. Any
        // other resolved outcome is a real refusal, and a rejected mutation is
        // reported as one too. A caller waiting on this must never be told
        // `granted` for an acceptance that did not commit.
        onSuccess: (result) => {
          if (result.ok && result.data.outcome === "accepted") {
            grantMissionContractRequest(sessionId);
            onOpenChange(false);
            return;
          }
          refuseMissionContractRequest(sessionId);
        },
        onError: () => refuseMissionContractRequest(sessionId),
      },
    );
  };

  const acceptOutcome = readAcceptOutcome(accept.data);
  // A rejected mutation (`isError`, no `data`) OR a resolved-but-failed Result
  // envelope (`ok: false`, a handled IPC/domain error) are both failure
  // surfaces — neither yields an `outcome`, so without this the user would see
  // nothing.
  const acceptErrored =
    accept.isError || (accept.data !== undefined && !accept.data.ok);
  const acceptNotice = acceptNoticeFor(acceptOutcome, acceptErrored);

  // plan_stale recovery: the accept mutation does NOT invalidate the plan
  // query, so refetch it here and keep the modal open with the Accept button
  // in place (in-modal banner via `acceptNotice` flags the re-review).
  //
  // Effect-driven (NOT render-phase): keyed on `accept.data` — TanStack hands
  // back a fresh result object on every settle, so this fires exactly ONCE per
  // accept attempt that resolves to `plan_stale`, never on subsequent re-renders
  // (the previous render-phase `refetch()` looped: each completed refetch
  // re-rendered while `acceptOutcome` was still `plan_stale`, re-triggering it).
  const planRefetch = planQuery.refetch;
  useEffect(() => {
    if (acceptOutcome === "plan_stale") {
      void planRefetch();
    }
    // `accept.data` is intentionally the trigger (new identity per settle); the
    // derived `acceptOutcome` would not change identity across a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accept.data, planRefetch]);

  const title = state?.draft.title?.trim() || "Mission contract";
  const badgeState = toBadgeState(state?.kind, acceptOutcome, planGate);
  const badgeShimmer = badgeState === "ready";

  const showAutoRetry = permission === "full" && state !== null;
  const autoRetryEnabled = state?.draft.constraints.autoRetryEnabled === true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Brand chrome (raised ink panel, hairline, black/70 no-blur backdrop)
       * is the Dialog base since the rebrand — only width is per-modal. */}
      <DialogContent
        data-vex-area="mission-contract-modal"
        className="max-w-lg"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-line-2">
          {/* Mission titles are authored content, not chrome — they speak the
           * Inter Tight display register, not the micro-label stamp. */}
          <DialogTitle className="truncate font-display text-base font-medium normal-case tracking-[-0.01em]">
            {title}
          </DialogTitle>
          {/* Status marker only — the modal is already open, so this is a
           * non-interactive `<span>` (no dead focus target), not the rail's
           * clickable badge. */}
          <span data-vex-state={badgeState} className="shrink-0">
            <PremiumBadge
              label="Mission"
              state={badgeState}
              shimmer={badgeShimmer}
              interactive={false}
            />
          </span>
        </DialogHeader>

        <DialogBody>
          {state === null ? (
            <p className="text-sm text-ink-tertiary">
              Loading the mission contract…
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <CardBody draft={state.draft} />
              {/* Host-authored launch ceilings (C6/C6b). Editable only while the
               * mission is still editable — a started run enforces the ceilings
               * frozen in its own contract snapshot. */}
              <LaunchCeilingsSection
                sessionId={sessionId}
                missionId={state.draft.missionId}
                constraints={state.draft.constraints}
                editable={state.draft.status === "draft" || state.draft.status === "ready"}
              />
              {showAutoRetry ? (
                <AutoRetrySection
                  enabled={autoRetryEnabled}
                  pending={autoRetry.isPending}
                  onToggle={(next) =>
                    autoRetry.mutate({
                      sessionId,
                      missionId: state.draft.missionId,
                      enabled: next,
                    })
                  }
                />
              ) : null}
            </div>
          )}
        </DialogBody>

        <FooterAction
          state={state}
          pending={accept.isPending}
          onAccept={onAccept}
          planGate={planGate}
          onPlanRetry={() => void planQuery.refetch()}
          planRetryPending={planQuery.isFetching}
          notice={acceptNotice}
        />
      </DialogContent>
    </Dialog>
  );
}
