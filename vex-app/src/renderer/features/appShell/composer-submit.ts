/**
 * Composer chat-turn submit orchestration (extracted from
 * `SessionComposer.tsx` so the parent stays under the file-size budget).
 *
 * Owns: the draft + notice state machine, the mission-run free-text gate,
 * the retryable-failure notice contract, the stop acknowledgment, and the
 * welcome→create hand-off that fires a freshly created session's first
 * turn. No JSX — this hook is the composer's submit "why"; the parent only
 * renders the "what" and never re-derives any of this state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { ReasoningEffort } from "@shared/schemas/reasoning.js";
import { useSubmitChat } from "../../lib/api/chat.js";
import { useRequestStop, useRuntimeState } from "../../lib/api/runtime.js";
import { useUiStore } from "../../stores/uiStore.js";
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
   * NOT the same as `submitPending`. A wake-driven background slice holds the
   * session lease with no pending submit in this window, and while the control
   * keyed off `submitPending` alone that run had NO stop affordance anywhere in
   * the UI — the user could see the agent working and had no way to interrupt
   * it. The lease is the honest signal for "something is running in this
   * session", and it is already pushed to us on every committed transition.
   */
  readonly stopAvailable: boolean;
  readonly awaitingApproval: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRetry: () => void;
  readonly onStop: () => void;
}

/**
 * Bounded failure copy for a stop that did not land. No provider or IPC text —
 * the user needs to know the run is still going and that pressing again is the
 * right move, nothing else.
 */
const STOP_FAILED_NOTICE =
  "Couldn't stop the run. It's still going — try Stop again.";

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
  const {
    isPending: submitPending,
    mutateAsync: submitTurn,
    stop: stopTurn,
  } = useSubmitChat();
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const createSessionInitialTurn = useUiStore((s) => s.createSessionInitialTurn);
  const clearCreateSessionInitialTurn = useUiStore(
    (s) => s.clearCreateSessionInitialTurn,
  );
  const setSessionReasoningEffort = useUiStore(
    (s) => s.setSessionReasoningEffort,
  );
  const runtimeQuery = useRuntimeState(sessionId);
  const requestStop = useRequestStop();
  // "Something is running in this session RIGHT NOW", from the lease rather
  // than from a pending submit. Covers a wake-driven background slice, which
  // holds the lease with no submit pending in this window. A failed/loading
  // read reads as not-live so the control cannot flicker on a transient error.
  const sliceLive =
    runtimeQuery.data?.ok === true && runtimeQuery.data.data.leaseActive;
  const handedOffRef = useRef<string | null>(null);

  const [draft, setDraft] = useState<string>("");
  const [notice, setNotice] = useState<ComposerNotice>(null);
  // Stop acknowledgment: first click on Stop cancels the turn AND flips the
  // key to a disabled "Stopping" state so the user sees the request landed.
  // stopTurn stays idempotent — this state is purely the acknowledgment.
  const [stopRequested, setStopRequested] = useState<boolean>(false);
  // Synchronous in-flight mutex (render `submitPending` lags a tick) + a mirror
  // of the latest active session so a submit that settles after a session
  // switch is dropped instead of painting a notice on the wrong session.
  const inFlightRef = useRef(false);
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  // Clear the composer notice when the active session changes so a stale
  // error / Retry from one session never renders on (or resends into) another.
  useEffect(() => {
    setNotice(null);
  }, [sessionId]);

  // Reset the stop acknowledgment when the work settles so the next turn
  // starts from a clean Stop key. Both signals matter: a pending submit
  // settling covers the foreground case, and the lease dropping covers a
  // background slice — without the latter, stopping a background slice would
  // leave the key stuck on the disabled "Stopping" state forever, because no
  // submit was ever pending to settle.
  useEffect(() => {
    if (!submitPending && !sliceLive) setStopRequested(false);
  }, [submitPending, sliceLive]);

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
      if (targetSessionId === null || inFlightRef.current) return;
      inFlightRef.current = true;
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
            // No Retry → keep the message so it is not lost (restore only if the
            // user has not typed something new into the now-empty input).
            setNotice({ tone: "error", text: outcome.error.message });
            setDraft((cur) => (cur.length === 0 ? message : cur));
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
        inFlightRef.current = false;
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
      effectiveReasoningEffort,
      freeTextGate,
      openCreateSession,
      runStatus,
      submitPending,
      runChatSubmit,
    ],
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
   * BACKGROUND (lease held, no pending submit): the durable
   * `runtime.requestStop` only. `stopTurn()` has nothing to cancel here — the
   * slice belongs to a wake-driven continuation this window never started —
   * and the durable row is exactly what that path's consumer observes.
   *
   * The split is the point: each route is the one the running work actually
   * listens to, and neither leaves a row behind for work that is not running.
   */
  const onStop = useCallback((): void => {
    setStopRequested(true);
    if (submitPending) {
      stopTurn();
      return;
    }
    if (sessionId === null || sessionId.length === 0) return;
    void (async () => {
      try {
        const result = await requestStop.mutateAsync({ sessionId });
        // The mutation RESOLVES on an application-level failure — the Result
        // envelope carries it. Ignoring `ok:false` left the key disabled on
        // "Stopping…" while the agent kept running, which reads as a
        // successful stop and is the worst possible lie on this control.
        if (!result.ok) {
          setStopRequested(false);
          setNotice({ tone: "error", text: STOP_FAILED_NOTICE });
        }
      } catch {
        // Transport-level failure — same recovery: give the user a Stop key
        // that works again rather than a dead one.
        setStopRequested(false);
        setNotice({ tone: "error", text: STOP_FAILED_NOTICE });
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
    stopAvailable: submitPending || sliceLive,
    awaitingApproval,
    onSubmit,
    onRetry,
    onStop,
  };
}
