/**
 * Main app shell — THE SIGNAL DESK, CHRONOS edition (Focused · Quiet ·
 * Precise).
 *
 * Onboarding proved identity in a dark room (one light, one signature);
 * the shell is the working register that signature unlocked. Ink canvas
 * (#0a0d18 via --vex-surface-0), zero resting glow: depth on solid surfaces
 * comes from the three luminance steps defined by the [data-vex-shell]
 * scope in globals.css, separated by hairlines. The one sanctioned gradient
 * is the selection beam (.vex-select-beam).
 *
 * The room's back wall is the Eclipse photo backdrop (ShellBackdrop, z-0 —
 * owner-decreed 2026-07-20, superseding the retired procedural SignalSky
 * and its "zero photography" law), running LIGHT-veiled on the welcome/idle
 * stage and DEEP-veiled behind an active session transcript. The columns
 * float above it: the center section carries `relative z-10`; the two side
 * rails (SessionsList / BookPanel) are guard-whitelisted glass (--vex-rail
 * over a blurred backdrop, no border walls) so the artwork reads through
 * them and the shell stays ONE canvas.
 *
 * Layout: sidebar rail (SessionsList) | session column under the DESK RULE
 * | optional on-demand BOOK panel (right <aside>, gated on bookOpen). The
 * center panel is ALWAYS the session panel (Chronos screens redesign,
 * 2026-07-20): Memory, the sessions library, and "How Vex works" open as
 * full-app ShellScreen overlays (screens/), not center sub-views.
 * The STATUS STRIP (the thin h-11 header over the chat column) is a 3-zone
 * grid, re-dealt in the session-UI redesign (owner decree 2026-07-29): the
 * MISSION/PLAN badge cluster (`MissionRail`) moved to the LEFT flank so the
 * live tape-state word (`DeskRuleTapeState`) can own the true CENTRE, and the
 * right flank hosts the approvals inbox plus the Markdown export key
 * (`SessionExportControl`, relocated from the retired session register line —
 * the session title now reads only from the left rail). The BOOK toggle +
 * version stamp both stay in BookPanel's collapse header (single-toggle owner
 * review). The strip carries no decorative accent tick (owner decree,
 * 2026-07-20: the stray dash read as visual noise, not a landmark).
 *
 * `data-vex-shell="true"` scopes the Protocol Desk tokens (sibling of
 * data-vex-onboarding); `data-vex-screen="appShell"` stays the e2e/test
 * selector. The window keeps its native OS frame, so no -webkit-app-region
 * drag strip is mounted (S0 decision — revisit only if the frame goes
 * custom).
 */

import type { JSX } from "react";
import { useUiStore } from "../../stores/uiStore.js";
import { BookPanel } from "./BookPanel.js";
import { DeskRuleTapeState } from "./DeskRuleTapeState.js";
import { MissionRail } from "./MissionRail.js";
import { useAutoCollapseBook } from "./useAutoCollapseBook.js";
import { SessionCreator } from "./SessionCreator.js";
import { SessionExportControl } from "./SessionExportControl.js";
import { SessionPanel } from "./SessionPanel.js";
import { SessionsList } from "./SessionsList.js";
import { GlobalApprovals } from "./GlobalApprovals.js";
import { GlobalErrorBanner } from "./GlobalErrorBanner.js";
import { useEngineErrorRetentionSync } from "../../lib/api/engine-errors.js";
import { ShellBackdrop } from "./ShellBackdrop.js";
import { ShellScreens } from "./screens/ShellScreens.js";

export function AppShell(): JSX.Element {
  // App-wide engine-error RETENTION. Mounted here, not per session: a wake or
  // compact failure for a session the user is not currently looking at must
  // still be waiting for them when they select it. Filtering retention by the
  // selected session dropped exactly those events.
  useEngineErrorRetentionSync();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const theme = useUiStore((s) => s.theme);
  const bookOpen = useUiStore((s) => s.bookOpen);
  const toggleBook = useUiStore((s) => s.toggleBook);
  const createSessionOpen = useUiStore((s) => s.createSessionOpen);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const closeCreateSession = useUiStore((s) => s.closeCreateSession);

  // Stage F responsive: below ~1360px the three columns (sidebar + chat +
  // BOOK) no longer fit, so auto-collapse BOOK on the narrowing edge. One-way on
  // the transition (not continuously enforced) so a user can still re-open BOOK
  // inside a narrow window — we don't fight a manual toggle.
  useAutoCollapseBook();

  // Backdrop veil is derived from state AppShell already subscribes to —
  // light on welcome/idle (no active session), deep behind an active session
  // transcript. The opacity itself eases inside ShellBackdrop, so this can
  // flip freely.
  const backdropDimmed = activeSessionId !== null;

  return (
    // `relative isolate`: anchors the absolutely-positioned Eclipse backdrop
    // and traps the shell's z-layering in one stacking context.
    <main
      className="relative isolate flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)] text-foreground"
      data-vex-shell="true"
      data-vex-theme={theme}
      data-vex-screen="appShell"
    >
      <ShellBackdrop dimmed={backdropDimmed} />

      <NormalShell
        activeSessionId={activeSessionId}
        bookOpen={bookOpen}
        toggleBook={toggleBook}
        onCreate={() => openCreateSession()}
      />

      {/* Full-app overlay screens (Memory / Sessions / How Vex works) —
       * `fixed` overlays expanding from their profile-menu rows, floating
       * above the columns and NEVER in shell flow. Must stay a direct child
       * of this <main>, outside the center section. The center panel below
       * stays the session panel always. */}
      <ShellScreens />

      <SessionCreator
        open={createSessionOpen}
        onOpenChange={(next) => {
          if (!next) closeCreateSession();
        }}
      />
    </main>
  );
}

/** The shell columns: sessions rail · session column under the desk rule ·
 * optional BOOK panel. Extracted so the AppShell root stays a thin frame
 * around the backdrop + overlay screens. */
function NormalShell({
  activeSessionId,
  bookOpen,
  toggleBook,
  onCreate,
}: {
  readonly activeSessionId: string | null;
  readonly bookOpen: boolean;
  readonly toggleBook: () => void;
  readonly onCreate: () => void;
}): JSX.Element {
  return (
    <>
      <SessionsList onCreate={onCreate} />

      <section className="relative z-10 flex min-w-0 flex-1 flex-col">
        {/* THE STATUS STRIP — the thin datum over the chat column. No bottom
         * hairline (header and content read as one seamless surface) and no
         * decorative accent tick. Three zones on a 1fr/auto/1fr grid, equal
         * flanks so the centre is TRULY centred: MISSION/PLAN badge cluster
         * (left), the one live status word (centre), and the right flank
         * carrying the app-wide pending-approvals inbox (`GlobalApprovals`,
         * owner-approved global visibility) plus the export key. Both flank
         * children render null when they have nothing to say, so an idle strip
         * is just the word. The strip itself never moves; only the word, the
         * cluster's badge states, and the approvals badge change. */}
        <header className="relative grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6">
          {/* Left flank — the MISSION/PLAN badge cluster, moved out of the
           * center so the status word can own the true centre. It gates itself
           * away entirely for a plain agent session with plan-mode off. */}
          <div className="flex min-w-0 items-center justify-start">
            <MissionRail activeSessionId={activeSessionId} />
          </div>
          {/* THE CENTRE — one status word, nothing else. It is a stable grid
           * child so the flanks keep their columns even while it renders null
           * (no active session). */}
          <div className="flex min-w-0 items-center justify-center">
            <DeskRuleTapeState />
          </div>
          <div className="flex items-center justify-end gap-2">
            {/* Session-LESS failures (memory maintenance) surface here: they
             * belong to no conversation, so `SessionErrorBanner` could only
             * show them by pretending they happened inside whichever session
             * happened to be open. Renders null when there is nothing to say,
             * like the approvals badge, so the flank stays empty when idle. */}
            <GlobalErrorBanner />
            <GlobalApprovals />
            <SessionExportControl activeSessionId={activeSessionId} />
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <SessionPanel />
        </div>
      </section>

      {/* Always mounted — the panel owns its collapsed state (a thin spine +
       * version stamp) so toggling never remounts it or replays the slide-in
       * keyframe. */}
      <BookPanel
        activeSessionId={activeSessionId}
        bookOpen={bookOpen}
        onToggle={toggleBook}
      />
    </>
  );
}
