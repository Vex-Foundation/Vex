/**
 * Main app shell — THE SIGNAL DESK (the landing's design language, opened
 * for business).
 *
 * Onboarding proved identity in a dark room (one light, one signature);
 * the shell is the working register that signature unlocked. Same ink
 * canvas (#0a0d18 via --vex-surface-0), zero photography, zero resting
 * glow: depth comes from the three solid luminance steps defined by the
 * [data-vex-shell] scope in globals.css, separated by hairlines. The one
 * sanctioned gradient is the selection beam (.vex-select-beam).
 *
 * Phase 5 (Signal Sky): the room's back wall is the landing's procedural
 * WebGL dither sky (SignalSky, z-0 — no imagery), running FULL on the
 * welcome/idle stage and DIMMED behind an active session transcript. The
 * columns float above it: the center section carries `relative z-10`; the
 * two side rails (SessionsList / BookPanel) are guard-whitelisted soft ink
 * (--vex-rail over a blurred backdrop, edge-fading seams instead of border
 * walls) so the sky reads through them and the shell stays ONE canvas.
 *
 * Layout: sidebar rail (SessionsList) | content column under the DESK RULE
 * | optional on-demand BOOK panel (right <aside>, gated on bookOpen). The
 * DESK RULE (h-12 header) is a 3-zone grid: the live tape-state word (left),
 * the MISSION/PLAN badge cluster (`MissionRail`, center — session view only),
 * and an empty right flank (the BOOK toggle + version stamp both live in
 * BookPanel's collapse header — single-toggle owner review). Its
 * bottom-hairline accent tick sits over the left-anchored transcript spine.
 *
 * `data-vex-shell="true"` scopes the Protocol Desk tokens (sibling of
 * data-vex-onboarding); `data-vex-screen="appShell"` stays the e2e/test
 * selector. The window keeps its native OS frame, so no -webkit-app-region
 * drag strip is mounted (S0 decision — revisit only if the frame goes
 * custom).
 */

import type { JSX } from "react";
import type { SkyTheme } from "./signalSkyShaders.js";
import type { AppShellView } from "../../stores/uiStore.js";
import { useUiStore } from "../../stores/uiStore.js";
import { BookPanel } from "./BookPanel.js";
import { DeskRuleTapeState } from "./DeskRuleTapeState.js";
import { MissionRail } from "./MissionRail.js";
import { useAutoCollapseBook } from "./useAutoCollapseBook.js";
import { SessionCreator } from "./SessionCreator.js";
import { SessionPanel } from "./SessionPanel.js";
import { SessionsLibrary } from "./SessionsLibrary.js";
import { SessionsList } from "./SessionsList.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { GlobalApprovals } from "./GlobalApprovals.js";
import { SignalSky } from "./SignalSky.js";
import { HypervexingWorkspace } from "./workspace/HypervexingWorkspace.js";
import { HypervexingFirstEntryAck } from "./workspace/HypervexingFirstEntryAck.js";
import { useHypervexingWorkspace } from "./workspace/useHypervexingWorkspace.js";
import { deriveShellTheme } from "./workspace/workspaceModeGate.js";

/** Sky strength behind an active session transcript — dimmed so the tape
 * stays the protagonist; the welcome/idle stage runs the sky at full 1. The
 * Hypervexing workspace also dims the sky (the chart is the protagonist). */
const SKY_DIM_INTENSITY = 0.35;

export function AppShell(): JSX.Element {
  const appShellView = useUiStore((s) => s.appShellView);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const theme = useUiStore((s) => s.theme);
  const bookOpen = useUiStore((s) => s.bookOpen);
  const toggleBook = useUiStore((s) => s.toggleBook);
  const createSessionOpen = useUiStore((s) => s.createSessionOpen);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const closeCreateSession = useUiStore((s) => s.closeCreateSession);

  // Hypervexing workspace: agent-driven entry (a main→renderer push), ack-gated
  // first entry, always-available exit. The controller owns the ack-dialog gate
  // and turns each agent request into the right store transition.
  const workspace = useHypervexingWorkspace();
  const inWorkspace = workspace.workspaceMode === "hypervexing";

  // `data-vex-theme` is DERIVED: while the mode is active it reads
  // "hypervexing"; otherwise it is the user's own persisted theme, so EXIT
  // restores navy vs lime exactly. The mode never overwrites `theme`.
  const derivedTheme: SkyTheme = deriveShellTheme(workspace.workspaceMode, theme);

  // Stage F responsive: below ~1360px the three columns (sidebar + chat +
  // BOOK) no longer fit, so auto-collapse BOOK on the narrowing edge. One-way on
  // the transition (not continuously enforced) so a user can still re-open BOOK
  // inside a narrow window — we don't fight a manual toggle.
  useAutoCollapseBook();

  // Sky intensity is derived from state AppShell already subscribes to —
  // full on welcome/idle (no active session, or a non-session sub-view),
  // dimmed behind an active session transcript OR the Hypervexing chart. The
  // uniform itself eases inside SignalSky, so this can flip freely.
  const skyIntensity =
    inWorkspace || (activeSessionId !== null && appShellView === "session")
      ? SKY_DIM_INTENSITY
      : 1;

  return (
    // `relative isolate`: anchors the absolutely-positioned Signal Sky and
    // traps the shell's z-layering in one stacking context.
    <main
      className="relative isolate flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)] text-foreground"
      data-vex-shell="true"
      data-vex-theme={derivedTheme}
      data-vex-screen="appShell"
    >
      <SignalSky intensity={skyIntensity} theme={derivedTheme} />

      {inWorkspace ? (
        // The 5-zone trading room replaces the normal columns while active. It
        // reuses the SAME SessionPanel (docked), so chat context is preserved
        // and only ONE chat surface is ever mounted.
        <HypervexingWorkspace onExit={workspace.exit} />
      ) : (
        <NormalShell
          appShellView={appShellView}
          activeSessionId={activeSessionId}
          bookOpen={bookOpen}
          toggleBook={toggleBook}
          onCreate={() => openCreateSession()}
        />
      )}

      <SessionCreator
        open={createSessionOpen}
        onOpenChange={(next) => {
          if (!next) closeCreateSession();
        }}
      />

      {/* First-entry risk acknowledgment (renders in the CURRENT theme, before
       * the morph). The mode activates only after the user accepts. */}
      <HypervexingFirstEntryAck
        open={workspace.ackPending}
        saving={workspace.ackSaving}
        onConfirm={workspace.confirmAck}
        onCancel={workspace.cancelAck}
      />
    </main>
  );
}

/** The normal (non-Hypervexing) shell columns: sessions rail · content column
 * under the desk rule · optional BOOK panel. Extracted so the AppShell root
 * cleanly branches between the normal shell and the Hypervexing workspace. */
function NormalShell({
  appShellView,
  activeSessionId,
  bookOpen,
  toggleBook,
  onCreate,
}: {
  readonly appShellView: AppShellView;
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
         * read as one seamless surface (owner review); only the short accent
         * tick that heads the left-anchored transcript spine remains. Three
         * zones on a 1fr/auto/1fr grid (equal flanks keep the center truly
         * centered): live tape state (left), MISSION/PLAN badge cluster
         * (center), and the right flank hosting the app-wide pending-approvals
         * inbox (`GlobalApprovals`, owner-approved global visibility). The
         * badge renders null at count 0, so the flank stays empty when idle —
         * the center stays truly centered. The BOOK toggle still lives ONLY in
         * BookPanel's collapse header (single-toggle owner review). The rule
         * itself never moves; only the tape-state word, the cluster's badge
         * states, and the approvals badge change. */}
        <header className="relative grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6">
          <span
            aria-hidden
            className="absolute -bottom-px left-6 h-px w-6 bg-[var(--vex-accent)]"
          />
          <div className="flex min-w-0 items-center justify-start">
            <DeskRuleTapeState />
          </div>
          {/* Center cell is a stable grid child so the BOOK toggle stays in
           * column 3 even when the cluster gates itself away (MissionRail
           * renders nothing for a plain agent session with plan-mode off). */}
          <div className="flex min-w-0 items-center justify-center">
            {appShellView === "session" ? (
              <MissionRail activeSessionId={activeSessionId} />
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-3">
            <GlobalApprovals />
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {appShellView === "sessionsLibrary" ? (
            <SessionsLibrary />
          ) : appShellView === "memory" ? (
            <MemoryPanel />
          ) : (
            <SessionPanel />
          )}
        </div>
      </section>

      {appShellView === "session" ? (
        // Always mounted in session view — the panel owns its collapsed state
        // (a thin spine + version stamp) so toggling never remounts it or
        // replays the slide-in keyframe.
        <BookPanel
          activeSessionId={activeSessionId}
          bookOpen={bookOpen}
          onToggle={toggleBook}
        />
      ) : null}
    </>
  );
}
