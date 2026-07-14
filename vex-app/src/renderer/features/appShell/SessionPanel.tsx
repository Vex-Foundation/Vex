/**
 * Welcome / session panel — orchestration only.
 *
 * Two layouts, branched on whether a session is active:
 *   - no active session → the WELCOME STAGE (phase 5, "Signal Sky"): the
 *     center column is TRANSPARENT — the procedural WebGL sky mounted behind
 *     the shell shows through. `SessionWelcomeHero` paints the centered hero
 *     (status + H1), one bottom vignette and the absolute bottom row against
 *     this panel's relative frame; the composer docks directly beneath the
 *     hero, centered at min(680px, 92%), and a trailing flex spacer balances
 *     the column so hero + instrument center vertically as one group;
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
 * Sub-components keep this file small:
 *   - hero (centered status + H1, vignette, bottom row) → `SessionWelcomeHero`
 *   - context strip/header → `SessionContext` (runtime bar now lives in BOOK)
 *   - mission controls     → `MissionControls` (mission sessions only)
 *   - transcript          → `SessionTranscript`
 *   - composer + slash    → `SessionComposer`
 */

import { useMemo } from "react";
import type { JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  flattenTranscriptPages,
  useTranscriptInfinite,
  useTranscriptLiveSync,
} from "../../lib/api/messages.js";
import { useControlStateLiveSync } from "../../lib/api/runtime.js";
import { useStreamPreviewSync } from "../../lib/api/streams.js";
import { useUsageLiveSync } from "../../lib/api/usage.js";
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

export function SessionPanel(): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  // In the Hypervexing dock the composer is ALWAYS bottom-pinned (user
  // decree): the welcome/idle stage's vertical centering never applies there.
  const inHypervexing = useUiStore((s) => s.workspaceMode) === "hypervexing";
  // Puzzle 02/06: keep the active session's transcript + usage queries fresh
  // (transcript-append event + 30s fallback poll). Puzzle 09: drive the
  // ephemeral streaming preview from the engine stream spine. F5: push
  // runtime-state + pending-approval refresh from the control-state event.
  // Pure side effects.
  useTranscriptLiveSync(activeSessionId);
  useUsageLiveSync(activeSessionId);
  useStreamPreviewSync(activeSessionId);
  useControlStateLiveSync(activeSessionId);
  const detailQuery = useSession(activeSessionId);
  // Shared with SessionTranscript (same query key → no extra IPC): lets the
  // panel tell an empty/idle session apart so it can show the centered landing.
  const transcriptQuery = useTranscriptInfinite(activeSessionId ?? "");
  const preview = useStreamPreview(activeSessionId);

  const activeSession = useMemo((): SessionListItem | null => {
    if (activeSessionId === null) return null;
    if (!detailQuery.data?.ok) return null;
    return detailQuery.data.data;
  }, [activeSessionId, detailQuery.data]);

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
  const isIdleSession =
    activeSession !== null &&
    activeSession.mode !== "mission" &&
    !transcriptQuery.isLoading &&
    preview === null &&
    transcriptPages !== undefined &&
    flattenTranscriptPages(transcriptPages).length === 0 &&
    // The dock never plays the centered idle stage — tape layout from the
    // first frame, composer pinned to the bottom like an active session.
    !inHypervexing;

  // No active session → the welcome stage. The panel is the stage frame:
  // relative (the hero's absolute vignette + bottom row resolve against it)
  // + overflow-hidden, and TRANSPARENT — the Signal Sky behind the shell is
  // the backdrop. The hero bottom-anchors itself (mt-auto) inside the flex-1
  // zone, the composer docks directly beneath it, and the trailing spacer
  // balances the flex-1 hero zone so the whole group centers vertically.
  if (activeSessionId === null) {
    return (
      <div
        data-vex-area="session-panel"
        data-vex-state={panelState}
        className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <SessionWelcomeHero />
        </div>
        {/* THE INSTRUMENT — centered with the hero as one rising group. The
            live $VEX widget used to sit below the composer here; it moved to
            the sessions rail (SessionsList) to keep the welcome stage clean. */}
        <div className="vex-rise vex-rise-d2 relative z-10 mx-auto w-[min(680px,92%)] shrink-0">
          <SessionComposer activeSession={null} activeSessionId={null} stage />
        </div>
        {/* Trailing spacer — balances the hero zone above (vertical
            centering) and reserves the band the hero's absolute bottom row
            occupies, so chips and the row never collide. Skipped in the
            Hypervexing dock, where the composer docks to the very bottom. */}
        {inHypervexing ? null : <div aria-hidden className="min-h-16 flex-1" />}
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
      data-vex-area="session-panel"
      data-vex-state={panelState}
      className={cn(
        "flex h-full min-h-0 w-full",
        // Idle stage: this panel is the stage frame (relative → the hero's
        // absolute vignette + bottom row resolve against it).
        isIdleSession ? "relative flex-col overflow-hidden" : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex h-full min-h-0 w-full flex-col",
          // Idle stage is full-bleed (no max-w, no padding).
          isIdleSession ? undefined : "mx-auto max-w-[860px] px-6 py-4",
        )}
      >
        {/* Content above the composer — swaps the full-bleed idle stage for
            the left-anchored tape. ONE wrapper element so the composer below
            keeps a stable index (no remount, no lost first send). Kept
            position-static so the hero's absolute backdrop resolves against
            the panel frame above, not this wrapper. */}
        <div className="flex min-h-0 flex-1 flex-col">
          {isIdleSession ? (
            <SessionWelcomeHero />
          ) : (
            <>
              <SessionContext
                activeSession={activeSession}
                activeSessionId={activeSessionId}
                loading={detailQuery.isLoading}
                error={detailError}
              />
              {/* The mission contract + action plan no longer render inline:
                  the two tall cards used to push MissionControls + the Accept
                  footer below the fold. They now live in the DESK RULE
                  header's badge cluster (`MissionRail`) — PremiumBadge →
                  top-layer dialog (`MissionContractModal` /
                  `PlanDisplayModal`), which keeps the Accept action pinned and
                  reachable. The transcript now owns the full column height. */}
              {activeSession !== null ? (
                <SessionTranscript sessionId={activeSession.id} />
              ) : null}
              {activeSession !== null ? (
                <ApprovalsRegion sessionId={activeSession.id} />
              ) : null}
              {showMissionCard && activeSession !== null ? (
                <MissionControls sessionId={activeSession.id} />
              ) : null}
            </>
          )}
        </div>
        {/* ALWAYS-PRESENT wrapper (className only changes) so the composer's
            tree position stays stable across the idle↔tape switch. On the
            idle stage it docks the instrument: centered, min(680px, 92%),
            rising with the d2 stagger of the stage choreography. */}
        <div
          className={cn(
            isIdleSession &&
              "vex-rise vex-rise-d2 relative z-10 mx-auto w-[min(680px,92%)] shrink-0",
          )}
        >
          <SessionComposer
            activeSession={activeSession}
            activeSessionId={activeSessionId}
            stage={isIdleSession}
          />
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
