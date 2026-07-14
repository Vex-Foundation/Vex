/**
 * Session composer — THE SIGNAL CONSOLE, a single floating pill bar.
 *
 * ONE translucent glass pill (rounded-full at rest, corners relaxing as the
 * field grows) floating over the Signal Sky — the two-layer card + context
 * strip were retired. Left→right inside the pill:
 *   - the transparent-bg textarea (auto-grow) opens the pill with a clean
 *     left inset — no "+" toggle, no attach, no mic. Its DEFAULT welcome/agent
 *     placeholder rotates through crypto orders (`usePlaceholderRotator`);
 *     starter chips render detached below whenever an empty conversation has
 *     starters,
 *   - the right cluster: PLAN chip + REASON chip (quiet rounded-full ghost
 *     chips sharing the send control's height; PLAN is the single control
 *     point for session-scoped plan mode, `SessionPlanCard` displays) then the
 *     round accent send/stop/stopping control. The row is `items-center`, so
 *     the resting single-line state reads perfectly level.
 * Owns: mission-run-status gating on free-text submit; the composer notice
 * (success / error / inline Retry on a retryable error); the stage presence
 * (a taller idle field + larger type when the parent passes `stage`).
 *
 * The pill's glass surface + backdrop-blur are the owner-sanctioned third
 * glass surface (see shell-design-guard whitelist). The 1px border, the
 * TRAVELING accent shimmer that circles the ring, the focus step to
 * `--vex-glass-strong`, the soft drop shadow and the amber approval recolor
 * all live in `.vex-console` (globals.css) — token-only, so both themes
 * recolor from `--vex-accent`. The context strip is gone, so the two
 * transient states it carried survive as a tiny tag FLOATING above the pill:
 * amber "AWAITING SIGNATURE" while a run is parked for approval, muted
 * "Stopping…" while a stop settles (they cannot co-occur).
 *
 * Pure helpers: gating reasons + placeholders in `composer-helpers.ts`.
 * Mission controls (start/continue/recover/stop/edit/renew) are buttons in
 * `MissionControls.tsx`, mounted by the parent — this file owns only the
 * chat-turn submit + its notice, never command parsing.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, StopCircleIcon } from "@hugeicons/core-free-icons";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { useSubmitChat } from "../../lib/api/chat.js";
import {
  flattenTranscriptPages,
  useTranscriptInfinite,
} from "../../lib/api/messages.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import {
  useSessionModel,
  useSessionPlan,
  useSetPlanMode,
} from "../../lib/api/sessions.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";
import {
  FREE_TEXT_DISALLOWED,
  gatedReason,
  placeholderFor,
  readRunStatus,
  submitSuccessText,
} from "./composer-helpers.js";
import { ComposerQuickActions } from "./ComposerQuickActions.js";
import { usePlaceholderRotator } from "./composer-placeholders.js";
import { PlanSwitch } from "./PlanSwitch.js";
import { nextReasoningEffort, ReasoningSwitch } from "./ReasoningSwitch.js";
import { HypervexingSummon } from "./workspace/HypervexingSummon.js";

/**
 * Shared geometry for the round send control's three states (send / stop /
 * stopping) — one fixed circle so every hard-cut swap holds its slot in the
 * input row. Send fills the accent with the accent-contrast glyph; the
 * disabled (empty) send is a ghost hairline circle; stop keeps the accent rim;
 * stopping goes inert while the floating tag above the pill carries the
 * "Stopping…" label.
 */
const SEND_KEY_BASE =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background";

type ComposerNotice =
  | {
      readonly tone: "info" | "error";
      readonly text: string;
      /**
       * Present only for a retryable provider error in a known agent session:
       * an inline Retry re-sends `message` into `sessionId`. Bound to the
       * session so switching sessions can never resend into the wrong one.
       */
      readonly retry?: { readonly sessionId: string; readonly message: string };
    }
  | null;

export interface SessionComposerProps {
  readonly activeSession: SessionListItem | null;
  readonly activeSessionId: string | null;
  /**
   * Welcome/idle stage presence — presentation only. The parent
   * (`SessionPanel`) sets it for the Signal Sky stage: taller idle
   * textarea, 16px type, and a near-opaque ink frame (solid color-mix, NO
   * blur) so the instrument reads over the sky. The state machine, roles
   * and gating are identical in both variants.
   */
  readonly stage?: boolean;
}

export function SessionComposer({
  activeSession,
  activeSessionId,
  stage = false,
}: SessionComposerProps): JSX.Element {
  // Submit/enable gate on the canonical selected id (uiStore), NOT the
  // detail-query object: the engine ingress loads its own session context,
  // so a turn can be sent the moment a session is active — even while the
  // `sessions.get` detail query is still loading or errored (this was the
  // "send button permanently disabled" bug). `activeSession` stays for
  // soft, detail-derived UI only (placeholder, quick-action visibility).
  const sessionId = activeSessionId;
  // Destructure stable members: `mutateAsync`/`stop` are referentially stable
  // (observer-bound + useCallback), so the hand-off effect below depends on
  // `submitTurn` instead of the per-render `useSubmitChat()` object — which
  // otherwise re-ran the effect every render.
  const {
    isPending: submitPending,
    mutateAsync: submitTurn,
    stop: stopTurn,
  } = useSubmitChat();
  const workspaceMode = useUiStore((s) => s.workspaceMode);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const pendingFirstMessage = useUiStore((s) => s.pendingFirstMessage);
  const clearPendingFirstMessage = useUiStore((s) => s.clearPendingFirstMessage);
  const setSessionReasoningEffort = useUiStore(
    (s) => s.setSessionReasoningEffort,
  );
  // Per-session reasoning-effort choice (S6) — launch-ephemeral; absent key
  // means the engine default "medium". Selector returns a primitive, so the
  // subscription stays referentially stable.
  const reasoningEffort = useUiStore((s) =>
    sessionId === null
      ? "medium"
      : (s.reasoningEffortBySession[sessionId] ?? "medium"),
  );
  const handedOffRef = useRef<string | null>(null);
  const runtimeQuery = useRuntimeState(sessionId);
  // Reasoning capability (S6) — same cached query the runtime bar reads
  // (`sessions.getModel`, shared key, no extra fetch). The REASON control
  // mounts ONLY for an explicit `supportsReasoning === true`; `false`,
  // `null` (unknown: locked vault, catalog unreachable) and the welcome
  // state all hide it, and the submit input then omits the field so
  // non-reasoning models keep their exact request shape. Declared ABOVE
  // `runChatSubmit`, which closes over `supportsReasoning`.
  const modelQuery = useSessionModel(sessionId);
  const supportsReasoning =
    modelQuery.data?.ok === true &&
    modelQuery.data.data.supportsReasoning === true;
  const cycleReasoningEffort = useCallback((): void => {
    if (sessionId === null) return;
    setSessionReasoningEffort(sessionId, nextReasoningEffort(reasoningEffort));
  }, [sessionId, setSessionReasoningEffort, reasoningEffort]);

  const [draft, setDraft] = useState<string>("");
  const [notice, setNotice] = useState<ComposerNotice>(null);
  // Stop acknowledgment: first click on Stop cancels the turn AND flips the
  // key to a disabled "Stopping" state so the user sees the request landed.
  // stopTurn stays idempotent — this state is purely the acknowledgment.
  const [stopRequested, setStopRequested] = useState<boolean>(false);
  // Focus flag for the placeholder rotator: the rotating welcome placeholder
  // freezes on its current phrase while the field is focused or holds a draft,
  // so it never shuffles under an operator mid-thought.
  const [focused, setFocused] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Synchronous in-flight mutex (render `submitPending` lags a tick) + a mirror
  // of the latest active session so a submit that settles after a session
  // switch is dropped instead of painting a notice on the wrong session.
  const inFlightRef = useRef(false);
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  useLayoutEffect((): void => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  // Clear the composer notice when the active session changes so a stale
  // error / Retry from one session never renders on (or resends into) another.
  useEffect(() => {
    setNotice(null);
  }, [sessionId]);

  // Reset the stop acknowledgment when the turn settles (success, error, or
  // the retry path re-arming) so the next turn starts from a clean Stop key.
  useEffect(() => {
    if (!submitPending) setStopRequested(false);
  }, [submitPending]);

  // Single owner of a chat-turn submit + its failure/success notice. A
  // retryable provider error in a KNOWN agent session arms an inline Retry
  // bound to that session; every other failure keeps the restore-draft
  // behavior. The in-flight ref is the real mutex (render state lags), and a
  // session switch mid-flight drops the now-stale outcome.
  const runChatSubmit = useCallback(
    async (message: string): Promise<void> => {
      const targetSessionId = sessionId;
      if (targetSessionId === null || inFlightRef.current) return;
      inFlightRef.current = true;
      setNotice(null);
      try {
        // `reasoningEffort` rides along ONLY when the active model supports
        // reasoning (schema-optional) — omitted, the engine applies its own
        // default and never sends a reasoning param to non-reasoning models.
        const outcome = await submitTurn({
          sessionId: targetSessionId,
          message,
          ...(supportsReasoning && { reasoningEffort }),
        });
        if (sessionIdRef.current !== targetSessionId) return;
        if (!outcome.ok) {
          const armRetry =
            activeSession?.id === targetSessionId &&
            activeSession?.mode === "agent" &&
            outcome.error.retryable;
          if (armRetry) {
            setNotice({
              tone: "error",
              text: outcome.error.message,
              retry: { sessionId: targetSessionId, message },
            });
          } else {
            // No Retry → keep the message so it is not lost (restore only if the
            // user has not typed something new into the now-empty input).
            setNotice({ tone: "error", text: outcome.error.message });
            setDraft((cur) => (cur.length === 0 ? message : cur));
          }
          return;
        }
        const successText = submitSuccessText(outcome.data);
        if (successText !== null) setNotice({ tone: "info", text: successText });
      } finally {
        inFlightRef.current = false;
      }
    },
    [sessionId, submitTurn, activeSession, supportsReasoning, reasoningEffort],
  );

  const handleRetry = useCallback(async (): Promise<void> => {
    const r = notice?.retry;
    if (r === undefined || r.sessionId !== sessionId) return;
    await runChatSubmit(r.message);
  }, [notice, sessionId, runChatSubmit]);

  // Welcome→create hand-off: when this composer mounts for the freshly
  // created session, consume the first message stashed by SessionCreator and
  // send it through the normal submit path so success/failure reuse the same
  // notice + draft-preserve UX (a failed first send is visible, never lost).
  // `handedOffRef` + clear-before-submit make it consume-once (Strict Mode
  // safe); the live store clear avoids a stale-closure re-send.
  useEffect(() => {
    if (
      sessionId === null ||
      pendingFirstMessage === null ||
      pendingFirstMessage.sessionId !== sessionId
    ) {
      return;
    }
    const key = `${pendingFirstMessage.sessionId}:${pendingFirstMessage.message}`;
    if (handedOffRef.current === key) return;
    handedOffRef.current = key;
    const message = pendingFirstMessage.message;
    clearPendingFirstMessage();
    void runChatSubmit(message);
  }, [sessionId, pendingFirstMessage, clearPendingFirstMessage, runChatSubmit]);

  const runStatus = readRunStatus(runtimeQuery.data);
  const freeTextGate = runStatus !== null && FREE_TEXT_DISALLOWED.has(runStatus);

  // The summoning word in the draft, outside the mode — drives the ripple
  // veil, the gradient text paint, and the spellcheck suppression together.
  const summonActive =
    workspaceMode !== "hypervexing" && /hypervexing/i.test(draft);

  // Plan mode — same engine-owned, session-scoped state SessionPlanCard
  // displays (same query key, no extra fetch). The PLAN switch is the single
  // control point; no optimistic write, so a server refusal snaps back on
  // the invalidate-driven refetch.
  const planQuery = useSessionPlan(sessionId);
  const setPlanMode = useSetPlanMode();
  const plan = planQuery.data?.ok === true ? planQuery.data.data : null;
  const planOn = plan?.enabled ?? false;
  // Parked-for-acceptance is the state where the engine refuses a toggle
  // (`blocked_pending_acceptance`) — disable up front instead of bouncing.
  const planMissionBlocked =
    activeSession?.missionStatus === "paused_plan_acceptance";
  const { mutate: mutatePlanMode } = setPlanMode;
  const togglePlanMode = useCallback((): void => {
    if (sessionId === null) return;
    mutatePlanMode({ sessionId, enabled: !planOn });
  }, [sessionId, mutatePlanMode, planOn]);

  // Quick-action chips are starters for an EMPTY conversation. Show them on the
  // welcome screen and in a freshly created, still-empty session; hide them
  // once the session has any messages (reuses the transcript query already
  // mounted by SessionTranscript — same cache key, no extra fetch). Gated on
  // a resolved `activeSession` + a SUCCEEDED transcript query so a loading or
  // errored session never flickers the chips in or out.
  const transcriptQuery = useTranscriptInfinite(sessionId ?? "");
  const transcriptPages = transcriptQuery.data?.pages;
  const transcriptEmpty = useMemo(
    () =>
      transcriptPages === undefined
        ? true
        : flattenTranscriptPages(transcriptPages).length === 0,
    [transcriptPages],
  );
  const showQuickActions =
    sessionId === null ||
    (activeSession !== null &&
      activeSession.mode !== "mission" &&
      transcriptQuery.isSuccess &&
      transcriptEmpty);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      const message = draft.trim();
      if (message.length === 0) return;
      // Welcome state (no session yet): Send opens the new-session modal
      // seeded with this draft; the created session's composer then sends it
      // as the first turn (hand-off effect above). Draft is kept so cancelling
      // the modal preserves what the user typed.
      if (sessionId === null) {
        openCreateSession(message);
        return;
      }
      // Enter can fire a submit even while a turn is in flight (requestSubmit()
      // ignores the disabled Send button), so gate here.
      if (submitPending) return;
      // Free text is gated while a mission run is active — mission controls
      // live in the MissionControls strip above, not in the composer.
      if (freeTextGate) {
        setNotice({ tone: "error", text: gatedReason(runStatus) });
        return;
      }
      // Clear optimistically — the message is on its way to the agent and the
      // transcript already shows it. runChatSubmit owns failure handling
      // (retryable → inline Retry; otherwise restore the draft).
      setDraft("");
      await runChatSubmit(message);
    },
    [
      sessionId,
      draft,
      freeTextGate,
      openCreateSession,
      runStatus,
      submitPending,
      runChatSubmit,
    ],
  );

  const applyQuickAction = useCallback((prompt: string): void => {
    setDraft(prompt);
    setNotice(null);
  }, []);

  const draftEmpty = draft.trim().length === 0;
  const submitDisabled = draftEmpty || submitPending;
  // Stop acknowledged and the turn still in flight — the send key goes
  // inert and the chrome-row hint swaps to the STOPPING… label.
  const stopping = submitPending && stopRequested;

  // Approval echo — a mission run parked for approval reaches the composer as
  // `runStatus === "paused_approval"` (already in FREE_TEXT_DISALLOWED, so the
  // input is frozen). No new plumbing: this same signal recolors the pill's
  // traveling shimmer + border amber (via `data-vex-console-state`) and floats
  // the "AWAITING SIGNATURE" tag above the pill.
  const awaitingApproval = runStatus === "paused_approval";
  // Mission-mode placeholders stay owned by `placeholderFor`; the welcome /
  // agent default is the rotating crypto-utility set (`usePlaceholderRotator`).
  // Pause the rotator whenever a non-rotating override is visible so returning
  // from PLAN/mission copy does not immediately jump to a hidden background tick.
  const rotatorPaused =
    focused || draft.length > 0 || planOn || activeSession?.mode === "mission";
  const welcomePlaceholder = usePlaceholderRotator(rotatorPaused);
  const placeholder = planOn
    ? "Describe the goal — Vex proposes a plan before anything executes."
    : activeSession?.mode === "mission"
      ? placeholderFor(activeSession)
      : welcomePlaceholder;

  return (
    <>
      <div className="relative mt-6">
        {/* TRANSIENT SIGNAL TAG — floats above the pill's right side, carrying
         * the two states the retired context strip held (they cannot co-occur:
         * an approval pause freezes free-text submit, so nothing is in flight).
         * amber "AWAITING SIGNATURE" while parked for a signature; muted
         * "Stopping…" while a stop settles. Sibling of the form so the pill's
         * rounded surface never owns this floating status layer. */}
        {awaitingApproval ? (
          <span
            data-vex-console-status="approval"
            className="absolute -top-2.5 right-6 z-20 rounded-full border border-[var(--vex-pin-border)] bg-[var(--vex-surface-1)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--vex-pin)]"
          >
            AWAITING SIGNATURE
          </span>
        ) : stopping ? (
          // Exact "Stopping…" text — the stop-acknowledgment contract pinned by
          // the composer stop test (source casing stays).
          <span
            data-vex-console-status="stopping"
            className="absolute -top-2.5 right-6 z-20 rounded-full border border-[var(--vex-line-strong)] bg-[var(--vex-surface-1)] px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--vex-text-2)]"
          >
            Stopping…
          </span>
        ) : null}

        <form
          ref={formRef}
          onSubmit={onSubmit}
          data-vex-area="chat-composer"
          data-vex-console-state={awaitingApproval ? "approval" : "input"}
          className={cn(
            // THE SIGNAL CONSOLE PILL — one translucent glass row floating over
            // the Signal Sky. The glass surface + backdrop-blur are the
            // owner-sanctioned THIRD glass surface (shell-design-guard
            // whitelist). The 1px border, the TRAVELING accent shimmer that
            // circles the ring, the focus step to --vex-glass-strong, the soft
            // drop shadow and the amber approval recolor are owned by
            // `.vex-console` (globals.css) so no resting-glow shadow lands in a
            // className. rounded-[24px] reads as a full pill at the resting
            // single-line height and relaxes as the field grows multiline.
            // `items-center`: the chips + round send share the field's height,
            // so the resting single-line row reads perfectly level (a tall
            // multiline field centers the cluster — the deliberate trade-off).
            "vex-console relative flex items-center gap-1.5 overflow-visible rounded-[24px] bg-[var(--vex-glass)] p-1.5 backdrop-blur-xl",
          )}
        >
          {/* The summoning ritual: typing "hypervexing" ripples the pill in
           * the protocol's mint before the message is even sent. Only outside
           * the mode — inside, the room itself is the acknowledgment. */}
          <HypervexingSummon active={summonActive} />
          <textarea
              ref={textareaRef}
              value={draft}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice(null);
              }}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter and IME composition insert a newline.
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              rows={1}
              placeholder={placeholder}
              aria-label="Session draft"
              // The summoning word is real vocabulary here, not a typo — the
              // spellchecker's red squiggle would deface the ritual.
              spellCheck={!summonActive}
              className={cn(
                "block w-full flex-1 resize-none overflow-y-auto bg-transparent leading-[1.6] text-foreground caret-[var(--vex-accent)] outline-none",
                "max-h-[200px] py-1.5 pr-1 placeholder:text-[var(--vex-text-3)]",
                // Left inset: the pill's own breathing room now the "+" is
                // retired, so the order text is not jammed on the rounded edge.
                "pl-5",
                // Stage: taller idle presence + larger type (the instrument).
                stage ? "min-h-[44px] text-[16px]" : "min-h-[36px] text-[15px]",
                // The invocation glows: draft text paints as a drifting
                // mint→teal gradient while the summoning word is present.
                summonActive && "hv-summon-input",
              )}
            />

          {/* RIGHT CLUSTER — PLAN + REASON quiet rounded-full chips and the
           * round send control, all sharing one height (h-9) and vertically
           * centered against the field so the control bank reads level at rest. */}
          <div className="flex shrink-0 items-center gap-1.5">
              {/* In the Hypervexing room the copilot is plain chat by decree —
               * the Chat/Plan selector hides; plan/mission control stays a
               * normal-desk affordance. */}
              {workspaceMode !== "hypervexing" ? (
                <PlanSwitch
                  sessionId={sessionId}
                  planOn={planOn}
                  busy={setPlanMode.isPending}
                  missionBlocked={planMissionBlocked}
                  onToggle={togglePlanMode}
                />
              ) : null}

              {/* REASON control (S6) — only when the active model supports
               * reasoning; welcome (no session) hides it (capability unknown). */}
              {sessionId !== null && supportsReasoning ? (
                <ReasoningSwitch
                  effort={reasoningEffort}
                  busy={submitPending}
                  onCycle={cycleReasoningEffort}
                />
              ) : null}

              {/* THE SEND CONTROL — three hard-cut states in one round slot. */}
              {submitPending ? (
                stopRequested ? (
                  <button
                    type="button"
                    disabled
                    aria-label="Stopping"
                    className={cn(
                      SEND_KEY_BASE,
                      "border-[var(--vex-line-strong)] bg-[var(--vex-surface-0)] text-[var(--vex-text-3)]",
                    )}
                  >
                    <HugeiconsIcon icon={StopCircleIcon} size={16} aria-hidden />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setStopRequested(true);
                      stopTurn();
                    }}
                    aria-label="Stop generating"
                    className={cn(
                      SEND_KEY_BASE,
                      "border-[var(--vex-accent-border-strong)] bg-[var(--vex-accent-fill-12)] text-[var(--vex-accent-text)]",
                    )}
                  >
                    <HugeiconsIcon icon={StopCircleIcon} size={16} aria-hidden />
                  </button>
                )
              ) : (
                <button
                  type="submit"
                  disabled={submitDisabled}
                  aria-label="Send message"
                  className={cn(
                    SEND_KEY_BASE,
                    // Ghost hairline circle while the field is empty; solid
                    // accent fill with the accent-contrast glyph once there is
                    // an order to send.
                    submitDisabled
                      ? "border-[var(--vex-line-strong)] bg-transparent text-[var(--vex-text-3)]"
                      : "border-transparent bg-[var(--vex-accent)] text-[var(--vex-accent-contrast)] hover:bg-[var(--vex-accent-hover)] active:scale-[0.96]",
                  )}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} size={16} aria-hidden />
                </button>
              )}
          </div>
        </form>
      </div>

      {notice !== null ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className="mt-3 flex items-center gap-2 text-xs"
        >
          <span
            className={
              notice.tone === "error"
                ? "text-destructive"
                : "text-[var(--vex-accent-text)]"
            }
          >
            {notice.text}
          </span>
          {notice.retry !== undefined ? (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={submitPending}
              aria-label="Retry sending the message"
              className="inline-flex shrink-0 items-center rounded-[3px] border border-[color-mix(in_oklab,var(--vex-accent)_40%,transparent)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-accent-text)] transition-colors hover:bg-[var(--vex-accent-fill-8)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:cursor-not-allowed disabled:border-[var(--vex-line-strong)] disabled:text-[var(--vex-text-3)]"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {showQuickActions ? (
        <ComposerQuickActions onPick={applyQuickAction} />
      ) : null}
    </>
  );
}
