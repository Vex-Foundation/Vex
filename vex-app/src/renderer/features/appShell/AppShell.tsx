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
 * The DESK RULE (h-12 header) is a 3-zone grid: the live tape-state word
 * (left), the MISSION/PLAN badge cluster (`MissionRail`, center), and the
 * right flank hosting the approvals inbox (the BOOK toggle + version stamp
 * both live in BookPanel's collapse header — single-toggle owner review).
 * The rule carries no decorative accent tick (owner decree, 2026-07-20: the
 * stray dash read as visual noise, not a landmark).
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
import { SessionPanel } from "./SessionPanel.js";
import { SessionsList } from "./SessionsList.js";
import { GlobalApprovals } from "./GlobalApprovals.js";
import { ShellBackdrop } from "./ShellBackdrop.js";
import { ShellScreens } from "./screens/ShellScreens.js";

export function AppShell(): JSX.Element {
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
        {/* DESK RULE — the working header datum and the head of the tape. The
         * full-width bottom hairline was removed so the header and main content
         * read as one seamless surface (owner review); no decorative accent
         * tick remains either (owner decree, 2026-07-20: the dash read as
         * visual noise). Three zones on a 1fr/auto/1fr grid (equal flanks keep
         * the center truly centered): live tape state (left), MISSION/PLAN
         * badge cluster (center), and the right flank hosting the app-wide
         * pending-approvals inbox (`GlobalApprovals`, owner-approved global
         * visibility). The badge renders null at count 0, so the flank stays
         * empty when idle — the center stays truly centered. The BOOK toggle
         * still lives ONLY in BookPanel's collapse header (single-toggle owner
         * review). The rule itself never moves; only the tape-state word, the
         * cluster's badge states, and the approvals badge change. */}
        <header className="relative grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6">
          <div className="flex min-w-0 items-center justify-start">
            <DeskRuleTapeState />
          </div>
          {/* Center cell is a stable grid child so the BOOK toggle stays in
           * column 3 even when the cluster gates itself away (MissionRail
           * renders nothing for a plain agent session with plan-mode off). */}
          <div className="flex min-w-0 items-center justify-center">
            <MissionRail activeSessionId={activeSessionId} />
          </div>
          <div className="flex items-center justify-end gap-3">
            <GlobalApprovals />
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
