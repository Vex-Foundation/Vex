/**
 * Session composer (docs/design/H3-DESKTOP.md sections 1.8 and 6.5, Appendix
 * A.5). In the shell it is ONE framed box standing on the conversation
 * column (owner decision 2026-11-10, "Framed box on the column"), lifted off
 * the window's foot:
 *
 *   form.vex-composer-card.vex-composer-box[data-vex-area="chat-composer"]
 *     .vex-composer-field  "Ask Vex...", growing with the draft to its cap
 *     .vex-composer-row    under a 1px rule:
 *       model cell         the provider's mark, the model's name over
 *                          "Reasoning: High" (the model menu and the effort)
 *       .vex-composer-strip the status strip's cells: AI PERMISSION and the
 *                          promise as caps chips, the composer's state while
 *                          it lasts, CONTEXT with its meter
 *       send cell          the blue SEND, or STOP while a turn runs
 *
 * The Lighter desk keeps its approved composer (section 4.9): the status
 * strip over the row, and the row's mark-only model cell, the field and the
 * send cell at the window's foot. No focus ring on the field: in the box the
 * frame brightens while the field holds the focus; on the desk the caret
 * carries it. One component serves the welcome and the docked session stage
 * (`variant` names the stage; the textarea DOM survives a hero->docked move
 * because the parent keeps the mount position stable), and the whole seat is
 * one component, so a waiting card's decision band can take its place. Owns
 * wiring only: drafts (per-session store), submit + queue (composer-submit),
 * slash commands (commands/), seats (SessionComposer/), and the welcome's
 * suggestions. Chrome lives in console.css, the seat, its place on the
 * column and the welcome in composer.css.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DragEvent, JSX, MouseEvent as ReactMouseEvent } from "react";
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
import { useComposerModel } from "./composer-model.js";
import { useContextWindow } from "../../lib/api/usage.js";
import { inferenceSettingsRoute } from "../../stores/uiStore/shell-route.js";
import { useComposerSubmit } from "./composer-submit.js";
import { ComposerField } from "./ComposerField.js";
import { ComposerQuickActions } from "./ComposerQuickActions.js";
import { useWelcomeStartersSlot } from "./welcome-starters-slot.js";
import { ComposerSendControl } from "./ComposerSendControl.js";
import {
  APPROVAL_WAIT_PLACEHOLDER,
  LIGHTER_DESK_PLACEHOLDER,
} from "./composer-placeholders.js";
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
  ComposerModelCell,
  ComposerOptions,
  ComposerPlanChip,
} from "./SessionComposer/ComposerSeats.js";
import { ComposerContextMeter } from "./SessionComposer/ComposerContextMeter.js";
import { ComposerPermissionSeat } from "./SessionComposer/ComposerPermissionSeat.js";
import { ComposerQueueDock } from "./SessionComposer/ComposerQueueDock.js";
import { ComposerMissionStrip } from "./SessionComposer/ComposerMissionStrip.js";
import { SessionExportDialog } from "./SessionExportDialog.js";
import { Swatch } from "../../components/ui/swatch.js";

/**
 * The placeholder shown while a turn is running. It states what the Send key
 * actually does at that moment (A33 steering, A27 queue fallback) instead of
 * rotating an idle suggestion the key would not honour.
 */
export const STEER_QUEUE_PLACEHOLDER =
  "Steer the running turn, or queue this for next.";

/**
 * The field's resting words, H3's (docs/design/H3-DESKTOP.md Appendix A.5:
 * "Ask Vex..."). Desktop keeps its own for a mission, a running turn, a
 * waiting approval and the Lighter desk; R3's rotating example orders retire.
 */
export const COMPOSER_REST_PLACEHOLDER = "Ask Vex…";

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
  /**
   * Whether a decision waits in this session's pending approvals list (an
   * agent chat's approval, which never parks a mission run). Read by the
   * owner (`SessionPanel`) from the same query the approvals region polls.
   * Joined with the run's `paused_approval` for the "Waiting for approval"
   * frame; presentation only, it never changes what the Send key does.
   */
  readonly pendingApproval?: boolean;
}


export function SessionComposer({
  activeSession,
  activeSessionId,
  variant,
  pendingApproval = false,
}: SessionComposerProps): JSX.Element {
  // Submit/enable gate on the canonical selected id (uiStore), NOT the
  // detail-query object: the engine ingress loads its own session context,
  // so a turn can be sent the moment a session is active. `activeSession`
  // stays for soft, detail-derived UI only.
  const sessionId = activeSessionId;
  const stage = variant ?? (sessionId === null ? "hero" : "docked");
  // F06: the model the next turn runs on (pending pick, session model or
  // default) drives both the model key and the effort set.
  const composerModel = useComposerModel(sessionId, activeSession);
  const {
    reasoningCapability,
    reasoningStageIsAgent,
    modelsResolved,
    effectiveReasoningEffort,
    carryReasoningEffort,
    handleReasoningPick,
  } = useComposerReasoningEffort(sessionId, activeSession, composerModel.option);
  const {
    draft,
    setDraft,
    clearNotice,
    notice,
    submitPending,
    stopRequested,
    stopAvailable,
    stopLabel,
    awaitingApproval: runAwaitingApproval,
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
    composerModel.canPick ? composerModel.pendingPick : null,
  );
  const contextWindowQuery = useContextWindow(sessionId);
  const conversationTokens =
    contextWindowQuery.data?.ok === true && contextWindowQuery.data.data !== null
      ? contextWindowQuery.data.data.tokensUsed
      : null;
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  // The ink "Waiting for approval" frame: a mission run parked for approval,
  // or a decision waiting in this session's pending approvals.
  const awaitingApproval = runAwaitingApproval || (sessionId !== null && pendingApproval);

  // Sampled once per mount - the chips' enter/exit declaration must not flip
  // mid-animation.
  const [reducedMotion] = useState(prefersReducedMotion);
  const { textareaRef, fieldSlotRef, armCaretSeed } =
    useComposerFieldGrow(draft);
  const formRef = useRef<HTMLFormElement>(null);
  const [dropActive, setDropActive] = useState(false);

  // ── slash commands (B9/B12) ────────────────────────────────────────────
  const onLighterDesk = useUiStore((s) => s.runtimeMode === "lighter");
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
    }),
    [sessionId, plan],
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
  // The welcome's slot under its notes, while the welcome stands (D2).
  const welcomeSlot = useWelcomeStartersSlot();

  const applyQuickAction = useCallback(
    (prompt: string): void => {
      setDraft(prompt);
      clearNotice();
      armCaretSeed();
    },
    [setDraft, clearNotice, armCaretSeed],
  );

  // "Create a mission": a mission is its own kind of session (a contract, not
  // a chat message), so the row opens the new session form on the Missions
  // view, where the form preselects Mission (`SessionCreator`).
  const navigate = useUiStore((s) => s.navigate);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const createMission = useCallback((): void => {
    navigate("missions");
    openCreateSession();
  }, [navigate, openCreateSession]);

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

  // PLACEHOLDER PRECEDENCE, highest first: mission copy (the run owns the
  // field) -> the resting phrase while an approval waits -> the steer/queue
  // hint while a turn is running -> "Ask Vex...". The steer hint outranks the
  // resting words because during a turn the Send key does something
  // DIFFERENT (it steers or queues). On the Lighter desk the rail is a
  // trading copilot, so the resting phrase is the desk's.
  const placeholder =
    activeSession?.mode === "mission"
      ? placeholderFor(activeSession)
      : awaitingApproval
        ? APPROVAL_WAIT_PLACEHOLDER
        : submitPending
          ? STEER_QUEUE_PLACEHOLDER
          : onLighterDesk
            ? LIGHTER_DESK_PLACEHOLDER
            : COMPOSER_REST_PLACEHOLDER;

  // File-drag visual only: attachments are not supported yet, so the drop
  // ring signals the surface and the drop itself answers honestly.
  const dragHasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes("Files");

  // The effort key (its menu, or its quiet placeholder while the catalogue
  // loads), and the model cell's key: D2's model cell holds both (section
  // 6.5); the desk keeps the effort in its strip.
  const effortReady =
    reasoningCapability !== null && reasoningStageIsAgent && effectiveReasoningEffort !== null;
  const effortKey =
    effortReady ? (
      <ReasoningEffortSelect
        capability={reasoningCapability}
        value={effectiveReasoningEffort}
        onChange={handleReasoningPick}
      />
    ) : reasoningStageIsAgent && !modelsResolved ? (
      <ReasoningEffortPlaceholder />
    ) : null;
  const modelCell = (
    <ComposerModelCell
      modelId={composerModel.modelId}
      {...(composerModel.canPick && {
        menu: {
          options: composerModel.options,
          onPick: composerModel.pick,
          // Never changes under a running turn.
          disabled: submitPending,
          conversationTokens,
          onOpenSettings: () => setShellRoute(inferenceSettingsRoute(null)),
        },
      })}
    />
  );

  /* THE STATUS STRIP'S CELLS (docs/design/H3-DESKTOP.md sections 1.8 and
   * 6.5). In the shell they stand in the box's bottom row, between the model
   * cell and SEND; on the Lighter desk they stay its strip over the row (its
   * approved plate, section 4.9). Left to right:
   *
   *   access  AI PERMISSION, the grant's caption (and the legacy plan seat
   *           while a session has one); the desk's model and effort instead
   *   promise FUNDS REQUIRE APPROVAL in Restricted, FULL ACCESS in Full
   *           access
   *   state   the room left; desktop's composer states stand here while
   *           they last ("Waiting for approval", "Stopping...")
   *   context CONTEXT, its meter and the real share, where Cloud draws
   *           DAILY BUDGET, which desktop has not
   *
   * The permission's words collapse to its icon by a container query: the
   * desk's strip is its own query container (`@container`); in the box the
   * row is (`.vex-composer-row`, console.css), so the seat answers to the
   * composer's own width rather than the viewport.
   *
   * SHRINK CHAIN (codex Bug 3, cross-check section 2). The model cell is
   * `min-w-0` and shrinkable, the model name truncating first; the state cell
   * takes the room left, and the promise and the context are the protected
   * seats that never shrink. Nothing is blanket-clipped: every focusable
   * control stays visible and focus-ringed. */
  const strip = (
    <div
      data-vex-area="composer-strip"
      // While the state cell holds words, the promise gives them its room
      // sooner (console.css): the strip says which state it holds.
      data-vex-strip-state={awaitingApproval ? "approval" : stopping ? "stopping" : undefined}
      className={onLighterDesk ? "vex-composer-strip @container" : "vex-composer-strip"}
    >
      {onLighterDesk ? (
        // The desk keeps its approved strip (section 4.9): the model and its
        // effort first.
        <div className="vex-composer-strip__cell vex-composer-strip__model min-w-0">
          <ComposerOptions modelId={composerModel.modelId} effort={effortKey} />
          <ComposerPlanChip
            sessionId={sessionId}
            missionStatus={runStatus}
            open={planOpen}
            onOpenChange={setPlanOpen}
          />
        </div>
      ) : (
        // AI PERMISSION (D2, section 6.5): a caption for the grant beside it,
        // which names itself. The legacy plan seat stands after it while a
        // session has one.
        <div className="vex-composer-strip__cell vex-composer-strip__access flex-none">
          <span className="vex-composer-strip__label" aria-hidden="true">
            AI permission
          </span>
          <ComposerPlanChip
            sessionId={sessionId}
            missionStatus={runStatus}
            open={planOpen}
            onOpenChange={setPlanOpen}
          />
        </div>
      )}
      <div className="vex-composer-strip__cell vex-composer-strip__promise flex-none">
        <ComposerPermissionSeat
          permission={
            activeSession?.permission ??
            // The welcome has no session yet: the new session form's own
            // preselect is Restricted, and the form is where the grant is
            // chosen.
            (sessionId === null ? "restricted" : null)
          }
        />
      </div>
      {/* The state cell: the target swatch and "Waiting for approval" while
          an approval waits (status by fill and word), the rule outline while
          a stop is being acknowledged; else H3's empty cell. The words
          truncate before they push a neighbour out. */}
      <div className="vex-composer-strip__cell vex-composer-strip__state">
        {awaitingApproval ? (
          <span data-vex-console-status="approval" className="vex-composer-tag">
            <Swatch state="awaiting" size={10} className="text-accent-primary" />
            <span className="min-w-0 truncate">Waiting for approval</span>
          </span>
        ) : stopping ? (
          // Exact "Stopping…" text - the stop-acknowledgment contract pinned
          // by the composer stop test.
          <span data-vex-console-status="stopping" className="vex-composer-tag">
            <span className="min-w-0 truncate">Stopping…</span>
          </span>
        ) : null}
      </div>
      {/* The context cell. The welcome has no session yet, so no context to
          measure: the cell stands empty rather than show a share it does not
          have. */}
      <div className="vex-composer-strip__cell vex-composer-strip__context flex-none">
        {sessionId !== null ? (
          <ComposerContextMeter sessionId={sessionId} permission={activeSession?.permission ?? null} />
        ) : null}
      </div>
    </div>
  );

  // The field's cell: "Ask Vex...", growing with the draft to its cap.
  const field = (
    <div className="vex-composer-field">
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
        onSubmitRequest={() => formRef.current?.requestSubmit()}
        onCaretChange={slashMenu.onCaretChange}
        onMenuKeyDown={slashMenu.handleKeyDown}
        activeDescendant={activeDescendant}
      />
    </div>
  );

  const sendControl = (
    <ComposerSendControl
      stopAvailable={stopAvailable}
      stopLabel={stopLabel}
      stopRequested={stopRequested}
      onStop={onStop}
      submitDisabled={submitDisabled}
      onKeepFocus={keepFocus}
    />
  );

  const starters = (
    <div data-vex-composer-starters="" className="vex-starters">
      <ComposerQuickActions
        onPick={applyQuickAction}
        onCreateMission={createMission}
        concealed={draft.length > 0}
        locked={submitPending}
      />
    </div>
  );

  return (
    <>
      {/* The welcome's suggestions (docs/design/H3-DESKTOP.md sections 1.7
       * and 6.6): D2 stands them in the welcome, right under its notes, one
       * group with the greeting at the top of the reading column (the
       * welcome's slot, `welcome-starters-slot.ts`); with no welcome slot
       * they stay here, over the composer. Either way they come before the
       * field in reading and focus order. Concealed WHILE THE USER IS
       * TYPING, at once and keeping their box (VEX Cloud's
       * `SuggestionRows`), fading back over 200 ms when the draft empties;
       * nothing slides, and the field never moves. Always this child (or
       * its empty slot), so the composer's own node after it keeps its
       * place across the welcome edge. */}
      {showQuickActions
        ? welcomeSlot === null
          ? starters
          : createPortal(starters, welcomeSlot)
        : null}
      <div
        data-vex-composer-stage={stage}
        className="relative"
      >
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
            awaitingApproval={awaitingApproval}
          />
        ) : null}
        {sessionId !== null ? (
          <ComposerQueueDock
            sessionId={sessionId}
            onSendNow={sendQueuedNow}
            sendNowAvailable={sendNowAvailable}
          />
        ) : null}

        {/* Notice line above the field: an error speaks in ink behind the ink
         * cross (status by fill, never red); an info notice is the second
         * ink alone. */}
        {notice !== null ? (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "mb-2 flex w-full items-center gap-2 px-6 py-1 text-[13px] leading-5",
              notice.tone === "error" ? "text-ink-primary" : "text-ink-secondary",
            )}
          >
            {notice.tone === "error" ? <Swatch state="error" size={9} /> : null}
            <span>{notice.text}</span>
            {notice.retry !== undefined ? (
              <button
                type="button"
                onClick={onRetry}
                disabled={submitPending}
                aria-label="Retry sending the message"
                className="ml-2 inline-flex h-7 shrink-0 items-center px-2.5 font-sans text-[13px] font-medium text-accent-primary outline outline-1 -outline-offset-1 outline-rule transition-colors duration-100 hover:bg-interactive-hover focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-ink-tertiary"
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
          className={onLighterDesk ? "vex-composer-card w-full" : "vex-composer-card vex-composer-box w-full"}
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

          {onLighterDesk ? (
            // The desk keeps its approved composer (section 4.9): the status
            // strip over the row, then the mark-only model cell, the field and
            // the send cell.
            <>
              {strip}
              <div data-vex-area="composer-row" className="vex-composer-row">
                {modelCell}
                {field}
                {sendControl}
              </div>
            </>
          ) : (
            // THE BOX (docs/design/H3-DESKTOP.md section 6.5; owner decision
            // 2026-11-10, "Framed box on the column"): the field on top, and
            // under a 1px rule one row: the model cell, the strip's cells
            // (AI PERMISSION and the promise as caps chips, the state, the
            // context meter), then SEND (STOP).
            <>
              {field}
              <div data-vex-area="composer-row" className="vex-composer-row">
                {/* THE MODEL CELL (D2, section 6.5): the provider's mark (the
                    model menu, or the key to Settings), then the model's name
                    over "Reasoning: High" and the effort key's chevron. Two
                    keys in one cell, each with its own name. */}
                <div data-vex-area="composer-model-group" className="vex-composer-modelcell">
                  {modelCell}
                  <ComposerOptions
                    modelId={composerModel.modelId}
                    reasoning={effortReady}
                    effort={effortKey}
                  />
                </div>
                {strip}
                {sendControl}
              </div>
            </>
          )}
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
    </>
  );
}
