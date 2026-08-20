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
import type { DragEvent, JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  flattenTranscriptPages,
  useTranscriptInfinite,
} from "../../lib/api/messages.js";
import {
  useExportSessionMarkdown,
  useSessionPlan,
} from "../../lib/api/sessions.js";
import { clearDraft, draftKeyFor } from "../../lib/composer-drafts.js";
import { showToast } from "../../lib/toast.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";
import {
  CHAT_STOPPED_NOTICE_TEXT,
  placeholderFor,
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
  ComposerPermissionChip,
  ComposerPlanChip,
} from "./SessionComposer/ComposerSeats.js";
import { ComposerContextRing } from "./SessionComposer/ComposerContextRing.js";
import { ComposerQueueDock } from "./SessionComposer/ComposerQueueDock.js";
import { ComposerMissionStrip } from "./SessionComposer/ComposerMissionStrip.js";
import { SessionExportDialog } from "./SessionExportDialog.js";
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

  // Starter chips: welcome + a freshly created, still-empty agent session.
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
      armCaretSeed();
    },
    [setDraft, clearNotice, armCaretSeed],
  );

  const draftEmpty = draft.trim().length === 0;
  const submitDisabled = draftEmpty || submitPending;
  const stopping = stopAvailable && stopRequested;

  const rotatorPaused =
    focused || draft.length > 0 || activeSession?.mode === "mission";
  const welcomePlaceholder = usePlaceholderRotator(rotatorPaused);
  const placeholder =
    activeSession?.mode === "mission"
      ? placeholderFor(activeSession)
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
            className="absolute -top-2.5 right-6 z-20 rounded-full border border-warning bg-surface-composer px-2 py-0.5 font-doto text-[9px] uppercase tracking-[0.16em] text-warning-label"
          >
            AWAITING SIGNATURE
          </span>
        ) : stopping ? (
          // Exact "Stopping…" text - the stop-acknowledgment contract pinned
          // by the composer stop test (source casing stays).
          <span
            data-vex-console-status="stopping"
            className="absolute -top-2.5 right-6 z-20 rounded-full border border-line-3 bg-surface-composer px-2 py-0.5 font-doto text-[9px] uppercase tracking-[0.16em] text-ink-tertiary"
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

        {sessionId !== null && activeSession?.mode === "mission" ? (
          <ComposerMissionStrip
            sessionId={sessionId}
            missionStatus={runStatus}
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

          {/* Toolbar row (catalog: space-between, gap 12, pad 2 8 6). */}
          <div className="flex items-center justify-between gap-3 px-2 pb-1.5 pt-0.5">
            <div className="flex min-w-0 items-center gap-1">
              <ComposerModelChip modelId={globalModelId} />
              <ComposerPermissionChip
                permission={activeSession?.permission ?? null}
              />
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
            <div className="flex shrink-0 items-center gap-2">
              {/* Pending dot beside the key - Stop occupies the key slot
               * while a turn runs, so the in-flight signal sits next to it. */}
              {submitPending ? (
                <span
                  aria-hidden
                  data-vex-composer-pending
                  className="inline-flex h-7 w-4 items-center justify-center text-accent-primary"
                >
                  <span className="vex-composer-pending-dot" />
                </span>
              ) : null}
              {sessionId !== null ? (
                <ComposerContextRing sessionId={sessionId} />
              ) : null}
              <ComposerSendControl
                stopAvailable={stopAvailable}
                stopRequested={stopRequested}
                onStop={onStop}
                submitDisabled={submitDisabled}
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
