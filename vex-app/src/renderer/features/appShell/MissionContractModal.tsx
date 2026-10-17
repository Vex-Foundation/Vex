/**
 * MissionContractModal - the mission contract review/accept surface: a SHEET
 * over the centre column (docs/design/R3-MINIMAL.md section 12) with both
 * sidebars standing, opened by the title bar's mission badge (`MissionRail`)
 * and by the Review & accept key. It is still the native modal `<dialog>`
 * (`SheetContent`): focus is trapped, Escape closes, focus returns to the
 * trigger, and there is no veil. Head: the crumb "Mission contract / {title}",
 * the status badge, Close · Esc; body: the read-only contract, the launch
 * ceilings, the reasoning effort and (full access) auto-retry, in a centred
 * 720 column; foot: the helper line, Not now and the one blue Accept.
 *
 * This wraps the SAME state machine and hooks as before (`useMissionDraft` +
 * `useMissionDiff` + `useSessionPlan` -> `resolvePlanGate`,
 * `useAcceptMissionContract`, `useSetAutoRetry`). The single accept action
 * lives in the pinned foot, so it can never be pushed below the fold.
 *
 * `planUpdatedAt` token wiring is preserved EXACTLY: the renderer reads the
 * reviewed plan's `updatedAt` via `plan.get` and echoes it back to
 * `mission.acceptContract` as the stale guard ONLY when an enabled, non-empty,
 * unaccepted plan exists. No plan CONTENT crosses any new boundary - the
 * markdown is already returned by `plan.get`; the sheet only echoes the
 * timestamp. On a `plan_stale` outcome the sheet shows an in-sheet notice and
 * refetches the plan (the accept mutation does not invalidate it), then leaves
 * the Accept button in place for re-review.
 *
 * Not now and the close key dismiss through the same path as Escape
 * (`onOpenChange(false)`), which the owner reads as a cancelled contract
 * request, never a refusal.
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
import { useAvailableModels } from "../../lib/api/models.js";
import { DialogClose } from "../../components/ui/dialog.js";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet.js";
import { LineClose } from "../../components/icons/line/index.js";
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
import { ReasoningEffortSection } from "./MissionContractModal/ReasoningEffortSection.js";
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
  // isError FIRST: a rejected ipc invoke leaves data undefined forever -
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
  // Kairos E-1: the current model and its efforts, so the effort section can
  // say which level the run will actually use (the same source the composer
  // reads). `null` until known: the section then shows the pick alone.
  const modelsQuery = useAvailableModels();
  const currentModel = modelsQuery.data?.ok === true ? modelsQuery.data.data.models[0] : undefined;
  const effortModel =
    currentModel !== undefined && currentModel.reasoning !== null
      ? { modelId: currentModel.modelId, capability: currentModel.reasoning }
      : null;

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
        // Plan-mode off / no plan -> omitted -> default single-accept payload.
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
  // surfaces - neither yields an `outcome`, so without this the user would see
  // nothing.
  const acceptErrored =
    accept.isError || (accept.data !== undefined && !accept.data.ok);
  const acceptNotice = acceptNoticeFor(acceptOutcome, acceptErrored);

  // plan_stale recovery: the accept mutation does NOT invalidate the plan
  // query, so refetch it here and keep the modal open with the Accept button
  // in place (in-modal banner via `acceptNotice` flags the re-review).
  //
  // Effect-driven (NOT render-phase): keyed on `accept.data` - TanStack hands
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

  const missionTitle = state?.draft.title?.trim() ?? "";
  const badgeState = toBadgeState(state?.kind, acceptOutcome, planGate);
  const badgeShimmer = badgeState === "ready";

  const showAutoRetry = permission === "full" && state !== null;
  const autoRetryEnabled = state?.draft.constraints.autoRetryEnabled === true;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-vex-area="mission-contract-modal"
        anchor={centreColumn}
      >
        <SheetHeader>
          {/* The crumb names the surface, then the mission (authored content,
           * 16 / 500 ink); without a title the surface name stands alone. */}
          <SheetTitle className="min-w-0 truncate font-normal text-ink-tertiary">
            {missionTitle === "" ? (
              <span className="font-medium text-ink-primary">Mission contract</span>
            ) : (
              <>
                Mission contract <span aria-hidden>/</span>{" "}
                <b className="font-medium text-ink-primary">{missionTitle}</b>
              </>
            )}
          </SheetTitle>
          {/* Status marker only - the sheet is already open, so this is a
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
          <span className="min-w-0 flex-1" />
          <span aria-hidden className="shrink-0 text-[12.5px] text-ink-tertiary">
            Close · Esc
          </span>
          <DialogClose
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <LineClose size={16} />
          </DialogClose>
        </SheetHeader>

        <SheetBody>
          <div className="mx-auto w-full max-w-[720px] pb-8 pt-[18px]">
            {state === null ? (
              <p className="text-[14px] text-ink-tertiary">
                Loading the mission contract…
              </p>
            ) : (
              <>
                {/* Who writes the contract, said once at the top: the host
                 * cannot edit these fields (`mission.updateDraft` is a stub). */}
                <p className="border border-rule px-3.5 py-2.5 text-[13.5px] leading-[1.45] text-ink-secondary">
                  Only Vex can fill these fields; you cannot edit them here.
                  Tell Vex in the chat what to change.
                </p>
                <div className="mt-4">
                  <CardBody draft={state.draft} />
                </div>
                {/* Host-authored launch ceilings (C6/C6b). Editable only while
                 * the mission is still editable - a started run enforces the
                 * ceilings frozen in its own contract snapshot. */}
                <LaunchCeilingsSection
                  sessionId={sessionId}
                  missionId={state.draft.missionId}
                  constraints={state.draft.constraints}
                  editable={state.draft.status === "draft" || state.draft.status === "ready"}
                />
                {/* Kairos E-1: the run's reasoning effort, contract material. */}
                <ReasoningEffortSection
                  sessionId={sessionId}
                  missionId={state.draft.missionId}
                  constraints={state.draft.constraints}
                  editable={state.draft.status === "draft" || state.draft.status === "ready"}
                  model={effortModel}
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
              </>
            )}
          </div>
        </SheetBody>

        <FooterAction
          state={state}
          pending={accept.isPending}
          onAccept={onAccept}
          planGate={planGate}
          onPlanRetry={() => void planQuery.refetch()}
          planRetryPending={planQuery.isFetching}
          notice={acceptNotice}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The box the sheet covers: the centre column under the title bar (section
 * 12). The session panel is that box in a chat; the column body under the
 * head is the fallback. With neither (a test render), the sheet covers the
 * element it is mounted in.
 */
function centreColumn(): Element | null {
  return (
    document.querySelector('[data-vex-session-surface="shell"]') ??
    document.querySelector('[data-vex-area="shell-status-strip"]')
      ?.nextElementSibling ??
    null
  );
}
