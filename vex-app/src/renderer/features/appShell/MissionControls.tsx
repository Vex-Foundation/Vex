/**
 * MissionControls - the mission control surface that replaces the mission-*
 * slash commands, mounted in the session column for mission sessions and the
 * sole owner of runtime-gated mission controls
 * (docs/design/R3-MINIMAL.md sections 6 and 7):
 *
 *  - ACTIVE RUN -> only the controls that apply (owner decision: no dotted
 *      dead keys), drawn in the mission strip above the composer:
 *      Continue now (paused_wake, quiet) or Continue (paused_user, the blue
 *      key), Edit contract (any status except paused_approval), Stop mission
 *      (always; disabled only while it would do nothing or a control is in
 *      flight). Recover (paused_error) is the one blue key inside the
 *      paused-on-error callout in the transcript. Behaviour, dispatch and the
 *      gates below are unchanged; only which keys are drawn changed.
 *  - NO ACTIVE RUN + accepted/ready contract -> a "Start mission" key (the
 *    view's blue fill) -> mission.start.
 *  - NO ACTIVE RUN + a terminal accepted mission (the renew source) -> a
 *    "Renew mission" key -> mission.renew (clones it into a fresh draft), with
 *    "Tell Vex what to do differently" beside it.
 *  - NO ACTIVE RUN + a ready, unaccepted draft (the "MISSION READY" state) ->
 *    the blue-outlined "Review & accept contract" key in the same slot,
 *    opening the contract sheet via `uiStore.reviewModal` (owned/rendered by
 *    `MissionRail`, a sibling in the title bar). Reveal is gated on
 *    `useIsChatSubmitting` settling so the key can't flash open mid-turn
 *    during a tool-call gap (the draft can flip to `ready` before the turn's
 *    final text response); a cancelled/failed turn also settles
 *    `chatSubmitting` back to false, so the key can never wedge shut. Only
 *    one next-step surface shows at a time: while reviewable-and-settled,
 *    this key REPLACES the standing notice below, never stacks with it.
 *  - NO ACTIVE RUN + a contract pending acceptance (any non-accepted-clean
 *    draft, still in setup or mid-turn) -> a standing notice: on-chain
 *    actions are blocked by the runtime gate until the user accepts the
 *    contract and starts the run. The notice is STATE-SPECIFIC and CARRIES A
 *    CONTROL: it names the state, the consequence, the next action and WHO
 *    must take it, enumerates the engine's own `missingFields`, and offers
 *    the contract surface (only the agent's `MissionDraftUpdate` writes the
 *    fields; `mission.updateDraft` is a stub), so it is never a dead end.
 *
 * WHERE THE RUN KEYS ARE DRAWN. The keys stay owned here (one set of mutation
 * hooks, so a control in flight disables every other one, Recover in the
 * transcript included) and portal into the cells the composer's mission strip
 * publishes (`MissionControls/mission-strip-slot.ts`). With no strip mounted
 * for this session they render in place under the transcript, so a control
 * is never unreachable.
 *
 * Readiness is NOT derived here. `mission-readiness.ts` owns the single
 * predicate that this surface, `MissionRail`'s badge and the contract sheet
 * all read, so the three surfaces cannot contradict each other.
 *
 * `useMissionLiveSync` is mounted here (event-driven + 30s-fallback refresh
 * of the draft/diff queries) so a dropped `transcriptAppend` event can never
 * strand the review key invisible for a session the user never blurs.
 *
 * The render gate keys off `runtime` ALONE - never the draft. A started
 * mission flips its row past `ready` (commit-start -> `running`; terminal on
 * finalize), so `getDraft` returns null for the entire active/terminal run;
 * gating the controls on a draft hid them for every active run. Start reads
 * the draft, Renew reads the renew-source query - both AFTER the runtime gate.
 *
 * Every control surfaces refusal outcomes (the backend returns `ok:true`
 * classified outcomes like not_accepted / lease_busy / blocked_terminal), not
 * just transport errors, so a race never silently does nothing. Keys are
 * disabled while any control mutation is in flight OR a control request is
 * already pending (runtime.pendingControlKind), preventing double-fire.
 */

import { useCallback, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { assertNever, type Result } from "@shared/ipc/result.js";
import type {
  MissionDraftDto,
  MissionGetDiffResult,
  MissionGetRenewableSourceResult,
  MissionRenewResult,
} from "@shared/schemas/mission.js";
import {
  MONEY_STATE_UNREADABLE,
  type RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import {
  useEditMission,
  useMissionContinue,
  useMissionDiff,
  useMissionDraft,
  useMissionLiveSync,
  useMissionRenew,
  useMissionRetry,
  useMissionStart,
  useMissionStop,
  useRenewableMissionSource,
} from "../../lib/api/mission.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../../components/ui/button.js";
import { Swatch } from "../../components/ui/swatch.js";
import { readStopAvailability } from "./composer-submit/stop-availability.js";
import { resolveStopAffordance } from "./composer-submit/stop-affordance.js";
import { MissionRestartAffordance } from "./MissionRestartAffordance.js";
import { MissionErrorAlert } from "./MissionControls/MissionErrorAlert.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useSessionPlan } from "../../lib/api/sessions.js";
import {
  resolveMissionReadiness,
  type MissionReadiness,
} from "./mission-readiness.js";
import { requestMissionContract } from "./mission-contract-request.js";
import { useMissionSetupProgress } from "./MissionSetupProgress.js";
import { MissionMissingFields } from "./MissionMissingFields.js";
import { useMissionStripSlot } from "./MissionControls/mission-strip-slot.js";

/**
 * The text key of the strip ("Edit contract"): 13 / 500 in the blue, no
 * frame (section 7). Disabled reads muted, never faded.
 */
const LINK_KEY =
  "inline-flex h-8 shrink-0 items-center text-[13px] font-medium text-accent-primary underline-offset-4 enabled:hover:underline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-ink-tertiary";

export interface MissionControlsProps {
  readonly sessionId: string;
}

type ControlNotice = { readonly tone: "error"; readonly text: string } | null;

/** Outcomes that mean the control succeeded - no notice needed. */
const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set([
  "dispatched",
  "resumed",
  "already_running",
  "stopped",
  "queued",
]);

/**
 * Map a control Result to a user notice. `null` = success (clear the notice).
 * Refusal outcomes (`ok:true` but not a success literal) get friendly copy so
 * a race / blocked control is never invisible.
 */
function noticeFor(r: Result<{ readonly outcome: string }>): string | null {
  if (!r.ok) return r.error.message;
  if (SUCCESS_OUTCOMES.has(r.data.outcome)) return null;
  switch (r.data.outcome) {
    case "lease_busy":
      return "Busy - another operation is in progress. Try again.";
    case "no_active_run":
      return "No active mission run.";
    case "not_accepted":
    case "stale_acceptance":
      return "Accept the contract before starting.";
    case "plan_not_accepted":
      return "Plan not accepted - review and accept the plan before starting.";
    case "not_ready":
      return "Outline the mission before starting.";
    case "blocked_approval":
      return "Resolve the pending approval first.";
    case "blocked_error":
      return "Mission paused after an error - use Recover.";
    case "blocked_terminal":
    case "already_terminal":
      return "The mission run has already ended.";
    case "not_recoverable":
      return "This pause isn't an error - use Continue.";
    case "session_has_active_run":
    case "active_run_exists":
      return "A mission run is already active.";
    case "no_failed_run":
      return "No failed run to recover.";
    case "provider_unavailable":
      return "No inference provider - unlock Vex or set up a provider.";
    case "status_changed":
      return "Mission state changed - re-check and retry.";
    case "blocked_money_state":
      // The wave-1 recovery money gate. NOT a generic failure: the run is
      // recoverable, but something on the money path has no proven outcome
      // yet, and resuming on top of it is how a double spend happens. Say
      // that, and say what clears it, without naming rows or providers.
      return "Recover is blocked: a wallet or approval action from this session has no confirmed outcome yet. It clears once that settles.";
    default:
      return "Couldn't complete the action. Re-check the mission state.";
  }
}

/**
 * Renew has its own outcome vocabulary that collides by STRING with the other
 * controls (e.g. `not_accepted` here means "the source mission was never
 * accepted", not "accept this draft"; `session_has_active_run` is renew-only),
 * so it gets a dedicated mapper instead of the shared `noticeFor`. `renewed` is
 * the success literal -> null (clears the notice).
 */
function renewNoticeFor(r: Result<MissionRenewResult>): string | null {
  if (!r.ok) return r.error.message;
  switch (r.data.outcome) {
    case "renewed":
      return null;
    case "previous_mission_not_found":
      return "The mission to renew was not found.";
    case "session_mismatch":
      return "That mission belongs to a different session.";
    case "not_accepted":
      return "The source mission was never accepted - nothing to renew from.";
    case "not_terminal_yet":
      return `The source mission isn't finished yet (status ${r.data.runStatus}). Wait for it to finish first.`;
    case "session_has_active_run":
      return `A mission run is already active (status ${r.data.runStatus}). Stop it before renewing.`;
    case "session_has_pending_draft":
      return "A draft mission already exists for this session - accept or discard it before renewing again.";
    default:
      return assertNever(r.data);
  }
}

function readDraft(
  data: Result<MissionDraftDto | null> | undefined,
): MissionDraftDto | null {
  return data && data.ok ? data.data : null;
}

function readReadyDiff(
  data: Result<MissionGetDiffResult> | undefined,
): Extract<MissionGetDiffResult, { outcome: "ready" }> | null {
  if (!data || !data.ok || data.data.outcome !== "ready") return null;
  return data.data;
}

function readRuntime(
  data: Result<RuntimeStateDto> | undefined,
): RuntimeStateDto | null {
  return data && data.ok ? data.data : null;
}

/** The renew source ({ missionId } when a terminal accepted mission exists) or null. */
function readRenewable(
  data: Result<MissionGetRenewableSourceResult> | undefined,
): MissionGetRenewableSourceResult {
  return data && data.ok ? data.data : null;
}

export function MissionControls({
  sessionId,
}: MissionControlsProps): JSX.Element | null {
  const runtimeQuery = useRuntimeState(sessionId);
  const draftQuery = useMissionDraft(sessionId);
  const draft = readDraft(draftQuery.data);
  const diffQuery = useMissionDiff(sessionId, draft?.missionId ?? null);
  const planQuery = useSessionPlan(sessionId);
  // Readiness requires a SUCCESSFUL plan read: while the query is pending or
  // failed the plan state is UNKNOWN, and unknown must read as not-ready -
  // collapsing it to null would make planMissing(null) vacuously false and
  // let the review bar flash during loading or survive a plan.get failure.
  const planKnown = planQuery.data?.ok === true;
  const plan = planQuery.data?.ok === true ? planQuery.data.data : null;
  const renewableQuery = useRenewableMissionSource(sessionId);

  const start = useMissionStart();
  const cont = useMissionContinue();
  const recover = useMissionRetry();
  const edit = useEditMission();
  const stop = useMissionStop();
  const renew = useMissionRenew();

  // Keep the draft/diff queries fresh (event-driven + 30s fallback poll) so
  // the review bar below can never be stranded by a dropped transcript event.
  useMissionLiveSync(sessionId);
  // Setup liveness: distinguishes "still drafting" from "drafting stalled".
  const { stalled } = useMissionSetupProgress(sessionId);
  // Turn-gate for the review bar's reveal - see the file header comment.
  const chatSubmitting = useIsChatSubmitting(sessionId);
  const setReviewModal = useUiStore((s) => s.setReviewModal);

  const [notice, setNotice] = useState<ControlNotice>(null);
  // The composer strip's cells for this session (none when it is not mounted).
  const strip = useMissionStripSlot(sessionId);

  const run = useCallback(
    async <T extends { readonly outcome: string }>(
      action: () => Promise<Result<T>>,
      map: (r: Result<T>) => string | null = noticeFor,
    ): Promise<void> => {
      try {
        const text = map(await action());
        setNotice(text === null ? null : { tone: "error", text });
      } catch {
        setNotice({
          tone: "error",
          text: "Couldn't complete the action. Re-check the mission state.",
        });
      }
    },
    [],
  );

  const runtime = readRuntime(runtimeQuery.data);
  // Render gate: only the runtime state is required. The active-run toolbar and
  // every gate below read it; the draft / renew-source are read AFTER this so a
  // null draft (always true mid-run) never hides the controls.
  if (runtime === null) return null;

  const anyPending =
    start.isPending ||
    cont.isPending ||
    recover.isPending ||
    edit.isPending ||
    stop.isPending ||
    renew.isPending;
  // Disable while a control is in flight OR one is already pending server-side.
  const disabled = anyPending || runtime.pendingControlKind !== null;

  // ACTIVE RUN -> status-gated toolbar (keys off runtime.status alone).
  if (runtime.hasActiveRun) {
    const status = runtime.status;
    const canContinue = status === "paused_wake" || status === "paused_user";
    // M3/M5: the money gate is enforced in the privileged retry IPC and
    // MIRRORED here. FAIL-CLOSED, and it is worth being exact about why.
    //
    // The mirror's own schema calls itself fail-closed - an unreadable money
    // state projects `blocked`. This branch used to undo that by reading an
    // ABSENT field as permission: `!blocked` is true for `undefined`, so the
    // one case the mirror could not answer was the one case the button was
    // offered for. An affordance granted on a fact nobody computed is exactly
    // the "unknown read as clear" the money rules forbid.
    //
    // So Recover now requires the POSITIVE answer. Absent is unknown, unknown
    // is not ready, and the operator is told which of the two it is rather
    // than being handed a click that can only fail. The IPC remains the
    // authority and refuses on its own read regardless of any of this.
    const isPausedError = status === "paused_error";
    const recovery = runtime.recoveryReady;
    const recoveryBlocked = isPausedError && recovery?.kind === "blocked";
    const recoveryUnknown = isPausedError && recovery === undefined;
    const canRecover = isPausedError && recovery?.kind === "ready";
    const canEdit = status !== "paused_approval";
    // The same selector the composer's send/stop key reads (M6). Both surfaces
    // reach `runStopDispatch`: `mission.stop` and `runtime.requestStop` are two
    // channel names for that one dispatcher.
    const stopAffordance = resolveStopAffordance(
      readStopAvailability(sessionId, runtimeQuery.data, runtimeQuery.isError),
      "mission",
      false,
    );
    // ONLY THE CONTROLS THAT APPLY (owner decision): a key whose status rules
    // it out is not drawn at all, instead of a dotted dead key. The gates are
    // the same ones that used to disable them; Stop is always drawn.
    const keys = (
      <div
        data-vex-area="mission-controls"
        role="group"
        aria-label="Mission controls"
        className="flex shrink-0 items-center gap-3.5"
      >
        {canContinue ? (
          status === "paused_wake" ? (
            // Sleeping wakes by itself; this wakes it now (proposal copy).
            <Button
              variant="quiet"
              size="sm"
              disabled={disabled}
              onClick={() => void run(() => cont.mutateAsync({ sessionId }))}
            >
              Continue now
            </Button>
          ) : (
            // Paused by the user: Continue is the strip's one blue key.
            <Button
              variant="primary"
              size="sm"
              aria-label="Continue mission"
              disabled={disabled}
              onClick={() => void run(() => cont.mutateAsync({ sessionId }))}
            >
              Continue
            </Button>
          )
        ) : null}
        {canEdit ? (
          // Edit stops the run and returns the mission to a draft that Vex
          // and the user change together (`useEditMission`).
          <button
            type="button"
            disabled={disabled}
            onClick={() => void run(() => edit.mutateAsync({ sessionId }))}
            className={LINK_KEY}
          >
            Edit contract
          </button>
        ) : null}
        {/* Stop is the ink outline (the refusing choice), never red, and it
            is named apart from the composer's Stop turn. */}
        <Button
          variant="ink"
          size="sm"
          aria-label={stopAffordance.label}
          disabled={disabled || !stopAffordance.offered}
          onClick={() => void run(() => stop.mutateAsync({ sessionId }))}
        >
          {stopAffordance.label}
        </Button>
      </div>
    );
    const noticeLine =
      notice !== null ? <ControlNoticeLine text={notice.text} /> : null;
    return (
      <>
        {/* Keyed on the PAUSE, never on the button. The alert explains why the
            run stopped - the restart, the repeated tool call, the provider
            error - and that explanation is most needed precisely when recovery
            is blocked. Gating it on `canRecover` meant a blocked money state
            silently removed the only account of what happened, leaving a
            disabled button and no reason for either fact. Recover sits in it
            as the one blue key; while the money gate holds it is disabled
            and the reason is stated under it. */}
        {isPausedError ? (
          <MissionErrorAlert
            stopReason={runtime.stopReason}
            lastError={runtime.lastError}
            actions={
              <Button
                variant="primary"
                size="sm"
                aria-label="Recover mission"
                aria-busy={recover.isPending}
                disabled={disabled || !canRecover}
                onClick={() => void run(() => recover.mutateAsync({ sessionId }))}
              >
                {recover.isPending ? "Recovering…" : "Recover"}
              </Button>
            }
            notes={
              recoveryBlocked ? (
                <ControlNoticeLine
                  text={recoveryBlockedText(recovery)}
                  tone="warning"
                />
              ) : recoveryUnknown ? (
                <ControlNoticeLine text={RECOVERY_UNKNOWN_TEXT} tone="warning" />
              ) : null
            }
          />
        ) : null}
        {strip.controls !== null ? (
          createPortal(keys, strip.controls)
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3.5">{keys}</div>
        )}
        {noticeLine === null
          ? null
          : strip.notes !== null
            ? createPortal(<div className="pb-2">{noticeLine}</div>, strip.notes)
            : <div className="mt-2">{noticeLine}</div>}
      </>
    );
  }

  // NO ACTIVE RUN -> Start an accepted/ready draft; Start wins over Renew when
  // both could apply (a freshly accepted contract is the more immediate action).
  const diff = readReadyDiff(diffQuery.data);
  // THE readiness answer (see `mission-readiness.ts`). The header badge and the
  // contract modal read the same function, so this strip can no longer disagree
  // with either about whether the contract is acceptable.
  const readiness = resolveMissionReadiness({
    draft,
    diff,
    plan,
    planKnown,
    setupStalled: stalled,
  });
  const canStart = readiness.kind === "accepted";
  // Contract pending acceptance (a draft exists that is not accepted-clean)
  // with no active run: the runtime prequote gate fail-closes EVERY on-chain
  // broadcast (reason `wallet_setup`), so surface that as a standing notice -
  // the user must see the block deterministically, not via a paraphrased (and
  // possibly confabulated) agent reply to a blocked tool call. The notice now
  // CARRIES the way forward instead of only naming the block.
  const pendingAcceptance = readiness.kind !== "none" && !canStart;
  const raiseContract = (): void => {
    setReviewModal("mission");
    void requestMissionContract({ sessionId, reason: "user" });
  };
  if (canStart && draft !== null) {
    const missionId = draft.missionId;
    return (
      <div
        data-vex-area="mission-controls"
        className="mb-4 mt-1 flex flex-wrap items-center gap-3.5"
      >
        {/* The view's one blue fill: the run starts only from here. */}
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              const result = await start.mutateAsync({ sessionId, missionId });
              // Pattern 1 (VS Code `startDebugging` -> `requestWorkspaceTrust`):
              // the blocked capability RAISES the contract surface rather than
              // reporting a refusal the user then has to act on by guesswork.
              // Only for refusals the contract surface can actually resolve.
              if (
                result.ok &&
                CONTRACT_BLOCKED_START_OUTCOMES.has(result.data.outcome)
              ) {
                setReviewModal("mission");
                void requestMissionContract({
                  sessionId,
                  reason: "start_blocked",
                });
              }
              return result;
            })
          }
          aria-label="Start mission"
        >
          Start mission
        </Button>
        {notice !== null ? <ControlNoticeLine text={notice.text} /> : null}
      </div>
    );
  }

  // Reviewable: a ready draft awaiting acceptance - the "MISSION READY" state.
  // Gated on the turn settling (never on the draft/diff data alone) so the
  // bar can't flash open mid-turn during a tool-call gap; a cancelled/failed
  // turn also settles `chatSubmitting` back to false, so a stuck turn can
  // never wedge the bar shut. When not yet settled (or not reviewable), fall
  // through to the pre-existing affordances below unchanged - the standing
  // notice already covers this state, so nothing regresses mid-turn.
  // The plan gate lives inside `resolveMissionReadiness`: with legacy plan-mode
  // on and no plan body the readiness is `awaiting-plan`, so the rail says
  // Preparing and the bar cannot lead it.
  const reviewable = readiness.kind === "awaiting-acceptance";
  if (reviewable && !chatSubmitting) {
    return (
      <div data-vex-area="mission-controls" className="mb-4 mt-1">
        {/* The pre-accept counterpart of Start: the blue outline key. */}
        <Button
          variant="ghost"
          onClick={raiseContract}
          aria-label="Review & accept contract"
        >
          Review &amp; accept contract
        </Button>
      </div>
    );
  }

  // No startable draft, but a terminal accepted mission exists -> Renew clones it
  // into a fresh draft (the new contract must still be accepted before it runs,
  // so this is non-destructive and needs no confirm step).
  const renewSource = readRenewable(renewableQuery.data);
  // `draft === null` guard mirrors MissionRail's load-bearing guard:
  // `getRenewableSourceForSession` keeps returning the OLD terminal accepted
  // mission even after `mission.renew` (or `edit`) inserts a fresh draft. Without
  // this guard the Renew button LINGERS once a fresh draft exists - so a renew
  // looks like it "does nothing", and each extra click clones ANOTHER duplicate
  // draft. Gating on `draft === null` lets the fresh draft fall through to the
  // acceptance-pending UI below (accept it, then Start).
  if (renewSource !== null && draft === null) {
    const previousMissionId = renewSource.missionId;
    return (
      <div
        data-vex-area="mission-controls"
        className="mb-[18px] mt-1 flex flex-wrap items-center gap-3.5"
      >
        {pendingAcceptance ? (
          <AcceptancePendingNotice
            readiness={readiness}
            onOpenContract={raiseContract}
          />
        ) : null}
        <Button
          variant="quiet"
          disabled={disabled}
          onClick={() =>
            void run(
              () => renew.mutateAsync({ sessionId, previousMissionId }),
              renewNoticeFor,
            )
          }
          aria-label="Renew mission"
        >
          Renew mission
        </Button>
        {/* Same terminal state, different intent: Renew clones the contract
            into a draft that must be accepted again; this restarts the SAME
            accepted contract with one added instruction. */}
        <MissionRestartAffordance
          sessionId={sessionId}
          missionId={previousMissionId}
          disabled={disabled}
        />
        {notice !== null ? <ControlNoticeLine text={notice.text} /> : null}
      </div>
    );
  }

  // Contract pending acceptance with nothing else to show -> the standing
  // notice, which carries its own control so this is never a dead end.
  if (pendingAcceptance) {
    return (
      <div data-vex-area="mission-controls" className="mt-1">
        <AcceptancePendingNotice
          readiness={readiness}
          onOpenContract={raiseContract}
        />
      </div>
    );
  }

  return null;
}

/**
 * `mission.start` refusals the CONTRACT surface can actually resolve. A refusal
 * outside this set (lease busy, provider unavailable, an already-active run) is
 * not a contract problem, and raising the contract for it would be a wrong
 * answer wearing a helpful shape.
 */
const CONTRACT_BLOCKED_START_OUTCOMES: ReadonlySet<string> = new Set([
  "not_accepted",
  "stale_acceptance",
  "not_ready",
  "plan_not_accepted",
]);

/**
 * Standing notice while a mission session's contract is pending acceptance:
 * mirrors the runtime prequote gate's `wallet_setup` fail-close (no active run
 * -> every swap/bridge/send broadcast is refused), so the block is visible in
 * the UI regardless of how the agent narrates it.
 *
 * Every branch below follows the same shape, taken from VS Code's Restricted
 * Mode copy: STATE -> CONSEQUENCE -> NEXT ACTION, with the actor NAMED. The old
 * copy stopped after the consequence, and the modal it pointed at then told the
 * user to "Add a goal, constraints, and stop conditions" - fields the host
 * cannot edit at all, because `mission.updateDraft` is a stub and only the
 * agent's `MissionDraftUpdate` tool can write them. Naming the wrong actor was
 * the specific defect; every branch here names the right one.
 *
 * The block itself is UNCHANGED. This is presentation over the same fail-closed
 * gate - nothing here grants, widens or bypasses any authority.
 */
function AcceptancePendingNotice({
  readiness,
  onOpenContract,
}: {
  readonly readiness: MissionReadiness;
  readonly onOpenContract: () => void;
}): JSX.Element | null {
  if (readiness.kind === "none" || readiness.kind === "accepted") return null;

  const blocked =
    "On-chain actions (swaps, bridges, sends) stay blocked until the contract is accepted and the mission is started.";

  let headline: string;
  let nextAction: string;
  let actionLabel = "Show mission contract";
  let missingFields: readonly string[] = [];

  switch (readiness.kind) {
    case "drafting":
      missingFields = readiness.missingFields;
      if (readiness.stalled) {
        headline = "Vex's last reply did not add anything to the mission contract.";
        nextAction =
          "Nothing will change until you reply. Answer Vex in the composer below, or ask it to fill what is left:";
      } else {
        headline = "Vex is still writing the mission contract.";
        nextAction =
          "Only Vex can fill these fields; you cannot edit them here. Tell Vex what is still missing:";
      }
      break;
    case "contract-loading":
      headline = "Reading the mission contract.";
      nextAction = "Open the contract to see where it stands.";
      break;
    case "awaiting-plan":
      headline = "The mission contract is complete, but this session's legacy plan mode has no action plan yet.";
      nextAction =
        "Ask Vex to write the plan, then accept the contract and the plan together.";
      break;
    case "plan-unknown":
      // NOT "your plan is missing" - we have not read it. Rule 08: unknown and
      // absent are different states and must not collapse into one message.
      headline = "The mission contract is complete, but its legacy action-plan status has not been read yet, so accepting is unavailable.";
      nextAction = "Open the contract to see the plan status and retry the read.";
      break;
    case "awaiting-acceptance":
      // Reached only MID-TURN: once the turn settles, the dedicated
      // "Review & accept contract" bar replaces this notice. The label stays
      // the passive "Show mission contract" on purpose - promoting the accept
      // CTA here would re-introduce exactly the mid-turn flash the turn-gate
      // exists to prevent, on a contract the running turn may still change.
      headline = "The mission contract looks ready.";
      nextAction = "Vex is still replying; review and accept once it settles.";
      break;
    case "dirty-acceptance":
      headline = "The mission contract changed after you accepted it.";
      nextAction =
        "Review what changed and accept the new contract to bring the runtime back in sync.";
      actionLabel = "Review & accept new contract";
      break;
  }

  // A status line, not a card: a quiet accent rule on its left instead of a
  // framed box, the state in one 13 line, the next action and the block in
  // muted 12.5 under it, and the action beside the words. The words are
  // unchanged; only their weight in the transcript is.
  return (
    <div
      role="status"
      data-vex-state="acceptance-pending"
      data-vex-readiness={readiness.kind}
      className="mb-3 flex w-full basis-full items-start gap-3 border-l-[1.5px] border-accent-primary py-0.5 pl-3 text-[12.5px] leading-[1.45]"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-start gap-2 text-[13px] text-ink-primary">
          <span aria-hidden className="mt-[4px] inline-flex shrink-0 text-accent-primary">
            <Swatch state="awaiting" size={10} />
          </span>
          <span>{headline}</span>
        </p>
        {/* The next action runs straight into the fields it asks for (its
          * colon introduces them), then the block. */}
        <div className="text-ink-tertiary">
          {nextAction}{" "}
          <MissionMissingFields fields={missingFields} surface="mission-controls" variant="inline" />{" "}
          {blocked}
        </div>
      </div>
      {/* The action lives on the notice itself: a standing surface that names a
          restriction must carry the way out of it (VS Code puts the command on
          the banner, the status bar entry and the editor alike). This notice is
          non-dismissible, so the affordance can never be closed away; the
          header MISSION badge carries the same action independently. */}
      <Button
        variant="quiet"
        size="sm"
        onClick={onOpenContract}
        className="shrink-0"
      >
        {actionLabel}
      </Button>
    </div>
  );
}

/**
 * Why Recover is disabled, stated where the disabled button is (rule 08: a
 * control that refuses must say what it is waiting for, and the disabled
 * attribute alone says nothing to anyone).
 *
 * Structural only. The blocking `reasonKinds` are internal labels for the
 * audit log, never operator copy, and naming a row would leak money-path
 * detail into the renderer for no gain.
 */
const RECOVERY_BLOCKED_TEXT =
  "Recover is unavailable: a wallet or approval action from this session has no confirmed outcome yet. It re-enables once that settles.";

/**
 * The DIFFERENT sentence for "we could not check".
 *
 * These are two genuinely different situations and collapsing them was a lie
 * in one direction: the copy above asserts that an action exists and is
 * settling, which tells an operator to wait for something that may not be
 * there. `money_state_unreadable` means the mirror could not read the state at
 * all - a database that did not answer - and the honest thing to say is that
 * nothing is known, not to invent a pending action.
 *
 * It still fails closed: unreadable disables Recover exactly as blocked does
 * (rule 90 - an unknown outcome is not a clear one). Only the words differ,
 * because only the words were wrong.
 */
const RECOVERY_UNREADABLE_TEXT =
  "Recover is unavailable: Vex could not check this session's wallet and approval state. Retry once the local services are responding.";

/**
 * The third sentence: `paused_error` with NO mirror computed at all.
 *
 * Distinct from unreadable, which is main having tried and failed. This is the
 * field simply absent - an older main, a state pushed before the mirror
 * existed, a projection that did not run. Same fail-closed outcome, and again
 * the operator is told which unknown this is instead of being shown a blocked
 * reason that was never reported.
 */
const RECOVERY_UNKNOWN_TEXT =
  "Recover is unavailable: Vex has not confirmed this session's wallet and approval state yet.";

/**
 * Blocked copy by REASON, mapping the reader's structural labels to the two
 * sentences the operator can act on.
 *
 * `reasonKinds` is an OPEN set by contract - the money-state reader gains kinds
 * as the money path gains state machines - so this maps the one kind whose
 * meaning is categorically different and keeps a total default for the rest.
 * A future kind is an unresolved outcome until someone decides otherwise,
 * which is the safe way for this default to be wrong.
 */
function recoveryBlockedText(
  recovery: RuntimeStateDto["recoveryReady"],
): string {
  if (recovery === undefined || recovery.kind !== "blocked") {
    return RECOVERY_BLOCKED_TEXT;
  }
  return recovery.reasonKinds.includes(MONEY_STATE_UNREADABLE)
    ? RECOVERY_UNREADABLE_TEXT
    : RECOVERY_BLOCKED_TEXT;
}

function ControlNoticeLine({
  text,
  tone,
}: {
  readonly text: string;
  /** `error` (default) speaks as an alert; `warning` is a standing status. */
  readonly tone?: "error" | "warning";
}): JSX.Element {
  return (
    <p
      role={tone === "warning" ? "status" : "alert"}
      className={cn(
        "w-full text-[13px] leading-5",
        tone === "warning" ? "text-ink-secondary" : "text-ink-primary",
      )}
    >
      {text}
    </p>
  );
}
