/**
 * THE RESIDENT CONVERSATION SHELL - orchestration only.
 *
 * ONE persistent tree, not two layouts. The welcome and the docked session
 * view are the same DOM in the same positions, told apart only by
 * `data-phase` on this panel's root:
 *
 *   hero      no session, or a session whose transcript is provably empty and
 *             whose turn is not in flight. The welcome stands centred in the
 *             scroll body with flex (never transformed - a transform would
 *             become the containing block for every `position: fixed`
 *             descendant).
 *   settling  a session is opening and its transcript is still unknown, so
 *             hero-vs-docked is unknowable. The seat stays MOUNTED but
 *             invisible, so no wrong layout flashes before the phase lands.
 *   active    the seat docks as the sticky floor of the scroll body, on the
 *             page's own paper.
 *
 * WHY RESIDENCY. The composer's textarea DOM node and its caret must survive
 * the hero→active transition, and the first message of a brand-new session
 * must not be lost across it. The old panel keyed its root on the session id,
 * so welcome→session remounted the whole instrument and the send survived only
 * because `composer-submit` replays it through a hand-off effect. Residency
 * generalizes the older "composer is the stable last child" contract: the seat
 * and everything in it now live OUTSIDE the keyed region entirely.
 *
 * The `.vex-session-enter` one-shot moved with the key onto the SESSION
 * CONTENT wrapper (transcript, banners, approvals, mission controls), which is
 * the part that genuinely swaps between sessions. Phase transitions themselves
 * carry no crossfade and no morph: the position change of one persistent tree
 * IS the transition. The seat's phase geometry lives in
 * `styles/global-css/composer.css`; the reading column (centred, at most 760,
 * docs/design/R3-MINIMAL.md section 6) in `chat-transcript.css`.
 *
 * WHO SCROLLS. This panel's scroll body (`[data-vex-conversation-scroll]`) is
 * the conversation scrollport, because it is the only box that can hold both
 * the transcript and a sticky composer seat. `SessionTranscript` is ordinary
 * flow content inside it and resolves the scrollport through `scrollportOf`.
 *
 * The session's title and mode are NOT in this column: the title bar row says
 * them ("Agent · Restricted"), and the mission contract + action plan open
 * from the title bar's mission badge (`MissionRail`), so the transcript owns
 * the full column height and the Accept action stays reachable.
 *
 * Sub-components keep this file small:
 *   - the welcome           → `SessionWelcomeHero`
 *   - loading / error lines → `SessionContext` (the side rail's head too)
 *   - mission controls      → `MissionControls` (mission sessions only)
 *   - transcript            → `SessionTranscript`
 *   - composer + slash      → `SessionComposer`
 */

import { useMemo, useRef } from "react";
import type { JSX, ReactNode } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  flattenTranscriptPages,
  useTranscriptInfinite,
  useTranscriptLiveSync,
} from "../../lib/api/messages.js";
import { useControlStateLiveSync } from "../../lib/api/runtime.js";
import { useMissionUpdateLiveSync } from "../../lib/api/mission.js";
import { useStreamPreviewSync } from "../../lib/api/streams.js";
import { useIsChatSubmitting } from "../../lib/api/chat.js";
import { useEngineErrorLiveSync } from "../../lib/api/engine-errors.js";
import { usePendingApprovals } from "../../lib/api/approvals.js";
import { SessionErrorBanner } from "./SessionErrorBanner.js";
import { SessionInferenceNotice } from "./SessionInferenceNotice.js";
import { SessionSleepBanner } from "./SessionSleepBanner.js";
import { useUsageLiveSync } from "../../lib/api/usage.js";
import { useWindowTitleSync } from "../../lib/window-title.js";
import { useTurnCompleteNotification } from "../../lib/turn-notification.js";
import { useSession } from "../../lib/api/sessions.js";
import { useScrollbarVisibility } from "../../lib/useScrollbarVisibility.js";
import { cn } from "../../lib/utils.js";
import { useStreamPreview } from "../../stores/streamStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import { ApprovalsRegion } from "./ApprovalsRegion.js";
import { MissionControls } from "./MissionControls.js";
import { SessionComposer } from "./SessionComposer.js";
import { SessionContext } from "./SessionContext.js";
import { SessionTranscript } from "./SessionTranscript.js";
import { SessionWelcomeHero } from "./SessionWelcomeHero.js";

export interface SessionPanelProps {
  /**
   * Optional content-agnostic slot forwarded to the active-session header's
   * trailing edge (see `SessionContext.trailing`). The normal shell mounts
   * `<SessionPanel />` with no slot, so its header is unchanged.
   */
  readonly headerTrailing?: ReactNode;
  /**
   * `embedded` keeps the active session in its conversation layout even when
   * its transcript is empty, and tightens the reading/composer gutters for a
   * side-by-side workspace. The shell remains the default resident surface.
   */
  readonly surface?: "shell" | "embedded";
}

export function SessionPanel({
  headerTrailing,
  surface = "shell",
}: SessionPanelProps = {}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  // Puzzle 02/06: keep the active session's transcript + usage queries fresh
  // (transcript-append event + 30s fallback poll). Puzzle 09: drive the
  // ephemeral streaming preview from the engine stream spine. F5: push
  // runtime-state + pending-approval refresh from the control-state event.
  // Pure side effects.
  useTranscriptLiveSync(activeSessionId);
  useUsageLiveSync(activeSessionId);
  useStreamPreviewSync(activeSessionId);
  useControlStateLiveSync(activeSessionId);
  // Mission-update push (accept / draft / approval-enqueued). Mounted HERE and
  // not in `MissionControls` on purpose: that component is mission-gated, so
  // an agent session — where chat approvals are enqueued — would never
  // subscribe.
  useMissionUpdateLiveSync(activeSessionId);
  // Session-agnostic: an agent-mode session failing in the background used to
  // surface nothing at all, because the only error UI lived behind a
  // mission-mode gate.
  useEngineErrorLiveSync(activeSessionId);
  const detailQuery = useSession(activeSessionId);
  // Shared with SessionTranscript (same query key → no extra IPC): lets the
  // panel tell an empty/idle session apart so it can show the centered landing.
  const transcriptQuery = useTranscriptInfinite(activeSessionId ?? "");
  const preview = useStreamPreview(activeSessionId);
  const chatSubmitting = useIsChatSubmitting(activeSessionId ?? "");
  // Shared with ApprovalsRegion and SessionTranscript (same query key, no
  // extra IPC): a decision waiting in this session frames the composer
  // "Waiting for approval", agent chats included (their runs never park as
  // `paused_approval`). Every row proposed to the chat counts, as the turn
  // island's freeze counts them; a desk row is decided in the desk's own
  // dialog and the transcript leaves it out (`ApprovalsRegion`), so the
  // composer does not wait on it either.
  const pendingQuery = usePendingApprovals(activeSessionId);
  const pendingApproval =
    activeSessionId !== null &&
    pendingQuery.data !== undefined &&
    pendingQuery.data.ok &&
    pendingQuery.data.data.some((row) => row.origin !== "desk");

  // THE FRESH-SESSION HANDOFF, as a phase input. `completeSessionCreate`
  // activates the new session and stores its first turn in ONE set, but the
  // chat mutation does not start until the composer's passive handoff effect
  // fires a commit later. In that gap the transcript is loading, there is no
  // preview and no pending submit, so the phase resolved to `settling` - which
  // hides the resident composer (`composer.css`) and flashed a seatless
  // frame on every newly created session. A stored initial turn with the
  // create modal already closed IS that turn starting, so the phase goes
  // straight to `active`.
  //
  // The `createSessionOpen` half is load-bearing: the same field is also
  // non-null while the modal is OPEN with a seeded draft, and at that moment it
  // belongs to a session that does not exist yet, not to `activeSessionId`.
  const createSessionInitialTurn = useUiStore((s) => s.createSessionInitialTurn);
  const createSessionOpen = useUiStore((s) => s.createSessionOpen);
  const turnStarting =
    activeSessionId !== null &&
    createSessionInitialTurn !== null &&
    !createSessionOpen;

  const scrollBodyRef = useRef<HTMLDivElement>(null);
  // macOS-style overlay bar on the conversation scrollport. The transcript
  // runs the same hook on its own element for the standalone mount; scroll
  // events do not bubble, so each scrolling box owns its own.
  useScrollbarVisibility(scrollBodyRef);

  const activeSession = useMemo((): SessionListItem | null => {
    if (activeSessionId === null) return null;
    if (!detailQuery.data?.ok) return null;
    return detailQuery.data.data;
  }, [activeSessionId, detailQuery.data]);

  // E15 + A34: the native window title mirrors the active session, with the
  // unseen-turn badge while an answer landed unfocused; the same signal asks
  // main for the OS-native notification (narrow notifyTurnComplete contract,
  // main re-checks focus itself). The user TITLE alone rides in the body -
  // initialGoal is free prose and can exceed the title schema's 80-char cap.
  const unseenTurn = useTurnCompleteNotification(
    activeSessionId,
    activeSession?.title ?? null,
  );
  useWindowTitleSync(
    activeSession?.title ?? activeSession?.initialGoal ?? null,
    unseenTurn,
  );

  const detailError =
    detailQuery.data && detailQuery.data.ok === false
      ? detailQuery.data.error.message
      : null;
  const panelState = resolvePanelState(
    activeSessionId,
    activeSession,
    detailQuery,
  );

  // An empty, non-mission session is "idle" — show the centered landing (logo +
  // prompt) like the welcome screen until the first message lands, then the
  // left-anchored tape takes over. Mission sessions keep their contract layout.
  const transcriptPages = transcriptQuery.data?.pages;
  //
  // A turn IN FLIGHT is not idle, even before its first row or delta exists.
  // Waiting for one kept the hero up across the send and deferred the
  // transcript's mount until the turn was already running — which is what made
  // a fresh session's FIRST send miss the centred scene while every later send
  // got it (B1). Retiring the hero on the send edge also stops the send from
  // reading as a no-op on the idle stage.
  const isIdleSession =
    activeSession !== null &&
    activeSession.mode !== "mission" &&
    !transcriptQuery.isLoading &&
    preview === null &&
    !chatSubmitting &&
    !turnStarting &&
    transcriptPages !== undefined &&
    flattenTranscriptPages(transcriptPages).length === 0;

  // PHASE. `settling` is the conservative middle: a session is selected but
  // its transcript has not landed, so we cannot yet know whether it is blank
  // (hero) or populated (active). Rendering either would flash the wrong
  // layout, so the seat stays mounted and hidden until the answer arrives.
  // A turn IN FLIGHT is never hero and never settling, even before its first
  // row or delta exists: retiring the hero on the send edge is what stops a
  // fresh session's first send from reading as a no-op (B1).
  const settling =
    activeSessionId !== null &&
    transcriptQuery.isLoading &&
    preview === null &&
    !chatSubmitting &&
    !turnStarting;
  const hero = activeSessionId === null || isIdleSession;
  const phase =
    surface === "embedded" && activeSessionId !== null
      ? "active"
      : settling
        ? "settling"
        : hero
          ? "hero"
          : "active";
  // The reading column (docs/design/R3-MINIMAL.md section 6): centred, at
  // most 760, shared by the banners, the transcript, the approvals and the
  // docked composer. A side rail keeps its own 12px sides.
  const readingColumn =
    surface === "embedded" ? "mx-auto w-full px-3" : "vex-reading-col";

  const showMissionCard =
    activeSession !== null && activeSession.mode === "mission";

  return (
    // The panel is the stage frame: relative + overflow-hidden, on the
    // centre column's own paper. NOT keyed: residency is the point.
    <div
      data-vex-area="session-panel"
      data-vex-state={panelState}
      data-phase={phase}
      data-vex-session-surface={surface}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <div
        ref={scrollBodyRef}
        data-vex-conversation-scroll=""
        // THE CONVERSATION SCROLLPORT. One axis only: stating `overflow-x`
        // explicitly is what removes the horizontal bar, because a box that
        // scrolls in one axis computes the other to `auto`. The gutter is
        // reserved unconditionally so the composer card keeps one horizontal
        // position whether or not the transcript scrolls.
        className="vex-scroll vex-scroll-overlay flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
      >
        {/* SESSION CONTENT - the part that genuinely swaps between sessions,
            and the ONLY keyed region. `.vex-session-enter` replays here on a
            session change; the seat below is deliberately outside the key so
            the composer node and its caret survive. */}
        {phase === "hero" ? null : (
          <div
            key={activeSessionId ?? "none"}
            data-vex-session-content=""
            // `flex-[1_0_auto]`: fills the viewport when the conversation is
            // short (so the seat sits at the floor) and overflows it when the
            // conversation is long (so the seat sticks).
            className="vex-session-enter flex w-full flex-[1_0_auto] flex-col pb-4 pt-[18px]"
          >
            {/* The head lines keep the reading column; the transcript applies
                the same column inside its own frame, so its scroller can span
                the panel. */}
            <div className={readingColumn}>
              <SessionContext
                activeSession={activeSession}
                activeSessionId={activeSessionId}
                loading={detailQuery.isLoading}
                error={detailError}
                trailing={headerTrailing}
                namedByTitleBar={surface === "shell"}
              />
            </div>
            {activeSession !== null ? (
              <SessionTranscript sessionId={activeSession.id} />
            ) : null}
            {/* After the last turn, where the reader is (docs/design/
                R3-MINIMAL.md section 6): the turn error callout, the mission
                sleep card, then the approvals and the mission controls. */}
            <div className={readingColumn}>
              {activeSession !== null ? (
                <SessionErrorBanner sessionId={activeSession.id} />
              ) : null}
              {activeSession !== null ? (
                <SessionInferenceNotice sessionId={activeSession.id} />
              ) : null}
              {activeSession !== null ? (
                <SessionSleepBanner sessionId={activeSession.id} />
              ) : null}
              {activeSession !== null ? (
                <ApprovalsRegion sessionId={activeSession.id} />
              ) : null}
              {showMissionCard && activeSession !== null ? (
                <MissionControls sessionId={activeSession.id} />
              ) : null}
            </div>
          </div>
        )}

        {/* THE COMPOSER SEAT - resident on every phase, at one stable tree
            position. In hero the scroll body centres it; in active
            `composer.css` makes it the sticky floor on the page's paper. The
            welcome renders INSIDE it so the whole opening moves as one unit,
            and its conditional keeps the composer's child index stable either
            way. */}
        <div
          // The scroll model's ResizeObserver finds this by attribute and
          // republishes its live height as `--vex-composer-height`, so the
          // jump pill clears a growing draft. Losing the marker degrades the
          // pill's clearance silently.
          data-vex-composer-seat=""
          className="relative z-10 flex shrink-0 flex-col"
        >
          {phase === "hero" ? <SessionWelcomeHero /> : null}
          {/* GROWTH BAND (owner smoothness decree 2026-07-22, carried into
              residency): in hero this wrapper's layout height is pinned to the
              composer's RESTING stack, so an auto-growing field overflows
              DOWNWARD and never moves the greeting above it, and its width is
              the welcome's 720 column. In active it is the reading column in
              plain flow. See `composer.css`. */}
          <div
            data-vex-composer-dock=""
            className={cn(
              surface === "embedded"
                ? "mx-auto w-full px-3 pb-3"
                : phase === "hero"
                  ? "vex-reading-col"
                  : "vex-reading-col pb-[18px] pt-0.5",
            )}
          >
            <SessionComposer
              activeSession={activeSession}
              activeSessionId={activeSessionId}
              variant={phase === "hero" ? "hero" : "docked"}
              pendingApproval={pendingApproval}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function resolvePanelState(
  activeSessionId: string | null,
  activeSession: SessionListItem | null,
  detailQuery: ReturnType<typeof useSession>,
): "no-session" | "selected" | "loading" | "error" {
  if (activeSessionId === null) return "no-session";
  if (detailQuery.isLoading) return "loading";
  if (detailQuery.data && detailQuery.data.ok === false) return "error";
  if (activeSession !== null) return "selected";
  return "error";
}
