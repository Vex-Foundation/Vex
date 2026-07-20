/**
 * MissionControls — the mission control surface that replaces the mission-*
 * slash commands. A single strip mounted above the composer for mission
 * sessions, the sole owner of runtime-gated mission controls:
 *
 *  - ACTIVE RUN → a status-gated toolbar:
 *      Continue (paused_wake/paused_user), Recover (paused_error),
 *      Edit (any status except paused_approval), Stop (always).
 *  - NO ACTIVE RUN + accepted/ready contract → a "Start mission" key
 *    (accent-hairline, S3) → mission.start.
 *  - NO ACTIVE RUN + a terminal accepted mission (the renew source) → a
 *    "Renew mission" button → mission.renew (clones it into a fresh draft).
 *  - NO ACTIVE RUN + a ready, unaccepted draft (the "MISSION READY" state) →
 *    a full-width accent-OUTLINED "Review & accept contract" bar (vs the
 *    solid Start key above) in the same slot, opening the mission dialog via
 *    `uiStore.reviewModal` (owned/rendered by `MissionRail`, a sibling
 *    component in the header cluster). Previously this state surfaced only
 *    the passive notice below with no visible control — the shimmering
 *    MISSION READY badge was the only path to the accept dialog. Reveal is
 *    gated on `useIsChatSubmitting` settling so the bar can't flash open
 *    mid-turn during a tool-call gap (the draft can flip to `ready` before
 *    the turn's final text response); a cancelled/failed turn also settles
 *    `chatSubmitting` back to false, so the bar can never wedge shut. Only
 *    one next-step surface shows at a time: while reviewable-and-settled,
 *    this bar REPLACES the standing notice below, never stacks with it.
 *  - NO ACTIVE RUN + a contract pending acceptance (any non-accepted-clean
 *    draft, still in setup or mid-turn) → a standing muted-warn notice:
 *    on-chain actions are blocked by the runtime gate until the user accepts
 *    the contract and starts the run.
 *
 * `useMissionLiveSync` is mounted here (event-driven + 30s-fallback refresh
 * of the draft/diff queries) so a dropped `transcriptAppend` event can never
 * strand the review bar invisible for a session the user never blurs.
 *
 * The render gate keys off `runtime` ALONE — never the draft. A started
 * mission flips its row past `ready` (commit-start → `running`; terminal on
 * finalize), so `getDraft` returns null for the entire active/terminal run;
 * gating the toolbar on a draft hid it for every active run. Start reads the
 * draft, Renew reads the renew-source query — both AFTER the runtime gate.
 *
 * Every control surfaces refusal outcomes (the backend returns `ok:true`
 * classified outcomes like not_accepted / lease_busy / blocked_terminal), not
 * just transport errors, so a race never silently does nothing. Buttons are
 * disabled while any control mutation is in flight OR a control request is
 * already pending (runtime.pendingControlKind), preventing double-fire.
 */

import { useCallback, useState } from "react";
import type { JSX } from "react";
import { assertNever, type Result } from "@shared/ipc/result.js";
import type {
  MissionDraftDto,
  MissionGetDiffResult,
  MissionGetRenewableSourceResult,
  MissionGetSessionResultResult,
  MissionRenewResult,
  MissionResultDto,
} from "@shared/schemas/mission.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import {
  useEditMission,
  useMissionContinue,
  useMissionDiff,
  useMissionDraft,
  useMissionLiveSync,
  useMissionRenew,
  useMissionRetry,
  useMissionSessionResult,
  useMissionStart,
  useMissionStop,
  useRenewableMissionSource,
} from "../../lib/api/mission.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useSessionPlan } from "../../lib/api/sessions.js";
import { planMissing } from "./MissionRail.js";
import { MissionSummaryCard } from "./MissionSummaryCard.js";

/**
 * Primary mission action (Start/Renew) — the landing's solid cobalt CTA:
 * full-width mono-uppercase pill, hover is a color change only (never a
 * glow or gradient).
 */
const PRIMARY_KEY =
  "flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[var(--vex-accent)] font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--vex-accent-contrast)] transition-colors hover:bg-[var(--vex-accent-hover)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Review-&-accept bar — the pre-accept counterpart of `PRIMARY_KEY`: an
 * accent-OUTLINED full-width pill (vs. the solid commitment key above),
 * reusing the same `--vex-accent-border-strong`/`--vex-accent-fill-8`/
 * `--vex-accent-text` tokens the rest of the shell already uses for an
 * "outlined, accent-toned" affordance (`PlanSwitch`, `ReasoningSwitch`), so
 * it re-tints correctly across themes (incl. hypervexing) alongside the
 * solid key.
 */
const REVIEW_KEY =
  "flex h-10 w-full items-center justify-center gap-2 rounded-full border border-[var(--vex-accent-border-strong)] bg-[var(--vex-accent-fill-8)] font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--vex-accent-text)] transition-colors hover:bg-[var(--vex-accent-fill-12)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";

export interface MissionControlsProps {
  readonly sessionId: string;
}

type ControlNotice = { readonly tone: "error"; readonly text: string } | null;

/** Outcomes that mean the control succeeded — no notice needed. */
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
      return "Busy — another operation is in progress. Try again.";
    case "no_active_run":
      return "No active mission run.";
    case "not_accepted":
    case "stale_acceptance":
      return "Accept the contract before starting.";
    case "plan_not_accepted":
      return "Plan not accepted — review and accept the plan before starting.";
    case "not_ready":
      return "Outline the mission before starting.";
    case "blocked_approval":
      return "Resolve the pending approval first.";
    case "blocked_error":
      return "Mission paused after an error — use Recover.";
    case "blocked_terminal":
    case "already_terminal":
      return "The mission run has already ended.";
    case "not_recoverable":
      return "This pause isn't an error — use Continue.";
    case "session_has_active_run":
    case "active_run_exists":
      return "A mission run is already active.";
    case "no_failed_run":
      return "No failed run to recover.";
    case "provider_unavailable":
      return "No inference provider — unlock Vex or set up a provider.";
    case "status_changed":
      return "Mission state changed — re-check and retry.";
    default:
      return "Couldn't complete the action. Re-check the mission state.";
  }
}

/**
 * Renew has its own outcome vocabulary that collides by STRING with the other
 * controls (e.g. `not_accepted` here means "the source mission was never
 * accepted", not "accept this draft"; `session_has_active_run` is renew-only),
 * so it gets a dedicated mapper instead of the shared `noticeFor`. `renewed` is
 * the success literal → null (clears the notice).
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
      return "The source mission was never accepted — nothing to renew from.";
    case "not_terminal_yet":
      return `The source mission isn't finished yet (status ${r.data.runStatus}). Wait for it to finish first.`;
    case "session_has_active_run":
      return `A mission run is already active (status ${r.data.runStatus}). Stop it before renewing.`;
    case "session_has_pending_draft":
      return "A draft mission already exists for this session — accept or discard it before renewing again.";
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

/**
 * The session's latest FINALIZED ledger row, or null while it is still
 * running / absent / unreadable.
 *
 * Deliberately NOT gated on which terminal outcome it was: a `failed` run
 * that wrote a summary is exactly the run whose account the operator needs
 * most, so only a still-`running` row is withheld (it has no result yet).
 */
function readFinalizedResult(
  data: Result<MissionGetSessionResultResult> | undefined,
): MissionResultDto | null {
  const result = data && data.ok ? data.data : null;
  if (result === null || result.outcome === "running") return null;
  return result;
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
  // failed the plan state is UNKNOWN, and unknown must read as not-ready —
  // collapsing it to null would make planMissing(null) vacuously false and
  // let the review bar flash during loading or survive a plan.get failure.
  const planKnown = planQuery.data?.ok === true;
  const plan = planQuery.data?.ok === true ? planQuery.data.data : null;
  const renewableQuery = useRenewableMissionSource(sessionId);
  // The finished run's ledger row, for the summary card below the controls.
  const sessionResultQuery = useMissionSessionResult(sessionId);
  // View-state only: a dismissed summary stays dismissed here too, so the ×
  // means the same thing on both surfaces and "Show hidden" in Missions
  // brings this one back as well.
  const dismissedRunIds = useUiStore((s) => s.dismissedMissionRunIds);

  const start = useMissionStart();
  const cont = useMissionContinue();
  const recover = useMissionRetry();
  const edit = useEditMission();
  const stop = useMissionStop();
  const renew = useMissionRenew();

  // Keep the draft/diff queries fresh (event-driven + 30s fallback poll) so
  // the review bar below can never be stranded by a dropped transcript event.
  useMissionLiveSync(sessionId);
  // Turn-gate for the review bar's reveal — see the file header comment.
  const chatSubmitting = useIsChatSubmitting(sessionId);
  const setReviewModal = useUiStore((s) => s.setReviewModal);

  const [notice, setNotice] = useState<ControlNotice>(null);

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

  // ACTIVE RUN → status-gated toolbar (keys off runtime.status alone).
  if (runtime.hasActiveRun) {
    const status = runtime.status;
    const canContinue = status === "paused_wake" || status === "paused_user";
    const canRecover = status === "paused_error";
    const canEdit = status !== "paused_approval";
    return (
      <>
        {canRecover ? (
          <MissionErrorAlert stopReason={runtime.stopReason} />
        ) : null}
        <div
          data-vex-area="mission-controls"
          role="group"
          aria-label="Mission controls"
          className="mt-3 flex flex-wrap items-center gap-2"
        >
          <ControlButton
            label="Continue"
            disabled={disabled || !canContinue}
            onClick={() => void run(() => cont.mutateAsync({ sessionId }))}
          />
          <ControlButton
            label={recover.isPending ? "Recovering…" : "Recover"}
            ariaLabel="Recover mission"
            ariaBusy={recover.isPending}
            disabled={disabled || !canRecover}
            onClick={() => void run(() => recover.mutateAsync({ sessionId }))}
          />
          <ControlButton
            label="Edit"
            disabled={disabled || !canEdit}
            onClick={() => void run(() => edit.mutateAsync({ sessionId }))}
          />
          <ControlButton
            label="Stop"
            tone="danger"
            disabled={disabled}
            onClick={() => void run(() => stop.mutateAsync({ sessionId }))}
          />
          {notice !== null ? <ControlNoticeLine text={notice.text} /> : null}
        </div>
      </>
    );
  }

  // NO ACTIVE RUN → Start an accepted/ready draft; Start wins over Renew when
  // both could apply (a freshly accepted contract is the more immediate action).
  const diff = readReadyDiff(diffQuery.data);
  const canStart =
    draft !== null &&
    draft.status === "ready" &&
    diff !== null &&
    diff.isAccepted &&
    !diff.isDirty;
  // Contract pending acceptance (a draft exists that is not accepted-clean)
  // with no active run: the runtime prequote gate fail-closes EVERY on-chain
  // broadcast (reason `wallet_setup`), so surface that as a standing notice —
  // the user must see the block deterministically, not via a paraphrased (and
  // possibly confabulated) agent reply to a blocked tool call.
  const pendingAcceptance = draft !== null && !canStart;
  if (canStart) {
    const missionId = draft.missionId;
    return (
      <div data-vex-area="mission-controls" className="mt-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void run(() => start.mutateAsync({ sessionId, missionId }))
          }
          aria-label="Start mission"
          className={PRIMARY_KEY}
        >
          Start mission
        </button>
        {notice !== null ? <ControlNoticeLine text={notice.text} /> : null}
      </div>
    );
  }

  // Reviewable: a ready draft awaiting acceptance — the "MISSION READY" state.
  // Gated on the turn settling (never on the draft/diff data alone) so the
  // bar can't flash open mid-turn during a tool-call gap; a cancelled/failed
  // turn also settles `chatSubmitting` back to false, so a stuck turn can
  // never wedge the bar shut. When not yet settled (or not reviewable), fall
  // through to the pre-existing affordances below unchanged — the standing
  // notice already covers this state, so nothing regresses mid-turn.
  // `planMissing` is MissionRail's exported readiness gate: with plan-mode on
  // and no plan body, the rail says Preparing — the bar must agree, not lead.
  const reviewable =
    draft !== null && draft.status === "ready" && diff !== null && !diff.isAccepted &&
    planKnown && !planMissing(plan);
  if (reviewable && !chatSubmitting) {
    return (
      <div data-vex-area="mission-controls" className="mt-3">
        <button
          type="button"
          onClick={() => setReviewModal("mission")}
          aria-label="Review & accept contract"
          className={REVIEW_KEY}
        >
          Review &amp; accept contract
        </button>
      </div>
    );
  }

  // No startable draft, but a terminal accepted mission exists → Renew clones it
  // into a fresh draft (the new contract must still be accepted before it runs,
  // so this is non-destructive and needs no confirm step).
  const renewSource = readRenewable(renewableQuery.data);
  // `draft === null` guard mirrors MissionRail's load-bearing guard:
  // `getRenewableSourceForSession` keeps returning the OLD terminal accepted
  // mission even after `mission.renew` (or `edit`) inserts a fresh draft. Without
  // this guard the Renew button LINGERS once a fresh draft exists — so a renew
  // looks like it "does nothing", and each extra click clones ANOTHER duplicate
  // draft. Gating on `draft === null` lets the fresh draft fall through to the
  // acceptance-pending UI below (accept it, then Start).
  if (renewSource !== null && draft === null) {
    const previousMissionId = renewSource.missionId;
    // A terminal accepted mission has a finalized ledger row — lead with its
    // summary, at hero density, above the Renew key. This is the moment the
    // card exists for: the operator has just watched a run end and wants to
    // know what happened before deciding to run it again.
    const summary = readFinalizedResult(sessionResultQuery.data);
    return (
      <div data-vex-area="mission-controls" className="mt-3">
        {summary !== null && !dismissedRunIds.includes(summary.missionRunId) ? (
          <div className="mb-3">
            <MissionSummaryCard result={summary} density="hero" />
          </div>
        ) : null}
        {pendingAcceptance ? <AcceptancePendingNotice /> : null}
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            void run(
              () => renew.mutateAsync({ sessionId, previousMissionId }),
              renewNoticeFor,
            )
          }
          aria-label="Renew mission"
          className={PRIMARY_KEY}
        >
          Renew mission
        </button>
        {notice !== null ? <ControlNoticeLine text={notice.text} /> : null}
      </div>
    );
  }

  // Contract pending acceptance with nothing else to show → the standing
  // notice alone, so the block is visible for the whole setup phase.
  if (pendingAcceptance) {
    return (
      <div data-vex-area="mission-controls" className="mt-3">
        <AcceptancePendingNotice />
      </div>
    );
  }

  return null;
}

/**
 * Standing muted-warn notice while a mission session's contract is pending
 * acceptance: mirrors the runtime prequote gate's `wallet_setup` fail-close
 * (no active run → every swap/bridge/send broadcast is refused), so the block
 * is visible in the UI regardless of how the agent narrates it.
 */
function AcceptancePendingNotice(): JSX.Element {
  return (
    <p
      role="status"
      data-vex-state="acceptance-pending"
      className="mb-2 w-full text-xs text-warning"
    >
      Mission contract not accepted — on-chain actions (swaps, bridges, sends)
      are blocked until you accept the contract and start the mission.
    </p>
  );
}

/**
 * Standing paused_error alert (issue #42): while the recover-eligible pause
 * persists, the mission is silently NOT monitoring the market or positions —
 * that has to be visible, not inferred from an agent reply. Persistent,
 * state-driven UI: no timers, no dismissal. If a recovery settles and the
 * refetched runtime is still paused_error, this simply stays/reappears — the
 * visible-failure signal the operator needs.
 */
function MissionErrorAlert({
  stopReason,
}: {
  readonly stopReason: string | null;
}): JSX.Element {
  // `provider_error` names the stop reason, not the cause — it covers both
  // inference and runtime errors, so the copy must not claim a connection
  // failure. The state is recoverable via the Recover button, so never say
  // "unrecoverable".
  const body =
    stopReason === "provider_error"
      ? "The mission paused after an inference or runtime error."
      : "The mission paused after an unexpected error.";
  return (
    <div
      role="alert"
      data-vex-area="mission-error-alert"
      className="mb-2 w-full rounded-lg border border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 px-3 py-2"
    >
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.26em] text-destructive">
        Mission paused — error
      </p>
      <p className="mt-1 text-xs text-destructive">{body}</p>
      <p className="mt-1 text-xs text-destructive">
        The mission is not monitoring the market or your positions until you
        recover it.
      </p>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  disabled,
  tone,
  ariaLabel,
  ariaBusy,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled: boolean;
  readonly tone?: "danger";
  /** Overrides the derived `${label} mission` accessible name — used where
   * the visible label changes (e.g. "Recovering…") but the accessible name
   * must stay stable for assistive tech and tests. */
  readonly ariaLabel?: string;
  readonly ariaBusy?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel ?? `${label} mission`}
      aria-busy={ariaBusy}
      className={cn(
        // Toolbar keys: quiet mono-uppercase hairline pills; Stop keeps the
        // destructive tone with the one sanctioned danger fill (/10).
        "inline-flex h-8 items-center rounded-full border px-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:cursor-not-allowed disabled:opacity-40",
        tone === "danger"
          ? "border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)] bg-destructive/10 text-destructive hover:bg-destructive/15"
          : "border-[var(--vex-line-strong)] text-[var(--vex-text-2)] hover:bg-white/[0.06] hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function ControlNoticeLine({ text }: { readonly text: string }): JSX.Element {
  return (
    <p role="alert" className="w-full text-xs text-destructive">
      {text}
    </p>
  );
}
