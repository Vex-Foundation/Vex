/**
 * Session composer — THE SIGNAL CONSOLE, a single floating pill bar,
 * rebuilt Grok-style (owner decree 2026-07-21).
 *
 * ONE translucent glass pill — truly `rounded-full` at rest (a slim ~56px
 * stadium; QUIET: the ring is a flat hairline until focus/approval wake it,
 * owner correction 2026-07-21 round 2), relaxing to rounded-[28px] once the
 * field grows multiline — floating over the Eclipse backdrop. Left→right
 * inside the pill:
 *   - the transparent-bg textarea (auto-grow, 16px type, one geometry for
 *     welcome AND session — the Grok pill is the same instrument on both
 *     stages, so the old `stage` presence prop is retired) opens the pill
 *     with a generous left inset — no "+" toggle, no attach, no mic
 *     (owner-excluded). Its DEFAULT welcome/agent prompt rotates through
 *     crypto orders (`usePlaceholderRotator`) rendered as an aria-hidden
 *     FAUX-PLACEHOLDER OVERLAY (a native placeholder attribute cannot
 *     animate): each phrase swaps with a soft ~300ms crossfade + upward
 *     drift (owner: the hard attribute swap read as broken). Starter chips
 *     render detached below whenever an empty conversation has starters,
 *     and DISAPPEAR while the user is typing (draft non-empty → fade/scale
 *     out; empty again → return) inside a fixed-height slot so the pill
 *     never reflows,
 *   - the right cluster: the quiet reasoning-effort selector
 *     (`ReasoningEffortSelect`, the Grok "Szybki ⌄" slot — mounted ONLY for
 *     an agent-stage session/welcome whose model reports a normalized
 *     capability from the GLOBAL model query (`useAvailableModels`, the
 *     same one-global-model fact `sessions.getModel` echoes — sourcing
 *     both stages from the always-warm global query removes the welcome
 *     gap AND the first-message cold-query race); mission sessions never
 *     see it. A quiet inert placeholder fills the slot while that query is
 *     still unresolved so the row never reflows once it settles) and the
 *     round accent send/stop/stopping control (Grok's round key). The row
 *     is `items-center`, so the resting single-line state reads perfectly
 *     level.
 * Owns: mounting + wiring the pill's sub-parts together and the starter
 * chips. The chat-turn submit state machine, the mission-run gate, and the
 * composer notice (success / error / inline Retry on a retryable error)
 * live in `composer-submit.ts` — this file never parses commands itself.
 *
 * The pill's glass surface + backdrop-blur are the owner-sanctioned third
 * glass surface (see shell-design-guard whitelist). The 1px border, the
 * TRAVELING accent shimmer that circles the ring, the focus step to
 * `--vex-glass-strong`, the soft drop shadow and the amber approval recolor
 * all live in `.vex-console` (globals.css) — token-only, so both themes
 * recolor from `--vex-accent`. The context strip is gone, so the two
 * transient states it carried survive as a tiny tag FLOATING above the pill:
 * amber "AWAITING SIGNATURE" while a run is parked for approval or muted
 * "Stopping…" while a stop settles. Active work is shown on the agent avatar
 * in the transcript instead of adding another label above the input.
 *
 * Pure helpers: gating reasons + placeholders in `composer-helpers.ts`.
 * Submit orchestration lives in `composer-submit.ts`; reasoning-effort
 * resolution in `composer-reasoning.ts`; the auto-grow field sizing in
 * `composer-field-grow.ts`. The field slot is `ComposerField.tsx`; the
 * right cluster (brand mark + effort selector + send/stop key) is
 * `ComposerSendControl.tsx`. Mission controls (start/continue/recover/stop/
 * edit/renew) are buttons in `MissionControls.tsx`, mounted by the parent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  flattenTranscriptPages,
  useTranscriptInfinite,
} from "../../lib/api/messages.js";
import { cn } from "../../lib/utils.js";
import {
  CHAT_STOPPED_NOTICE_TEXT,
  placeholderFor,
} from "./composer-helpers.js";
import { PostStopRedirectHint } from "./PostStopRedirectHint.js";
import { useComposerFieldGrow } from "./composer-field-grow.js";
import { useComposerReasoningEffort } from "./composer-reasoning.js";
import { useComposerSubmit } from "./composer-submit.js";
import { ComposerField } from "./ComposerField.js";
import { ComposerQuickActions } from "./ComposerQuickActions.js";
import { ComposerSendControl } from "./ComposerSendControl.js";
import { usePlaceholderRotator } from "./composer-placeholders.js";
import { EASE_STANDARD } from "../../lib/motion.js";

/** jsdom-safe reduced-motion probe (the SidebarProfile pattern). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface SessionComposerProps {
  readonly activeSession: SessionListItem | null;
  readonly activeSessionId: string | null;
}

export function SessionComposer({
  activeSession,
  activeSessionId,
}: SessionComposerProps): JSX.Element {
  // Submit/enable gate on the canonical selected id (uiStore), NOT the
  // detail-query object: the engine ingress loads its own session context,
  // so a turn can be sent the moment a session is active — even while the
  // `sessions.get` detail query is still loading or errored (this was the
  // "send button permanently disabled" bug). `activeSession` stays for
  // soft, detail-derived UI only (placeholder, quick-action visibility).
  const sessionId = activeSessionId;
  const {
    reasoningCapability,
    globalModelId,
    reasoningStageIsAgent,
    modelsResolved,
    effectiveReasoningEffort,
    carryReasoningEffort,
    handleReasoningPick,
  } = useComposerReasoningEffort(sessionId, activeSession);
  const {
    draft,
    setDraft,
    clearNotice,
    notice,
    submitPending,
    stopRequested,
    stopAvailable,
    awaitingApproval,
    onSubmit,
    onRetry,
    onStop,
  } = useComposerSubmit(
    sessionId,
    activeSession,
    carryReasoningEffort,
    effectiveReasoningEffort,
  );

  // Focus flag for the placeholder rotator: the rotating welcome placeholder
  // freezes on its current phrase while the field is focused or holds a draft,
  // so it never shuffles under an operator mid-thought.
  const [focused, setFocused] = useState<boolean>(false);
  // Sampled once per mount (the WelcomePortfolioPanel idiom) — the chips'
  // enter/exit declaration must not flip mid-animation.
  const [reducedMotion] = useState(prefersReducedMotion);
  const { textareaRef, fieldSlotRef, multiline, armCaretSeed } =
    useComposerFieldGrow(draft);
  const formRef = useRef<HTMLFormElement>(null);

  // Post-stop redirect hint. Keyed off the notice the stop already produces —
  // no extra state machine, and no way for it to appear when nothing stopped.
  // Dismissal resets on each NEW stop so a user who dismissed it once still
  // gets the offer the next time they interrupt the agent.
  const justStopped =
    notice !== null
    && notice.tone === "info"
    && notice.text === CHAT_STOPPED_NOTICE_TEXT;
  const [redirectHintDismissed, setRedirectHintDismissed] = useState(false);
  useEffect(() => {
    if (justStopped) setRedirectHintDismissed(false);
  }, [justStopped]);

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

  const applyQuickAction = useCallback(
    (prompt: string): void => {
      setDraft(prompt);
      clearNotice();
      // One fluid gesture (owner smoothness decree 2026-07-22): the chips
      // fade, the pill grows, AND the caret lands at the end of the seeded
      // draft — armed here, executed by the auto-grow layout effect once the
      // controlled value has committed to the DOM.
      armCaretSeed();
    },
    [setDraft, clearNotice, armCaretSeed],
  );

  const draftEmpty = draft.trim().length === 0;
  const submitDisabled = draftEmpty || submitPending;
  // Stop acknowledged and the turn still in flight — the send key goes
  // inert and the chrome-row hint swaps to the STOPPING… label.
  const stopping = stopAvailable && stopRequested;

  // Mission-mode placeholders stay owned by `placeholderFor`; the welcome /
  // agent default is the rotating crypto-utility set (`usePlaceholderRotator`).
  // Pause the rotator whenever a non-rotating override is visible so returning
  // from mission copy does not immediately jump to a hidden background tick.
  const rotatorPaused =
    focused || draft.length > 0 || activeSession?.mode === "mission";
  const welcomePlaceholder = usePlaceholderRotator(rotatorPaused);
  const placeholder =
    activeSession?.mode === "mission"
      ? placeholderFor(activeSession)
      : welcomePlaceholder;

  return (
    <>
      <div className="relative mt-6">
        {/* TRANSIENT SIGNAL TAG — floats above the pill's right side. An
         * approval pause wins over a requested stop. The active-work signal
         * lives on the agent avatar in the transcript, so the composer stays
         * visually quiet while a turn is running. */}
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

        {justStopped && !redirectHintDismissed ? (
          <PostStopRedirectHint
            onRedirect={() => {
              setRedirectHintDismissed(true);
              textareaRef.current?.focus();
            }}
            onDismiss={() => setRedirectHintDismissed(true)}
          />
        ) : null}

        <form
          ref={formRef}
          onSubmit={onSubmit}
          data-vex-area="chat-composer"
          data-vex-console-state={awaitingApproval ? "approval" : "input"}
          className={cn(
            // THE SIGNAL CONSOLE PILL — one translucent glass row floating over
            // the Eclipse backdrop, Grok geometry (owner decree 2026-07-21):
            // truly rounded-full at the resting single-line height, relaxing
            // to rounded-[28px] once the field grows multiline so the stadium
            // curve never cuts into the draft (.vex-console eases the swap).
            // The glass surface + backdrop-blur are the owner-sanctioned THIRD
            // glass surface (shell-design-guard whitelist). The ring is QUIET
            // AT REST — one flat --vex-line hairline; the traveling accent
            // arc wakes ONLY on focus-within (with the --vex-glass-strong
            // step) and in the amber approval state — all owned by
            // `.vex-console` (globals.css) so no resting-glow shadow lands in
            // a className. `items-center`: the round send shares the field's
            // height, so the resting single-line row reads perfectly level (a
            // tall multiline field centers it — the deliberate trade-off).
            "vex-console relative flex items-center gap-1.5 overflow-visible bg-[var(--vex-glass)] p-1.5 backdrop-blur-xl",
            multiline ? "rounded-[28px]" : "rounded-full",
          )}
        >
          <ComposerField
            fieldSlotRef={fieldSlotRef}
            textareaRef={textareaRef}
            draft={draft}
            placeholder={placeholder}
            reducedMotion={reducedMotion}
            onDraftChange={(value) => {
              setDraft(value);
              clearNotice();
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSubmitRequest={() => formRef.current?.requestSubmit()}
          />

          <ComposerSendControl
            reasoningCapability={reasoningCapability}
            reasoningStageIsAgent={reasoningStageIsAgent}
            effectiveReasoningEffort={effectiveReasoningEffort}
            modelsResolved={modelsResolved}
            globalModelId={globalModelId}
            onReasoningPick={handleReasoningPick}
            stopAvailable={stopAvailable}
            stopRequested={stopRequested}
            onStop={onStop}
            submitDisabled={submitDisabled}
          />
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
              onClick={onRetry}
              disabled={submitPending}
              aria-label="Retry sending the message"
              className="inline-flex shrink-0 items-center rounded-[3px] border border-[color-mix(in_oklab,var(--vex-accent)_40%,transparent)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--vex-accent-text)] transition-colors hover:bg-[var(--vex-accent-fill-8)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:cursor-not-allowed disabled:border-[var(--vex-line-strong)] disabled:text-[var(--vex-text-3)]"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* STARTER CHIPS — detached below the pill, and gone WHILE THE USER IS
       * TYPING (owner decree 2026-07-21): any draft content fades/scales the
       * row out; clearing the field brings it back. The row lives inside a
       * FIXED-HEIGHT slot that stays mounted for the whole welcome/idle
       * stage, so the chips' unmount can never reflow the centered column —
       * the input does not jump (owner report 2026-07-21 round 2). h-[60px]
       * = the glass band (~44px) + its mt-4. AnimatePresence with
       * transform/opacity only (MOTION-POLICY: `layout`/`layoutId` are
       * banned under CSP style-src 'self'); `initial={false}` leaves the
       * stage load-in to the chips' own one-shot .vex-rise choreography.
       * Reduced motion: instant add/remove, no tween. */}
      {showQuickActions ? (
        <div className="h-[60px]">
          <AnimatePresence initial={false}>
            {draft.length === 0 ? (
              <motion.div
                key="starter-chips"
                initial={
                  reducedMotion ? false : { opacity: 0, scale: 0.97, y: 4 }
                }
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={
                  reducedMotion
                    ? { opacity: 0, transition: { duration: 0 } }
                    : { opacity: 0, scale: 0.97, y: 4 }
                }
                transition={{ duration: 0.16, ease: EASE_STANDARD }}
              >
                <ComposerQuickActions onPick={applyQuickAction} />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </>
  );
}
