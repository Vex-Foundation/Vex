/**
 * Welcome / session panel — orchestration only.
 *
 * Two layouts, branched on whether a session is active:
 *   - no active session → the WELCOME STAGE: the
 *     center column is TRANSPARENT — the procedural WebGL sky mounted behind
 *     the shell shows through. `SessionWelcomeHero` paints the Grok-style
 *     logo row (sigil + PREVIEW wordmark — the H1 is deleted, owner decree
 *     2026-07-21) and the absolute bottom band against this panel's relative
 *     frame; the composer sits directly beneath the logo row, centered at
 *     min(760px, 92%), inside a FIXED-HEIGHT growth band (owner smoothness
 *     decree 2026-07-22): the band's layout height equals the composer's
 *     RESTING stack, so the trailing flex spacer still centers [logo row +
 *     input + chips] like the Grok home — but when the pill auto-grows the
 *     extra height OVERFLOWS the band downward instead of shrinking the two
 *     flex-1 zones, so the crown never re-centers/moves opposite to growth
 *     (the hero itself no longer bottom-anchors; the crown zone's
 *     justify-end owns the seating);
 *   - active session → full-height chat shell: header (`SessionContext`) + live
 *     transcript (`SessionTranscript`, stage 8-1) + mission controls + bottom
 *     composer. The hero is hidden so a selected session's loading/error/empty
 *     states never sit under onboarding copy.
 *
 * The mission contract + action plan are NOT in this column any more — they
 * moved to the DESK RULE header's badge cluster (`MissionRail`) as clickable
 * badges that open `MissionContractModal` / `PlanDisplayModal`. The two tall
 * cards used to push `MissionControls` + the Accept footer below the fold;
 * pulling them out lets the transcript own the full column height and keeps
 * the controls reachable. With no right rail in the layout, the active-session
 * column (max-w 860px) centers itself (mx-auto) in the freed width.
 *
 * Fluid session enter (owner decree 2026-07-20): each branch's outer
 * `data-vex-area="session-panel"` div carries `key={activeSessionId ?? "welcome"}`
 * plus the `.vex-session-enter` one-shot class (globals.css) — the CSP-safe
 * idiom already used by `.vex-rise`/`.vex-book-enter`. Changing the key forces
 * React to remount the panel, replaying the resolve-in animation, so welcome→
 * session, session→welcome, AND session→session (a different id) all fade/
 * rise in together with the backdrop veil deepening, instead of jump-cutting.
 *
 * Sub-components keep this file small:
 *   - hero (centered status + H1, vignette, bottom row) → `SessionWelcomeHero`
 *   - context strip/header → `SessionContext` (runtime bar now lives in BOOK)
 *   - mission controls     → `MissionControls` (mission sessions only)
 *   - transcript          → `SessionTranscript`
 *   - composer + slash    → `SessionComposer`
 */

import { useMemo } from "react";
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
import { SessionErrorBanner } from "./SessionErrorBanner.js";
import { SessionSleepBanner } from "./SessionSleepBanner.js";
import { useUsageLiveSync } from "../../lib/api/usage.js";
import { useWindowTitleSync } from "../../lib/window-title.js";
import { useTurnCompleteNotification } from "../../lib/turn-notification.js";
import { useSession } from "../../lib/api/sessions.js";
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
}

/**
 * The tape stage's READING COLUMN. Applied to each child that wants it rather
 * than to one wrapper around them all, so the transcript can opt OUT and scroll
 * at panel width (see the wrapper comment below). Identical geometry to the
 * wrapper it replaced — same max-width, same gutter, same `mx-auto` axis.
 */
const TAPE_COLUMN = "mx-auto w-full max-w-[860px] px-6";

export function SessionPanel({
  headerTrailing,
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

  const activeSession = useMemo((): SessionListItem | null => {
    if (activeSessionId === null) return null;
    if (!detailQuery.data?.ok) return null;
    return detailQuery.data.data;
  }, [activeSessionId, detailQuery.data]);

  // E15 + A34: the native window title mirrors the active session, with the
  // unseen-turn badge while an answer landed unfocused (existing transcript
  // spine only — no new IPC).
  const unseenTurn = useTurnCompleteNotification(activeSessionId);
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
    transcriptPages !== undefined &&
    flattenTranscriptPages(transcriptPages).length === 0;

  // No active session → the welcome stage. The panel is the stage frame:
  // relative (the hero's absolute bottom band resolves against it)
  // + overflow-hidden, and TRANSPARENT — the Eclipse backdrop behind the
  // shell is the backdrop. Grok home composition (owner decree 2026-07-21):
  // the crown zone seats the logo row at its end (justify-end — the hero no
  // longer carries mt-auto), the composer sits directly beneath it, and the
  // trailing flex-1 spacer balances the flex-1 crown zone so [logo row +
  // input + chips] center vertically as one column.
  if (activeSessionId === null) {
    return (
      <div
        key="welcome"
        data-vex-area="session-panel"
        data-vex-state={panelState}
        className="vex-session-enter relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      >
        <div
          data-vex-welcome-crown
          className="flex min-h-0 flex-1 flex-col justify-end"
        >
          <SessionWelcomeHero />
        </div>
        {/* THE INSTRUMENT — directly below the logo row, one centered
            column (Grok's ~760px input slot), inside the ANCHORED GROWTH
            BAND (owner smoothness decree 2026-07-22): the band's layout
            height is FIXED at the composer's resting stack — mt-6 (24px) +
            resting pill (56px) + chips slot (60px) = 140px — so the flex-1
            crown zone above and spacer below split a CONSTANT leftover.
            When the pill auto-grows, the extra height overflows the band
            DOWNWARD into the empty spacer zone instead of re-centering the
            column, so the crown never moves. The live $VEX widget used to
            sit below the composer here; it moved to the sessions rail
            (SessionsList) to keep the welcome stage clean. */}
        <div
          data-vex-composer-band
          className="relative z-10 h-[140px] shrink-0"
        >
          <div className="vex-rise vex-rise-d2 mx-auto w-[min(760px,92%)]">
            <SessionComposer activeSession={null} activeSessionId={null} />
          </div>
        </div>
        {/* Trailing spacer — balances the crown zone above (vertical
            centering) and reserves the band the hero's absolute bottom row
            occupies, so chips and the row never collide. */}
        <div aria-hidden className="min-h-16 flex-1" />
      </div>
    );
  }

  // Active session. The composer is the STABLE last child of the column, so it
  // never remounts across the idle↔tape switch — a fresh first send and its
  // retry survive. The content ABOVE it swaps: an empty, non-mission session
  // shows the full-bleed welcome stage (same scene as the no-session state);
  // once messages land it becomes the left-anchored tape.
  const showMissionCard =
    activeSession !== null && activeSession.mode === "mission";
  return (
    <div
      key={activeSessionId}
      data-vex-area="session-panel"
      data-vex-state={panelState}
      className={cn(
        "vex-session-enter flex h-full min-h-0 w-full",
        // Idle stage: this panel is the stage frame (relative → the hero's
        // absolute vignette + bottom row resolve against it).
        isIdleSession ? "relative flex-col overflow-hidden" : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex h-full min-h-0 w-full flex-col",
          // PANEL-WIDE on both stages. The reading column used to live here,
          // which made the TRANSCRIPT's scroller only as wide as the column —
          // so its scrollbar floated mid-screen beside the text instead of at
          // the panel's edge, which is not how any browser behaves (owner,
          // 2026-08-05). The column now lives on the individual children, so
          // the transcript can scroll at full panel width and its native
          // overlay bar hugs the right edge next to the BOOK rail. The
          // composer band below already centers itself and is unaffected: the
          // column was `mx-auto`, so its centre axis and the panel's are the
          // same one.
          isIdleSession ? undefined : "py-4",
        )}
      >
        {/* Content above the composer — swaps the full-bleed idle stage for
            the left-anchored tape. ONE wrapper element so the composer below
            keeps a stable index (no remount, no lost first send). Kept
            position-static so the hero's absolute bottom band resolves
            against the panel frame above, not this wrapper. On the idle
            stage justify-end seats the logo row directly above the composer
            (the hero no longer bottom-anchors itself). */}
        <div
          data-vex-welcome-crown={isIdleSession ? "" : undefined}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            isIdleSession && "justify-end",
          )}
        >
          {isIdleSession ? (
            <SessionWelcomeHero />
          ) : (
            <>
              {/* Header + banners keep the reading column; only the
                  transcript goes full-bleed. */}
              <div className={TAPE_COLUMN}>
                <SessionContext
                  activeSession={activeSession}
                  activeSessionId={activeSessionId}
                  loading={detailQuery.isLoading}
                  error={detailError}
                  trailing={headerTrailing}
                />
              {/* The mission contract + action plan no longer render inline:
                  the two tall cards used to push MissionControls + the Accept
                  footer below the fold. They now live in the DESK RULE
                  header's badge cluster (`MissionRail`) — PremiumBadge →
                  top-layer dialog (`MissionContractModal` /
                  `PlanDisplayModal`), which keeps the Accept action pinned and
                  reachable. The transcript now owns the full column height. */}
              {/* Above the transcript and OUTSIDE the mission-mode gate —
                  every session gets an error surface. */}
                {activeSession !== null ? (
                  <SessionSleepBanner sessionId={activeSession.id} />
                ) : null}
                {activeSession !== null ? (
                  <SessionErrorBanner sessionId={activeSession.id} />
                ) : null}
              </div>
              {/* FULL-BLEED: the transcript owns the panel's width so its
                  scroller — and therefore the native scrollbar — reaches the
                  panel's right edge. The reading column is re-applied INSIDE
                  it, around the rows. */}
              {activeSession !== null ? (
                <SessionTranscript sessionId={activeSession.id} />
              ) : null}
              <div className={TAPE_COLUMN}>
                {activeSession !== null ? (
                  <ApprovalsRegion sessionId={activeSession.id} />
                ) : null}
                {showMissionCard && activeSession !== null ? (
                  <MissionControls sessionId={activeSession.id} />
                ) : null}
              </div>
            </>
          )}
        </div>
        {/* ALWAYS-PRESENT two-wrapper pair (classNames only change) so the
            composer's tree position stays stable across the idle↔tape
            switch. On the idle stage the OUTER div is the same ANCHORED
            GROWTH BAND as the welcome stage (fixed h-[140px] = the resting
            composer stack — see the welcome branch): pill auto-grow
            overflows downward instead of re-centering the column, so the
            crown never moves; the INNER div seats the instrument in the
            centered column (min(760px, 92%)) rising with the d2 stagger.
            On the tape stage both wrappers are plain flow (the classless
            inner div changes no layout): the pill keeps the same ~760px
            Grok slot, centered in the transcript column, docked at the
            bottom and growing upward as before. */}
        <div
          data-vex-composer-band={isIdleSession ? "" : undefined}
          className={cn(
            isIdleSession
              ? "relative z-10 h-[140px] shrink-0"
              : "mx-auto w-full max-w-[760px]",
          )}
        >
          <div
            className={cn(
              isIdleSession && "vex-rise vex-rise-d2 mx-auto w-[min(760px,92%)]",
            )}
          >
            {/* The composer is ONE instrument on every stage (the old `stage`
                presence prop is retired with the Grok pill — same 56px
                geometry welcome, idle, and tape). */}
            <SessionComposer
              activeSession={activeSession}
              activeSessionId={activeSessionId}
            />
          </div>
        </div>
        {/* Idle-stage trailing spacer — appears AFTER the composer wrapper so
            its mount/unmount never shifts the composer's tree position. Same
            role as on the welcome stage: vertical centering + clearance for
            the hero's absolute bottom row. */}
        {isIdleSession ? <div aria-hidden className="min-h-16 flex-1" /> : null}
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
