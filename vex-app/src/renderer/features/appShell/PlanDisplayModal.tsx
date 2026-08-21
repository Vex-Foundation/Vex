/**
 * PlanDisplayModal — legacy Plan Mode recovery surface, hosted in a top-layer
 * native `<dialog>` (the MISSION RAIL's "Legacy plan" `PremiumBadge` opens it).
 *
 * Plan Mode is retired from the UI: no session can turn it on anymore
 * (`PlanSwitch` is gone). This modal exists only for a session that already
 * carries an enabled plan from before the retirement (`plan.enabled === true`,
 * the same condition the rail badge gates on) — it never advertises Plan Mode
 * as a supported feature, only explains the leftover state and gives an exit:
 * accept the plan to unblock the mission (unaccepted case) or turn Plan Mode
 * off for good. Once disabled, `plan.enabled` flips false, the rail badge
 * stops rendering, and `MissionRail` unmounts this modal entirely.
 *
 * Read-only under `suppressAccept` (mission setup, where the host accepts the
 * plan together with the contract via `MissionContractModal`) withholds only
 * the standalone Accept — "Turn off Plan Mode" stays available there too,
 * since it never conflicts with the unified accept and, with no run started
 * yet, always succeeds (no active run to strand).
 *
 * "Turn off Plan Mode" calls the retained `useSetPlanMode` mutation with
 * `enabled: false`. Main's guarded disable (`main/ipc/sessions/plan.ts`) can
 * refuse with `blocked_pending_acceptance` when an active run holds an
 * enabled, non-empty, unaccepted plan — this NEVER auto-accepts to clear that
 * block; the notice tells the user to stop the mission first (the existing
 * Stop control in `MissionControls`), then turn off.
 *
 * No new IPC and no plan content leaves the renderer: `plan.accept` echoes the
 * reviewed markdown back as `expectedPlanMd` (the optimistic-concurrency guard
 * that already exists), exactly as before.
 */

import type { JSX } from "react";
import type {
  PlanAcceptResult,
  PlanSetEnabledResult,
} from "@shared/schemas/session-plan.js";
import { assertNever } from "@shared/ipc/result.js";
import { MarkdownContent } from "../../lib/markdown/MarkdownContent.js";
import {
  useAcceptPlan,
  useSessionPlan,
  useSetPlanMode,
} from "../../lib/api/sessions.js";
import { useRequestResume } from "../../lib/api/runtime.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";

/**
 * Accent-hairline key for the SECONDARY recovery action (Resume) — quiet
 * until hovered; the primary Accept is the filled cobalt Button default.
 */
const RESUME_KEY =
  "border-accent-primary/55 text-accent-primary hover:border-accent-primary/85 hover:bg-accent-primary/8 hover:text-accent-primary";

export interface PlanDisplayModalProps {
  readonly sessionId: string;
  /** Active mission-run status (from the session detail), or null. */
  readonly missionStatus?: string | null;
  /**
   * When true the read-only plan review still renders but the standalone
   * "Accept plan" action is withheld — the host accepts the plan together with
   * the contract via the unified `mission.acceptContract` step (mission setup,
   * plan-mode on).
   */
  readonly suppressAccept?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
}

export function PlanDisplayModal({
  sessionId,
  missionStatus = null,
  suppressAccept = false,
  open,
  onOpenChange,
}: PlanDisplayModalProps): JSX.Element {
  const planQuery = useSessionPlan(sessionId);
  const acceptPlan = useAcceptPlan();
  const requestResume = useRequestResume();
  const disablePlanMode = useSetPlanMode();

  const plan = planQuery.data?.ok ? planQuery.data.data : null;
  const enabled = plan?.enabled ?? false;
  const hasPlan = enabled && (plan?.planMd?.length ?? 0) > 0;
  const pending = hasPlan && plan?.accepted === false;
  const showAcceptButton = pending && !suppressAccept;
  const awaitingResume =
    hasPlan &&
    plan?.accepted === true &&
    missionStatus === "paused_plan_acceptance";
  // The exit ramp: shown whenever a plan is enabled, regardless of
  // suppressAccept — turning Plan Mode off never conflicts with the unified
  // mission accept, and is the only way out for an already-accepted plan
  // that would otherwise keep this session gated forever.
  const showDisableButton = enabled;

  const acceptBusy = acceptPlan.isPending;
  const resumeBusy = requestResume.isPending;
  const disableBusy = disablePlanMode.isPending;

  // Standalone-accept failure surfacing: `plan.accept` can refuse
  // (stale/no_plan/not_found) or the mutation can reject (transport). Without a
  // notice the user clicks "Accept plan" and sees nothing. Only relevant on the
  // standalone surface (suppressAccept hides the action; the contract modal owns
  // the unified-accept notice there).
  const acceptOutcome = acceptPlan.data?.ok ? acceptPlan.data.data.outcome : null;
  // A rejected mutation OR a resolved-but-failed Result envelope (ok: false) are
  // both failure surfaces with no `outcome`.
  const acceptErrored =
    acceptPlan.isError || (acceptPlan.data !== undefined && !acceptPlan.data.ok);
  const acceptNotice = suppressAccept
    ? null
    : planAcceptNotice(acceptOutcome, acceptErrored);

  // "Turn off Plan Mode" failure surfacing — same shape as the accept notice.
  // `updated` clears to null: the query invalidation this mutation triggers
  // flips `plan.enabled` false, and the rail unmounts this modal entirely, so
  // there is nothing left to show a success notice INTO.
  const disableOutcome = disablePlanMode.data?.ok
    ? disablePlanMode.data.data.outcome
    : null;
  const disableErrored =
    disablePlanMode.isError ||
    (disablePlanMode.data !== undefined && !disablePlanMode.data.ok);
  const disableNotice = planDisableNotice(disableOutcome, disableErrored);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Brand chrome (raised ink panel, hairline, black/70 no-blur backdrop)
       * is the Dialog base since the rebrand — only width is per-modal. */}
      <DialogContent
        data-vex-area="plan-display-modal"
        className="max-w-lg"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-line-2">
          <DialogTitle>Action plan</DialogTitle>
          {hasPlan ? (
            <span
              data-vex-state={pending ? "pending" : "accepted"}
              className={
                pending
                  ? "flex shrink-0 items-center gap-1.5 vex-doto-label uppercase text-warning"
                  : "flex shrink-0 items-center gap-1.5 vex-doto-label uppercase text-success"
              }
            >
              {pending ? (
                // Waiting on the host's decision — a still amber dot (owner
                // decree: no pulsing dots anywhere).
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-warning"
                />
              ) : (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-success"
                />
              )}
              {pending ? "Pending your acceptance" : "Accepted"}
            </span>
          ) : null}
        </DialogHeader>

        <DialogBody>
          {enabled ? (
            <p className="text-xs text-ink-secondary">
              Plan Mode has been retired - no session can turn it on anymore.
              This session still carries a plan from before that change.{" "}
              {pending
                ? "Accept it to unblock the mission, or turn Plan Mode off below."
                : "Turn Plan Mode off below when you no longer need it."}
            </p>
          ) : null}
          {hasPlan ? (
            // Recessed well — the plan reads like a filed document.
            <div className="rounded-xl border border-line-2 bg-surface-deep px-3 py-2">
              <MarkdownContent text={plan?.planMd ?? ""} />
            </div>
          ) : (
            <p className="text-sm text-ink-tertiary">
              No action plan has been authored yet.
            </p>
          )}
          {pending && suppressAccept ? (
            <p className="text-[11px] text-ink-tertiary">
              Accept this plan together with the contract.
            </p>
          ) : null}
        </DialogBody>

        {showAcceptButton ||
        awaitingResume ||
        showDisableButton ||
        acceptNotice !== null ||
        disableNotice !== null ? (
          <DialogFooter className="flex-col items-stretch gap-2 border-line-2 sm:flex-col">
            <div className="flex flex-wrap items-center gap-2">
              {awaitingResume ? (
                <span className="mr-auto text-[11px] text-warning">
                  Accepted, but the run didn’t resume.
                </span>
              ) : null}
              {showAcceptButton ? (
                // THE single primary action — filled cobalt pill.
                <Button
                  type="button"
                  size="sm"
                  disabled={acceptBusy}
                  onClick={() =>
                    acceptPlan.mutate({
                      sessionId,
                      expectedPlanMd: plan?.planMd ?? "",
                    })
                  }
                >
                  {acceptBusy ? "Accepting…" : "Accept plan"}
                </Button>
              ) : null}
              {awaitingResume ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={resumeBusy}
                  onClick={() => requestResume.mutate({ sessionId })}
                  className={RESUME_KEY}
                >
                  {resumeBusy ? "Resuming…" : "Resume mission"}
                </Button>
              ) : null}
              {showDisableButton ? (
                // The exit ramp — a quiet hairline key, never the primary
                // pill: turning a legacy plan off is a housekeeping action,
                // not the recommended path when the plan is still reviewable.
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disableBusy}
                  onClick={() =>
                    disablePlanMode.mutate({ sessionId, enabled: false })
                  }
                >
                  {disableBusy ? "Turning off…" : "Turn off Plan Mode"}
                </Button>
              ) : null}
            </div>
            {acceptNotice !== null ? (
              <p
                role="alert"
                data-vex-state="plan-accept-notice"
                className="w-full text-xs text-warning"
              >
                {acceptNotice}
              </p>
            ) : null}
            {disableNotice !== null ? (
              <p
                role="alert"
                data-vex-state="plan-disable-notice"
                className="w-full text-xs text-warning"
              >
                {disableNotice}
              </p>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Map a standalone `plan.accept` attempt to a user-facing notice.
 *
 * Mirrors `MissionContractModal.acceptNoticeFor`: a resolved non-success
 * `outcome` (handled IPC Result) or a rejected mutation (`isError`, transport
 * failure with no `data`) both surface copy so the user never clicks
 * "Accept plan" and sees nothing. `accepted` → null (the plan refetch reflects
 * success).
 */
function planAcceptNotice(
  outcome: PlanAcceptResult["outcome"] | null,
  isError: boolean,
): string | null {
  if (outcome !== null) {
    switch (outcome) {
      case "accepted":
        return null;
      case "stale":
        return "Plan changed - review again before accepting.";
      case "no_plan":
        return "No plan authored yet - ask Vex to write a plan first.";
      case "not_found":
        return "Couldn't accept: this session no longer exists. Refresh and try again.";
      default:
        return assertNever(outcome);
    }
  }
  if (isError) {
    return "Couldn't accept the plan - something went wrong. Try again.";
  }
  return null;
}

/**
 * Map a "Turn off Plan Mode" (`plan.setEnabled({ enabled: false })`) attempt
 * to a user-facing notice. `updated` → null: the plan-query invalidation this
 * mutation triggers flips `plan.enabled` false, so the rail unmounts this
 * modal — nothing left to show a success notice into.
 *
 * `blocked_pending_acceptance` is the guarded-disable refusal (main strand-
 * guards against stranding an active run parked on an unaccepted plan) — the
 * notice must send the user to the existing Stop control instead of the
 * mutation silently composing an Accept it never asked for.
 */
function planDisableNotice(
  outcome: PlanSetEnabledResult["outcome"] | null,
  isError: boolean,
): string | null {
  if (outcome !== null) {
    switch (outcome) {
      case "updated":
        return null;
      case "blocked_pending_acceptance":
        return "Can't turn off yet - a mission run is waiting on this plan's acceptance. Stop the mission first, then turn off Plan Mode.";
      case "not_found":
        return "Couldn't turn off: this session no longer exists. Refresh and try again.";
      default:
        return assertNever(outcome);
    }
  }
  if (isError) {
    return "Couldn't turn off Plan Mode - something went wrong. Try again.";
  }
  return null;
}
