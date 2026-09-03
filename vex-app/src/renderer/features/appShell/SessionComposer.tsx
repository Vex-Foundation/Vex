/**
 * Session composer - the floating capsule (catalog geometry: r22 card,
 * max-w 780, thin-in-dark border, shadow lv2, no focus ring). One component
 * serves the welcome hero and the docked session stage (`variant` names the
 * stage; the textarea DOM survives a hero->docked move because the parent
 * keeps the mount position stable). Owns wiring only: drafts (per-session
 * store), submit + queue (composer-submit), slash commands (commands/),
 * seats (SessionComposer/), and the starter chips. Chrome lives in
 * console.css.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, JSX, MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  useExportSessionMarkdown,
  useSessionPlan,
} from "../../lib/api/sessions.js";
import { publishComposerFocus } from "./composer-focus.js";
import { clearDraft, draftKeyFor } from "../../lib/composer-drafts.js";
import { showToast } from "../../lib/toast.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";
import {
  CHAT_STOPPED_NOTICE_TEXT,
  placeholderFor,
  readActivity,
  readRunStatus,
} from "./composer-helpers.js";
import { PostStopRedirectHint } from "./PostStopRedirectHint.js";
import { useComposerFieldGrow } from "./composer-field-grow.js";
import { useComposerReasoningEffort } from "./composer-reasoning.js";
import { useComposerSubmit } from "./composer-submit.js";
import { ComposerField } from "./ComposerField.js";
import { ComposerQuickActions } from "./ComposerQuickActions.js";
import { ComposerSendControl } from "./ComposerSendControl.js";
import { usePlaceholderRotator } from "./composer-placeholders.js";
import {
  ReasoningEffortPlaceholder,
  ReasoningEffortSelect,
} from "./ReasoningEffortSelect.js";
import {
  ComposerCommandMenu,
  composerCommandActiveDescendant,
} from "./commands/ComposerCommandMenu.js";
import {
  useSlashCommandMenu,
  type SlashMenuPick,
} from "./commands/use-slash-command-menu.js";
import type { ComposerCommandContext } from "./commands/directory.js";
import { useRuntimeState } from "../../lib/api/runtime.js";
import {
  ComposerModelChip,
  ComposerPlanChip,
} from "./SessionComposer/ComposerSeats.js";
import { ComposerContextRing } from "./SessionComposer/ComposerContextRing.js";
import { ComposerPermissionSeat } from "./SessionComposer/ComposerPermissionSeat.js";
import { ComposerQueueDock } from "./SessionComposer/ComposerQueueDock.js";
import { ComposerMissionStrip } from "./SessionComposer/ComposerMissionStrip.js";
import { SessionExportDialog } from "./SessionExportDialog.js";
import { EASE_STANDARD } from "../../lib/motion/index.js";

/**
 * The placeholder shown while a turn is running. It states what the Send key
 * actually does at that moment (A33 steering, A27 queue fallback) instead of
 * rotating an idle suggestion the key would not honour.
 */
export const STEER_QUEUE_PLACEHOLDER =
  "Steer the running turn - or queue this for next.";

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
  /**
   * Stage the capsule is seated on. "hero" is the welcome/idle centered
   * scene, "docked" the session tape. Defaults from `activeSessionId` so
   * existing mounts keep their behavior; Curie's welcome scene passes it
   * explicitly.
   */
  readonly variant?: "hero" | "docked";
}


export function SessionComposer({
  activeSession,
  activeSessionId,
  variant,
}: SessionComposerProps): JSX.Element {
  // Submit/enable gate on the canonical selected id (uiStore), NOT the
  // detail-query object: the engine ingress loads its own session context,
  // so a turn can be sent the moment a session is active. `activeSession`
  // stays for soft, detail-derived UI only.
  const sessionId = activeSessionId;
  const stage = variant ?? (sessionId === null ? "hero" : "docked");
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
    stopLabel,
    awaitingApproval,
    onSubmit,
    onRetry,
    onStop,
    sendNowAvailable,
    sendQueuedNow,
  } = useComposerSubmit(
    sessionId,
    activeSession,
    carryReasoningEffort,
    effectiveReasoningEffort,
  );

  const [focused, setFocused] = useState<boolean>(false);
  // Sampled once per mount - the chips' enter/exit declaration must not flip
  // mid-animation.
  const [reducedMotion] = useState(prefersReducedMotion);
  const { textareaRef, fieldSlotRef, armCaretSeed } =
    useComposerFieldGrow(draft);
  const formRef = useRef<HTMLFormElement>(null);
  const [dropActive, setDropActive] = useState(false);

  // ── slash commands (B9/B12) ────────────────────────────────────────────
  const theme = useUiStore((s) => s.theme);
  const setThemePreference = useUiStore((s) => s.setThemePreference);
  const runtimeQuery = useRuntimeState(sessionId);
  const runStatus = readRunStatus(runtimeQuery.data);
  const runtimeActivity = readActivity(runtimeQuery.data);
  const planQuery = useSessionPlan(sessionId);
  const plan = planQuery.data?.ok ? planQuery.data.data : null;
  const [planOpen, setPlanOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportMutation = useExportSessionMarkdown();

  const commandContext: ComposerCommandContext = useMemo(
    () => ({
      sessionId,
      hasLegacyPlan: plan !== null && plan.enabled,
      clearDraft: () => clearDraft(draftKeyFor(sessionId)),
      openPlan: () => setPlanOpen(true),
      openExport: () => setExportOpen(true),
      toggleTheme: () => {
        const next = theme === "chronos" ? "celeris" : "chronos";
        setThemePreference(next);
        return next === "celeris" ? "Celeris (light)" : "Chronos (dark)";
      },
    }),
    [sessionId, plan, theme, setThemePreference],
  );

  const onCommandPick = useCallback(
    (pick: SlashMenuPick): void => {
      setDraft(pick.draftWithoutToken);
      const toastText = pick.command.run(commandContext);
      if (toastText !== null) showToast(toastText);
    },
    [setDraft, commandContext],
  );
  const slashMenu = useSlashCommandMenu(draft, onCommandPick);

  // /plan opens the same review modal the plan chip owns - a second mount
  // would double-render the dialog, so the chip stays the single owner and
  // the command drives it through this shared open state.
  const activeDescendant = composerCommandActiveDescendant(
    slashMenu.open,
    slashMenu.items,
    slashMenu.highlight,
  );

  // Post-stop redirect hint, keyed off the notice the stop already produces.
  const justStopped =
    notice !== null &&
    notice.tone === "info" &&
    notice.text === CHAT_STOPPED_NOTICE_TEXT;
  const [redirectHintDismissed, setRedirectHintDismissed] = useState(false);
  useEffect(() => {
    if (justStopped) setRedirectHintDismissed(false);
  }, [justStopped]);

  // STARTER CHIPS: a pure function of the STAGE (codex Bug 1, secondary
  // repro). This used to re-derive "is the transcript empty?" from its own
  // `useTranscriptInfinite` read, which resolved on a different beat from
  // SessionPanel's phase solver. On a fresh first send the panel had already
  // docked the capsule while this query still reported empty, so the 60px slot
  // lingered under the docked card and then vanished - a second composer shift
  // on top of the scrollport one. SessionPanel already owns the emptiness
  // question (`isIdleSession` -> `phase`) and hands the answer down as
  // `variant`; the composer now consumes that single source instead of keeping
  // a second one.
  const showQuickActions = stage === "hero";

  const applyQuickAction = useCallback(
    (prompt: string): void => {
      setDraft(prompt);
      clearNotice();
      armCaretSeed();
    },
    [setDraft, clearNotice, armCaretSeed],
  );

  const draftEmpty = draft.trim().length === 0;
  const submitDisabled = draftEmpty || submitPending;
  const stopping = stopAvailable && stopRequested;

  // THE PUBLIC FOCUS SEAM's registration: where `Ctrl+Shift+A` lands after it
  // has switched the shell out of Studio. See `composer-focus.ts` - the
  // registration also consumes a request made before this composer existed,
  // which is every request, because the chord runs while the Studio column is
  // still the one on screen.
  useEffect(
    () =>
      publishComposerFocus(() => {
        textareaRef.current?.focus({ preventScroll: true });
      }),
    [textareaRef],
  );

  // KEEP FOCUS on the send/stop key. Pressing a button moves focus off the
  // draft, so without this the caret is lost and the next keystroke goes
  // nowhere - the composer must stay typeable straight through a send. The
  // default is suppressed at MOUSEDOWN (focus moves on the press) and the
  // textarea is refocused with `preventScroll`, because the browser's focus
  // reveal would scroll the conversation column underneath it.
  const keepFocus = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    textareaRef.current?.focus({ preventScroll: true });
  }, [textareaRef]);

  const rotatorPaused =
    focused ||
    draft.length > 0 ||
    activeSession?.mode === "mission" ||
    submitPending;
  const welcomePlaceholder = usePlaceholderRotator(rotatorPaused);
  // PLACEHOLDER PRECEDENCE, highest first: mission copy (the run owns the
  // field) -> the steer/queue hint while a turn is running -> the rotating
  // default. The steer hint outranks the default because during a turn the
  // Send key does something DIFFERENT from what the default advertises, and a
  // rotating suggestion at that moment is actively misleading.
  const placeholder =
    activeSession?.mode === "mission"
      ? placeholderFor(activeSession)
      : submitPending
        ? STEER_QUEUE_PLACEHOLDER
        : welcomePlaceholder;

  // File-drag visual only: attachments are not supported yet, so the drop
  // ring signals the surface and the drop itself answers honestly.
  const dragHasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes("Files");

  return (
    <>
      <div data-vex-composer-stage={stage} className="relative mt-6">
        {awaitingApproval ? (
          <span
            data-vex-console-status="approval"
            className="vex-micro-label vex-micro-label--wide absolute -top-2.5 right-6 z-20 rounded-full border border-warning bg-surface-composer px-2 py-0.5 uppercase text-warning-label"
          >
            AWAITING SIGNATURE
          </span>
        ) : stopping ? (
          // Exact "Stopping…" text - the stop-acknowledgment contract pinned
          // by the composer stop test (source casing stays).
          <span
            data-vex-console-status="stopping"
            className="vex-micro-label vex-micro-label--wide absolute -top-2.5 right-6 z-20 rounded-full border border-line-3 bg-surface-composer px-2 py-0.5 uppercase text-ink-secondary"
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

        {/* M5: the strip is no longer mission-only. An AGENT session in full
            autonomy runs and sleeps with no run row at all, and this band is
            where the operator sees that it is still working. */}
        {sessionId !== null && activeSession !== null ? (
          <ComposerMissionStrip
            sessionId={sessionId}
            mode={activeSession.mode === "mission" ? "mission" : "agent"}
            missionStatus={runStatus}
            activity={runtimeActivity}
          />
        ) : null}
        {sessionId !== null ? (
          <ComposerQueueDock
            sessionId={sessionId}
            onSendNow={sendQueuedNow}
            sendNowAvailable={sendNowAvailable}
          />
        ) : null}

        {/* Notice strip - above the card (reference geometry: r8, pad 4 8,
         * 12/18, mb 6px), error tone on the danger wash. */}
        {notice !== null ? (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "mx-auto mb-1.5 flex w-full max-w-[780px] items-center gap-2 rounded-lg px-2 py-1 text-[12px] leading-[18px]",
              notice.tone === "error"
                ? "bg-interactive-danger text-danger"
                : "bg-interactive-hover text-ink-secondary",
            )}
          >
            <span>{notice.text}</span>
            {notice.retry !== undefined ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={submitPending}
                aria-label="Retry sending the message"
                className="ml-2 inline-flex shrink-0 items-center rounded border border-current bg-transparent px-2 text-[12px] transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        <form
          ref={formRef}
          onSubmit={onSubmit}
          data-vex-area="chat-composer"
          data-vex-composer-state={awaitingApproval ? "approval" : "input"}
          data-vex-drop={dropActive ? "active" : undefined}
          className="vex-composer-card mx-auto flex w-full max-w-[780px] flex-col gap-1 pt-2.5"
          onDragOver={(event) => {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(event) => {
            if (!dragHasFiles(event)) return;
            event.preventDefault();
            setDropActive(false);
            showToast("Attachments aren't supported yet.");
          }}
        >
          <ComposerCommandMenu
            open={slashMenu.open}
            items={slashMenu.items}
            highlight={slashMenu.highlight}
            onPickAt={slashMenu.pickAt}
          />
          <ComposerField
            hero={stage === "hero"}
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
            onCaretChange={slashMenu.onCaretChange}
            onMenuKeyDown={slashMenu.handleKeyDown}
            activeDescendant={activeDescendant}
          />

          {/* Toolbar row (catalog: space-between, gap 12, pad 2 8 6).
           *
           * `@container` (container-type: inline-size) makes THIS row the
           * query container for the permission seat's label collapse, so the
           * seat answers to the composer's own width rather than the viewport
           * - the composer is capped at 780px inside a rail-driven grid, and a
           * viewport media query would fire at the wrong moment.
           *
           * SHRINK CHAIN (codex Bug 3, cross-check §2). Leading cluster:
           * `min-w-0` and shrinkable, its chips' labels truncate first.
           * Trailing cluster: `flex-none` - the permission seat, the context
           * meter and the send/stop key are the row's protected seats, and
           * their glyphs never shrink. The permission LABEL collapses second,
           * at the 460px container threshold. Nothing is blanket-clipped:
           * every focusable control stays visible and focus-ringed. */}
          <div className="@container flex items-center justify-between gap-3 px-2 pb-1.5 pt-0.5">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <ComposerModelChip modelId={globalModelId} />
              <ComposerPlanChip
                sessionId={sessionId}
                missionStatus={runStatus}
                open={planOpen}
                onOpenChange={setPlanOpen}
              />
              {reasoningCapability !== null &&
              reasoningStageIsAgent &&
              effectiveReasoningEffort !== null ? (
                <ReasoningEffortSelect
                  capability={reasoningCapability}
                  value={effectiveReasoningEffort}
                  onChange={handleReasoningPick}
                />
              ) : reasoningStageIsAgent && !modelsResolved ? (
                <ReasoningEffortPlaceholder />
              ) : null}
            </div>
            {/* Trailing cluster order: pending dot, access mode, context
             * meter, send/stop key (owner: "ustawiony mode obok licznika
             * contextu"). */}
            <div className="flex flex-none items-center gap-2">
              {/* Pending dot beside the key - Stop occupies the key slot
               * while a turn runs, so the in-flight signal sits next to it. */}
              {submitPending ? (
                <span
                  aria-hidden
                  data-vex-composer-pending
                  className="inline-flex h-7 w-4 shrink-0 items-center justify-center text-accent-primary"
                >
                  <span className="vex-composer-pending-dot" />
                </span>
              ) : null}
              <ComposerPermissionSeat
                permission={activeSession?.permission ?? null}
              />
              {sessionId !== null ? (
                <ComposerContextRing
                  sessionId={sessionId}
                  permission={activeSession?.permission ?? null}
                />
              ) : null}
              <ComposerSendControl
                stopAvailable={stopAvailable}
                stopLabel={stopLabel}
                stopRequested={stopRequested}
                onStop={onStop}
                submitDisabled={submitDisabled}
                onKeepFocus={keepFocus}
              />
            </div>
          </div>
        </form>
      </div>

      <SessionExportDialog
        session={exportOpen ? activeSession : null}
        pending={exportMutation.isPending}
        onCancel={() => setExportOpen(false)}
        onConfirm={() => {
          if (activeSession === null) return;
          exportMutation.mutate(
            { id: activeSession.id },
            {
              onSuccess: (result) => {
                setExportOpen(false);
                if (result.ok && result.data.outcome === "saved") {
                  showToast("Session exported.");
                } else if (!result.ok) {
                  showToast("Export failed.", { tone: "error" });
                }
                // A cancelled native save dialog stays silent by contract.
              },
              onError: () => {
                setExportOpen(false);
                showToast("Export failed.", { tone: "error" });
              },
            },
          );
        }}
      />

      {/* Starter chips - gone WHILE THE USER IS TYPING; fixed-height slot so
       * the capsule never reflows. Transform/opacity only (MOTION-POLICY). */}
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
