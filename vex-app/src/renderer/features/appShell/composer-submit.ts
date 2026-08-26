/**
 * Composer chat-turn submit orchestration (extracted from
 * `SessionComposer.tsx` so the parent stays under the file-size budget).
 *
 * Owns: the notice state machine, the mission-run free-text gate, the
 * retryable-failure notice contract, the stop acknowledgment, the message
 * queue (a submit while a turn is in flight queues instead of dropping,
 * and the head auto-drains when the session goes idle - A27), and the
 * welcome→create hand-off that fires a freshly created session's first
 * turn, and the board's Ask VEX hand-off (A4) - which reaches the agent
 * through the SAME dispatch every typed message takes, so the board modal
 * needs no submit path of its own. The draft itself lives in the per-session draft store (B1). No JSX.
 * Stop-availability reading is split into `composer-submit/`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { ReasoningEffort } from "@shared/schemas/reasoning.js";
import { useIsChatSubmitting, useSubmitChat } from "../../lib/api/chat.js";
import { useRequestStop, useRuntimeState } from "../../lib/api/runtime.js";
import {
  draftKeyFor,
  readDraft,
  useComposerDraft,
  WELCOME_DRAFT_KEY,
  writeDraft,
} from "../../lib/composer-drafts.js";
import {
  enqueueMessage,
  takeQueuedMessage,
  useComposerQueue,
  type QueuedComposerMessage,
} from "../../lib/composer-queue.js";
import { showToast } from "../../lib/toast.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useBoardAskIntentStore } from "./Board/board-ask-intent.js";
import { readStopAvailability } from "./composer-submit/stop-availability.js";
import {
  STEERED_TOAST_TEXT,
  trySteerLiveTurn,
} from "./composer-submit/steering.js";
import {
  FREE_TEXT_DISALLOWED,
  gatedReason,
  readRunStatus,
  submitFailureNotice,
  submitSuccessText,
} from "./composer-helpers.js";

export type ComposerNotice =
  | {
      readonly tone: "info" | "error";
      readonly text: string;
      /**
       * Present only for a retryable provider error in a known agent session:
       * an inline Retry re-sends `message` into `sessionId`. Bound to the
       * session so switching sessions can never resend into the wrong one.
       * `reasoningEffort` is the exact value that rode the FAILED submit
       * (`null` = the field was omitted): Retry resends the same turn
       * verbatim, even if the selector moved since — a retry is not a new
       * choice.
       */
      readonly retry?: {
        readonly sessionId: string;
        readonly message: string;
        readonly reasoningEffort: ReasoningEffort | null;
      };
    }
  | null;

export interface ComposerSubmit {
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly clearNotice: () => void;
  readonly notice: ComposerNotice;
  readonly submitPending: boolean;
  readonly stopRequested: boolean;
  /**
   * Whether a Stop affordance should be offered at all.
   *
   * NOT the same as `submitPending`, and NOT derived from the lease. Autonomous
   * work alternates between lease-held slices and lease-less parks on a pending
   * wake, so `leaseActive` is a sawtooth: keying the control off it made the
   * Stop key vanish across every `loop_defer` while the agent was still running
   * and still stoppable. The authoritative answer is `stoppable`, computed in
   * main from ONE snapshot of every state the stop dispatcher acts on.
   *
   * The renderer adds exactly one thing on top: a conservative posture when it
   * does not KNOW. See `StopAvailability`.
   */
  readonly stopAvailable: boolean;
  readonly awaitingApproval: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRetry: () => void;
  readonly onStop: () => void;
  /** Queued rows for this session (A27); empty on the welcome composer. */
  readonly queue: readonly QueuedComposerMessage[];
  /** Whether a queued row can dispatch immediately (nothing in flight). */
  readonly sendNowAvailable: boolean;
  /** Dispatch one queued row now (the dock's send-now action). */
  readonly sendQueuedNow: (row: QueuedComposerMessage) => void;
}

/**
 * Bounded failure copy for a stop that did not land. No provider or IPC text —
 * the user needs to know the run is still going and that pressing again is the
 * right move, nothing else.
 */
const STOP_FAILED_NOTICE =
  "Couldn't stop the run. It's still going - try Stop again.";

/**
 * How long the disabled "Stopping…" acknowledgment may stand before the
 * control re-arms itself.
 *
 * Comfortably above the ~1 s stop target plus an IPC round-trip, and well below
 * the 60 s runtime-state fallback poll — so a dropped `controlState` event
 * cannot pin the badge on "Stopping…" while work is visibly continuing. That
 * indefinite pin is the same class of lie the `ok:false` recovery below was
 * added to kill.
 *
 * Deliberately NOT paired with a shorter `RUNTIME_STATE_FALLBACK_POLL_MS`: that
 * value's 8 s → 60 s change is documented push-first design, and shortening it
 * would trade a real regression for a symptom.
 */
const STOP_ACK_MAX_MS = 8_000;

/**
 * Shown when the acknowledgment times out. It must not claim the stop failed —
 * it may well land a moment later — and it must not claim it succeeded. The
 * honest statement is that the request is in and something uninterruptible is
 * still finishing, which is exactly the sign→broadcast→persist exemption.
 */
const STOP_ACK_TIMEOUT_NOTICE =
  "Stop was requested but the agent is still finishing a step it cannot safely interrupt.";

export function useComposerSubmit(
  sessionId: string | null,
  activeSession: SessionListItem | null,
  carryReasoningEffort: boolean,
  effectiveReasoningEffort: ReasoningEffort | null,
): ComposerSubmit {
  // Destructure stable members: `mutateAsync`/`stop` are referentially stable
  // (observer-bound + useCallback), so the hand-off effect below depends on
  // `submitTurn` instead of the per-render `useSubmitChat()` object — which
  // otherwise re-ran the effect every render.
  //
  // `isPending` is DELIBERATELY NOT read here. This composer is RESIDENT: one
  // hook instance serves every session, and the observer's boolean is
  // hook-wide. Reading it made a session the user merely switched TO look
  // pending - which routed its next send into steer/queue instead of a fresh
  // send, and pointed its Stop key at the other session's turn. Every pending
  // decision below reads the session-filtered mutation-cache answer instead.
  const { mutateAsync: submitTurn, stop: stopTurn } = useSubmitChat();
  const submitPending = useIsChatSubmitting(sessionId);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const createSessionInitialTurn = useUiStore((s) => s.createSessionInitialTurn);
  const clearCreateSessionInitialTurn = useUiStore(
    (s) => s.clearCreateSessionInitialTurn,
  );
  const setSessionReasoningEffort = useUiStore(
    (s) => s.setSessionReasoningEffort,
  );
  const askIntent = useBoardAskIntentStore((s) => s.intent);
  const consumeBoardAskIntent = useBoardAskIntentStore(
    (s) => s.consumeBoardAskIntent,
  );
  const clearBoardAskIntent = useBoardAskIntentStore(
    (s) => s.clearBoardAskIntent,
  );
  const runtimeQuery = useRuntimeState(sessionId);
  const requestStop = useRequestStop();
  const availability = readStopAvailability(
    sessionId,
    runtimeQuery.data,
    runtimeQuery.isError,
  );
  /**
   * The control is hidden ONLY on a known negative. Unknown fails toward
   * SHOWING Stop — see `StopAvailability`.
   */
  const stopKnownUnavailable = availability === "known-unavailable";
  const handedOffRef = useRef<string | null>(null);

  // Per-session draft (B1): the store keyed by session survives switching
  // sessions and coming back; the welcome composer uses the reserved key.
  const draftKey = draftKeyFor(sessionId);
  const [draft, setDraft] = useComposerDraft(draftKey);
  const queue = useComposerQueue(sessionId);
  const [notice, setNotice] = useState<ComposerNotice>(null);
  // Stop acknowledgment: first click on Stop cancels the turn AND flips the
  // key to a disabled "Stopping" state so the user sees the request landed.
  // stopTurn stays idempotent — this state is purely the acknowledgment.
  const [stopRequested, setStopRequested] = useState<boolean>(false);
  // Synchronous in-flight mutex (render `submitPending` lags a tick), KEYED BY
  // SESSION because this hook instance is resident across session switches: a
  // hook-wide boolean made session B inherit A's mutex and take the steer/queue
  // branch on its first send. Entries are added and removed by the submit that
  // owns them, so the set only ever holds sessions with a live foreground turn.
  const inFlightRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  // Clear the composer notice AND the stop acknowledgment when the active
  // session changes, so neither a stale error / Retry nor a "Stopping…" badge
  // from one session ever renders on (or acts in) another.
  useEffect(() => {
    setNotice(null);
    setStopRequested(false);
  }, [sessionId]);

  // Reset the stop acknowledgment when the work settles so the next turn
  // starts from a clean Stop key. Both signals matter: a pending submit
  // settling covers the foreground case, and `stoppable` going KNOWN-false
  // covers a background slice or a park — without the latter, stopping
  // autonomous work would leave the key stuck on the disabled "Stopping" state
  // forever, because no submit was ever pending to settle.
  //
  // Deliberately keyed on the KNOWN negative: an errored read is not evidence
  // that the work ended, and treating it as such would clear the badge while
  // the agent is still running.
  useEffect(() => {
    if (!submitPending && stopKnownUnavailable) setStopRequested(false);
  }, [submitPending, stopKnownUnavailable]);

  // Escape hatch for the acknowledgment that never settles.
  //
  // `stoppable` stays true while an uninterruptible leg finishes (the lease is
  // still heart-beating, the wake is still parked) — so the settle effect
  // above can wait indefinitely and the key stays disabled on "Stopping…"
  // while the run visibly continues. Time-box it: re-arm the control, say what
  // is actually happening, and let a second press re-fire the request (the
  // durable `stop_terminal` enqueue is idempotent, so it costs nothing).
  useEffect(() => {
    if (!stopRequested) return undefined;
    const timer = setTimeout(() => {
      setStopRequested(false);
      setNotice({ tone: "info", text: STOP_ACK_TIMEOUT_NOTICE });
    }, STOP_ACK_MAX_MS);
    return () => { clearTimeout(timer); };
  }, [stopRequested]);

  // Single owner of a chat-turn submit + its failure/success notice. A
  // retryable provider error in a KNOWN agent session arms an inline Retry
  // bound to that session; every other failure keeps the restore-draft
  // behavior. The in-flight ref is the real mutex (render state lags), and a
  // session switch mid-flight drops the now-stale outcome.
  const runChatSubmit = useCallback(
    async (
      message: string,
      reasoningOverride?: ReasoningEffort | null,
    ): Promise<void> => {
      const targetSessionId = sessionId;
      if (targetSessionId === null || inFlightRef.current.has(targetSessionId)) {
        return;
      }
      inFlightRef.current.add(targetSessionId);
      setNotice(null);
      // D5 submit contract: a non-null capability in an agent-stage session
      // ALWAYS carries the effective selection (untouched → the computed
      // preselect default; an explicit Off rides as "none" verbatim);
      // capability null → the field is OMITTED entirely — never a store
      // fallback. Retry passes the value that rode the original submit as
      // `reasoningOverride` (null = it was omitted), so a retry resends the
      // SAME turn even if the selector moved since.
      const carriedReasoningEffort =
        reasoningOverride !== undefined
          ? reasoningOverride
          : carryReasoningEffort
            ? effectiveReasoningEffort
            : null;
      try {
        const outcome = await submitTurn({
          sessionId: targetSessionId,
          message,
          ...(carriedReasoningEffort !== null && {
            reasoningEffort: carriedReasoningEffort,
          }),
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
              retry: {
                sessionId: targetSessionId,
                message,
                reasoningEffort: carriedReasoningEffort,
              },
            });
          } else {
            // No Retry → keep the message so it is not lost (restore into the
            // ORIGINAL session's draft slot, and only if the user has not
            // typed something new there since).
            setNotice({ tone: "error", text: outcome.error.message });
            const failedKey = draftKeyFor(targetSessionId);
            if (readDraft(failedKey).length === 0) {
              writeDraft(failedKey, message);
            }
          }
          return;
        }
        const failure = submitFailureNotice(outcome.data);
        if (failure !== null) {
          const armRetry =
            failure.retryable &&
            activeSession?.id === targetSessionId &&
            activeSession.mode === "agent";
          setNotice({
            tone: "error",
            text: failure.text,
            ...(armRetry && {
              retry: {
                sessionId: targetSessionId,
                message,
                reasoningEffort: carriedReasoningEffort,
              },
            }),
          });
          return;
        }
        const successText = submitSuccessText(outcome.data);
        if (successText !== null) setNotice({ tone: "info", text: successText });
      } finally {
        inFlightRef.current.delete(targetSessionId);
      }
    },
    [
      sessionId,
      submitTurn,
      activeSession,
      carryReasoningEffort,
      effectiveReasoningEffort,
    ],
  );

  const onRetry = useCallback((): void => {
    const r = notice?.retry;
    if (r === undefined || r.sessionId !== sessionId) return;
    void runChatSubmit(r.message, r.reasoningEffort);
  }, [notice, sessionId, runChatSubmit]);

  // Welcome→create hand-off: when this composer mounts for the freshly
  // created session, consume the turn stashed by the welcome Send press
  // (SNAPSHOTTED at press time — E3/D5; SessionCreator's
  // `completeSessionCreate` has already mode-gated it, e.g. null for a
  // mission create) and send it through the normal submit path so success/
  // failure reuse the same notice + draft-preserve UX (a failed first send
  // is visible, never lost). The snapshot rides as an EXPLICIT override —
  // never recomputed here — and, when non-null, seeds
  // `reasoningEffortBySession` so this session's later renders/switches
  // reflect it exactly like an in-session pick would. `handedOffRef` +
  // clear-before-submit make it consume-once (Strict Mode safe); the live
  // store clear avoids a stale-closure re-send.
  useEffect(() => {
    if (sessionId === null || createSessionInitialTurn === null) return;
    const key = `${sessionId}:${createSessionInitialTurn.message}`;
    if (handedOffRef.current === key) return;
    handedOffRef.current = key;
    const { message, reasoningEffort } = createSessionInitialTurn;
    clearCreateSessionInitialTurn();
    // The welcome draft seeded this turn - release it so returning to the
    // welcome stage later starts clean (cancelling the create keeps it).
    writeDraft(WELCOME_DRAFT_KEY, "");
    if (reasoningEffort !== null) {
      setSessionReasoningEffort(sessionId, reasoningEffort);
    }
    void runChatSubmit(message, reasoningEffort);
  }, [
    sessionId,
    createSessionInitialTurn,
    clearCreateSessionInitialTurn,
    setSessionReasoningEffort,
    runChatSubmit,
  ]);

  const runStatus = readRunStatus(runtimeQuery.data);
  const freeTextGate = runStatus !== null && FREE_TEXT_DISALLOWED.has(runStatus);
  // Approval echo — a mission run parked for approval reaches the composer as
  // `runStatus === "paused_approval"` (already in FREE_TEXT_DISALLOWED, so the
  // input is frozen). No new plumbing: this same signal recolors the pill's
  // traveling shimmer + border amber (via `data-vex-console-state`) and floats
  // the "AWAITING SIGNATURE" tag above the pill.
  const awaitingApproval = runStatus === "paused_approval";

  /**
   * THE ONE HIGH-LEVEL DISPATCH for a finished message in a known session.
   *
   * Everything a message must pass through before it can reach the agent
   * lives here and nowhere else: the in-flight mutex, the steering attempt
   * with the queue as its fallback, the mission free-text gate, and
   * `runChatSubmit`'s failure/retry contract. The composer's own Send calls
   * it, and so does the board's Ask VEX hand-off below - which is exactly why
   * that surface needs no submit path of its own (A4).
   *
   * The DRAFT is not this function's business. Its caller decides whether the
   * text came from the field and therefore whether the field should clear.
   */
  const dispatchMessage = useCallback(
    async (message: string): Promise<void> => {
      const target = sessionId;
      if (target === null || message.length === 0) return;
      // THE MISSION GATE IS FIRST AND IT IS UNCONDITIONAL. Free text is
      // refused while a mission run is active - mission controls live in the
      // MissionControls strip above, not in the composer - and steering or
      // queueing is still free text reaching that run. Ordering the gate
      // AFTER the in-flight branch left exactly one hole: a mission run with a
      // foreground turn in flight took a board Ask VEX hand-off as an
      // interrupt, because that surface enters here rather than through
      // `onSubmit`. A4 requires Ask VEX to obey the same rules as a typed
      // message, and the only way that holds for every caller is for the gate
      // to sit above every other branch.
      if (freeTextGate) {
        setNotice({ tone: "error", text: gatedReason(runStatus) });
        return;
      }
      // A submit while a turn is already in flight STEERS the live turn
      // (A33): the engine persists the message as an interrupt the loop
      // reads at its next tool-step boundary, and the transcript shows the
      // steered row. When steering is refused (turn just ended, parked run)
      // the message QUEUES instead (A27) - never dropped, never doubled.
      if (submitPending || inFlightRef.current.has(target)) {
        const steerOutcome = await trySteerLiveTurn(target, message);
        if (steerOutcome === "steered") {
          showToast(STEERED_TOAST_TEXT);
          return;
        }
        enqueueMessage(target, message);
        return;
      }
      await runChatSubmit(message);
    },
    [sessionId, submitPending, freeTextGate, runStatus, runChatSubmit],
  );

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      const message = draft.trim();
      if (message.length === 0) return;
      // Welcome state (no session yet): Send opens the new-session modal
      // seeded with this draft PLUS the reasoning effort SNAPSHOTTED right
      // now (E3/D5) — unresolved capability at this instant → null → a
      // definite omission; resolved+untouched → the computed default. The
      // create-handoff rides this exact value verbatim, never a later
      // recomputation. Draft is kept so cancelling the modal preserves what
      // the user typed (and the welcome-stage pick above survives too — it
      // is this SAME composer instance's local state).
      if (sessionId === null) {
        openCreateSession(message, effectiveReasoningEffort);
        return;
      }
      // The GATED case keeps the draft: a message refused by the mission gate
      // was never sent, so clearing the field would delete what the user
      // wrote. This branch is BUSY-INDEPENDENT and must stay so. The gate now
      // sits at the top of `dispatchMessage`, so a gated message is refused
      // whether or not a turn is in flight; a guard that still let the busy
      // case through would clear the field and then have the dispatch refuse
      // it, which deletes what the user typed. Every other branch is on its
      // way to the agent, so the field clears optimistically and
      // `runChatSubmit` owns restoring it on a failure that cannot retry.
      if (freeTextGate) {
        setNotice({ tone: "error", text: gatedReason(runStatus) });
        return;
      }
      setDraft("");
      await dispatchMessage(message);
    },
    [
      sessionId,
      draft,
      effectiveReasoningEffort,
      freeTextGate,
      openCreateSession,
      runStatus,
      setDraft,
      dispatchMessage,
    ],
  );

  // BOARD ASK VEX HAND-OFF (A4). A board surface parks a finished question -
  // context envelope and all - and this composer, the resident one, dispatches
  // it through `dispatchMessage` above. Three properties the panel could not
  // give itself:
  //
  //  - SESSION-KEYED: an intent for another session is DROPPED here rather
  //    than sent, so a question about session A's board can never land in
  //    session B's transcript because the reader switched while it was open;
  //  - CONSUME-ONCE: the store clears the slot in the same step it hands the
  //    intent over, keyed by `intentId`, so StrictMode's double-invoked effect
  //    finds nothing on its second pass;
  //  - the SAME RULES as a typed message: mutex, mission gate, steering,
  //    queue and retry, because it is the same dispatch.
  useEffect(() => {
    if (askIntent === null) return;
    if (sessionId === null || askIntent.sessionId !== sessionId) {
      clearBoardAskIntent();
      return;
    }
    const taken = consumeBoardAskIntent(askIntent.intentId, sessionId);
    if (taken === null) return;
    void dispatchMessage(taken.message);
  }, [
    askIntent,
    sessionId,
    clearBoardAskIntent,
    consumeBoardAskIntent,
    dispatchMessage,
  ]);

  const sendNowAvailable = !submitPending && !freeTextGate && !stopRequested;

  // Queue drain (A27): when the session is idle again and rows are waiting,
  // dispatch the HEAD through the normal submit path. One row per settle -
  // the effect re-runs when `submitPending` flips back, so a multi-row queue
  // drains turn by turn, and a row removed meanwhile is never sent
  // (`takeQueuedMessage` re-reads the live store).
  useEffect(() => {
    if (sessionId === null || !sendNowAvailable || queue.length === 0) return;
    if (inFlightRef.current.has(sessionId)) return;
    const row = takeQueuedMessage(sessionId);
    if (row !== null) void runChatSubmit(row.text);
  }, [sessionId, sendNowAvailable, queue, runChatSubmit]);

  const sendQueuedNow = useCallback(
    (row: QueuedComposerMessage): void => {
      if (sessionId === null || !sendNowAvailable) return;
      const taken = takeQueuedMessage(sessionId, row.id);
      if (taken !== null) void runChatSubmit(taken.text);
    },
    [sessionId, sendNowAvailable, runChatSubmit],
  );

  const clearNotice = useCallback((): void => setNotice(null), []);
  /**
   * ONE route per case — never both.
   *
   * FOREGROUND (`submitPending`): the request-local `stopTurn()` only. This
   * window owns the in-flight request and `processAgentTurn` observes that
   * AbortSignal directly, so the abort is immediate and complete. Firing the
   * durable route as well would INSERT a `stop_terminal` control row that no
   * consumer on the foreground path ever observes — it outlives the turn it
   * was meant for and is later applied to an unrelated approval resume or
   * continuation, stopping something the user never asked to stop.
   *
   * BACKGROUND (stoppable, no pending submit — a live slice, a `loop_defer`
   * park, or an unknown state we fail open on): the durable
   * `runtime.requestStop` only. `stopTurn()` has nothing to cancel here — the
   * work belongs to a wake-driven continuation this window never started — and
   * the durable row is exactly what that path's consumer observes. It is also
   * the correct route when availability is UNKNOWN: the engine decides what, if
   * anything, there is to stop, and answers honestly (`no_active_run`) when
   * there is nothing.
   *
   * The split is the point: each route is the one the running work actually
   * listens to, and neither leaves a row behind for work that is not running.
   */
  const onStop = useCallback((): void => {
    // The session this press belongs to, captured BEFORE anything async. A
    // Stop must only ever cancel the session it was pressed in, and its late
    // outcome must only ever publish into that session.
    const targetSessionId = sessionId;
    setStopRequested(true);
    if (submitPending) {
      // `submitPending` is session-filtered, so a non-null target is implied;
      // the check is the compiler's, not a new policy.
      if (targetSessionId !== null) stopTurn(targetSessionId);
      return;
    }
    if (targetSessionId === null || targetSessionId.length === 0) return;
    void (async () => {
      const publishFailure = (): void => {
        // Generation fence, same rule as the chat-completion path above: the
        // composer may already be showing another session by now, and a
        // failure from THIS one must not put a "Stop failed" notice or a
        // "Stopping…" badge on it.
        if (sessionIdRef.current !== targetSessionId) return;
        setStopRequested(false);
        setNotice({ tone: "error", text: STOP_FAILED_NOTICE });
      };
      try {
        const result = await requestStop.mutateAsync({
          sessionId: targetSessionId,
        });
        // The mutation RESOLVES on an application-level failure — the Result
        // envelope carries it. Ignoring `ok:false` left the key disabled on
        // "Stopping…" while the agent kept running, which reads as a
        // successful stop and is the worst possible lie on this control.
        if (!result.ok) publishFailure();
      } catch {
        // Transport-level failure — same recovery: give the user a Stop key
        // that works again rather than a dead one.
        publishFailure();
      }
    })();
  }, [stopTurn, requestStop, sessionId, submitPending]);

  return {
    draft,
    setDraft,
    clearNotice,
    notice,
    submitPending,
    stopRequested,
    stopAvailable: submitPending || !stopKnownUnavailable,
    awaitingApproval,
    onSubmit,
    onRetry,
    onStop,
    queue,
    sendNowAvailable,
    sendQueuedNow,
  };
}

