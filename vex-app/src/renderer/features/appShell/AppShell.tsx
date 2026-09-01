/**
 * Main app shell: the three-column frame (sessions sidebar | session column |
 * BOOK) on grid tracks solved by `lib/shell-columns.ts`, plus the full-app
 * overlay screens and the new-session modal. The frame owns viewport
 * measurement, the sidebar auto-collapse breakpoint, the drag handles, and
 * the derived BOOK auto-close; column CONTENT belongs to SessionsList /
 * SessionPanel / BookPanel.
 *
 * `data-vex-shell="true"` scopes the shell tokens; `data-vex-screen="appShell"`
 * stays the e2e/test selector. The room's back wall is ShellBackdrop (z-0);
 * the grid floats above it and the two rails read the artwork through their
 * glass surfaces.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import { useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import {
  BOOK_COLLAPSED,
  computeShellColumns,
  SIDEBAR_AUTO_COLLAPSE,
  WELCOME_PORTFOLIO_WIDTH,
  type ShellColumns,
} from "../../lib/shell-columns.js";
import { BookPanel } from "./BookPanel.js";
import { SessionCreator } from "./SessionCreator.js";
import { SessionPanel } from "./SessionPanel.js";
import { SessionsList } from "./SessionsList.js";
import { ShellStatusStrip } from "./ShellStatusStrip.js";
import { StudioCenter } from "./studio/StudioCenter.js";
import { StudioSidebar } from "./studio/sidebar/StudioSidebar.js";
import { AgentLaunchFormHost } from "./token-launch/AgentLaunchFormHost.js";
import { BoardModalHost } from "./Board/BoardModalHost.js";
import { BoardGrid } from "./Board/BoardGrid.js";
import { BoardModalChrome } from "./Board/BoardModalChrome.js";
import { BoardSubtitle } from "./Board/BoardSubtitle.js";
import { BoardSpotlightWithChart } from "./Board/BoardSpotlightWithChart.js";
import { AskVexPanel } from "./Board/AskVexPanel.js";
import { ConnectionBanner } from "../../components/ui/connection-banner.js";
import { useNetworkOnline } from "../../lib/use-network-online.js";
import { useEngineErrorRetentionSync } from "../../lib/api/engine-errors.js";
import { ShellBackdrop } from "./ShellBackdrop.js";
import { ShellDragHandle } from "./ShellDragHandle.js";
import { ShellScreens } from "./screens/ShellScreens.js";

export function AppShell(): JSX.Element {
  // App-wide engine-error RETENTION. Mounted here, not per session: a wake or
  // compact failure for a session the user is not currently looking at must
  // still be waiting for them when they select it.
  useEngineErrorRetentionSync();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const theme = useUiStore((s) => s.theme);
  const createSessionOpen = useUiStore((s) => s.createSessionOpen);
  const openCreateSession = useUiStore((s) => s.openCreateSession);
  const closeCreateSession = useUiStore((s) => s.closeCreateSession);

  // Backdrop veil is derived from state AppShell already subscribes to —
  // light on welcome/idle (no active session), deep behind an active session
  // transcript.
  // Studio's own welcome stage is "no project selected", so the veil follows
  // whichever selection the ACTIVE mode is keyed on.
  const backdropDimmed =
    runtimeMode === "studio" ? activeProjectId !== null : activeSessionId !== null;

  return (
    // `relative isolate`: anchors the absolutely-positioned shell backdrop
    // and traps the shell's z-layering in one stacking context.
    <main
      className="relative isolate flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)] text-foreground"
      data-vex-shell="true"
      data-vex-theme={theme}
      data-vex-screen="appShell"
      // The mode the shell is dispatching. `data-vex-screen` is UNCHANGED and
      // stays the e2e selector in BOTH modes: Studio is a mode inside the app
      // shell, never a new View member.
      data-vex-runtime-mode={runtimeMode}
    >
      <ShellBackdrop dimmed={backdropDimmed} />

      <ShellFrame
        runtimeMode={runtimeMode}
        activeSessionId={activeSessionId}
        activeProjectId={activeProjectId}
        onCreate={() => openCreateSession()}
      />

      {/* Full-app overlay screens (Memory / Sessions / How Vex works) —
       * `fixed` overlays expanding from their profile-menu rows, floating
       * above the columns and NEVER in shell flow. */}
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

/**
 * The shell grid: measures its own box (rAF-throttled ResizeObserver),
 * decides the sidebar auto-collapse, solves the three tracks, and hosts the
 * drag handles. The BOOK auto-close is DERIVED from the solve (the stored
 * `bookOpen` preference is never rewritten, so widening the window restores
 * an open BOOK).
 */
function ShellFrame({
  runtimeMode,
  activeSessionId,
  activeProjectId,
  onCreate,
}: {
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
  readonly activeProjectId: string | null;
  readonly onCreate: () => void;
}): JSX.Element {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const sidebarNarrowExpanded = useUiStore((s) => s.sidebarNarrowExpanded);
  const setSidebarNarrowExpanded = useUiStore((s) => s.setSidebarNarrowExpanded);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const bookOpen = useUiStore((s) => s.bookOpen);
  const toggleBook = useUiStore((s) => s.toggleBook);
  const bookWidth = useUiStore((s) => s.bookWidth);
  const setBookWidth = useUiStore((s) => s.setBookWidth);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  // jsdom has no ResizeObserver; viewport stays at innerWidth there.
  useEffect(() => {
    const el = frameRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return undefined;
    let raf: number | null = null;
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        const width = el.getBoundingClientRect().width;
        if (width > 0) setViewport(width);
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  // Narrow viewports auto-collapse the sidebar to the rail; a manual toggle
  // below the breakpoint flips the ephemeral re-expand override instead of
  // the persisted preference. Crossing back into wide clears the override so
  // the next narrow entry starts at the rail again.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
  useEffect(() => {
    if (!narrow) setSidebarNarrowExpanded(false);
  }, [narrow, setSidebarNarrowExpanded]);
  const sidebarCollapsed = narrow ? !sidebarNarrowExpanded : !sidebarOpen;
  const toggleSidebar = useCallback((): void => {
    if (narrow) setSidebarNarrowExpanded(!sidebarNarrowExpanded);
    else setSidebarOpen(!sidebarOpen);
  }, [
    narrow,
    sidebarNarrowExpanded,
    setSidebarNarrowExpanded,
    setSidebarOpen,
    sidebarOpen,
  ]);

  // WELCOME stage: the right edge is the floating Portfolio tab rather than the
  // BOOK rail, so the solver runs sidebar-only and the third track carries the
  // tab's own reservation instead of a solved BOOK width.
  // MODE-AWARE welcome stage. The derivation is otherwise unchanged: the column
  // solve and `rightTrack` read this exactly as they always did, so Studio gets
  // the same floating-Portfolio geometry on its welcome screen that agent mode
  // gets on its own.
  const studio = runtimeMode === "studio";
  const welcomeStage = studio ? activeProjectId === null : activeSessionId === null;
  const cols: ShellColumns = computeShellColumns(
    viewport,
    sidebarCollapsed ? 0 : sidebarWidth,
    welcomeStage || !bookOpen ? 0 : bookWidth,
  );
  const colsRef = useRef(cols);
  colsRef.current = cols;
  // Derived auto-close: preference stays `true`, the rendered panel collapses.
  const bookEffectiveOpen = !welcomeStage && bookOpen && cols.book > BOOK_COLLAPSED;

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0);
  const bookBase = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragEnd = useCallback(() => setDragging(false), []);
  const onSidebarStart = useCallback(() => {
    sidebarBase.current = colsRef.current.sidebar;
    setDragging(true);
  }, []);
  const onBookStart = useCallback(() => {
    bookBase.current = colsRef.current.book;
    setDragging(true);
  }, []);
  const onSidebarDrag = useCallback(
    (dx: number) => setSidebarWidth(sidebarBase.current + dx),
    [setSidebarWidth],
  );
  const onBookDrag = useCallback(
    (dx: number) => setBookWidth(bookBase.current - dx),
    [setBookWidth],
  );

  const networkOnline = useNetworkOnline();

  // THE THIRD TRACK IS ALWAYS A LENGTH (see `WELCOME_PORTFOLIO_WIDTH`): the
  // welcome tab's own reservation while it is open, exactly 0 while it is
  // collapsed, and the solved BOOK width (including its numeric collapsed
  // spine) in session. The 300ms track transition then only ever interpolates
  // length-to-length, so crossing welcome<->session cannot sweep the rail
  // through the centre column.
  const rightTrack = welcomeStage
    ? bookOpen
      ? WELCOME_PORTFOLIO_WIDTH
      : 0
    : cols.book;

  return (
    <div
      ref={frameRef}
      className="vex-shell-frame relative z-10 h-full min-w-0 flex-1"
      style={{
        gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${rightTrack}px`,
      }}
      data-vex-area="shell-frame"
      data-dragging={dragging || undefined}
      data-vex-sidebar-collapsed={sidebarCollapsed || undefined}
    >
      {/* G10 - fixed strip; only an actual outage renders it. */}
      <ConnectionBanner
        reconnecting={!networkOnline}
        label="Offline - waiting for the network to come back"
      />
      {/* COLUMN 1 - the rail the active mode owns. The two rails are separate
        * components on purpose: they hold different objects with different
        * lifetimes, and one component branching on the mode would own both. */}
      <div className="relative z-20 min-w-0 overflow-visible">
        {studio ? (
          <StudioSidebar
            collapsed={sidebarCollapsed}
            width={cols.sidebar}
            onToggleSidebar={toggleSidebar}
            activeProjectId={activeProjectId}
            onSelectProject={setActiveProjectId}
            onSelectWelcome={() => setActiveProjectId(null)}
          />
        ) : (
          <SessionsList
            onCreate={onCreate}
            collapsed={sidebarCollapsed}
            width={cols.sidebar}
            onToggleSidebar={toggleSidebar}
          />
        )}
      </div>

      <section className="relative z-10 flex min-w-0 flex-col overflow-hidden">
        {/* THE STATUS STRIP, mounted ONCE for the whole frame regardless of
          * mode. It carries `GlobalApprovals`, which owns the approvals live
          * sync, and preload allows one subscriber per event kind per window -
          * so a per-shell strip would mean two subscriptions across a mode
          * switch. See `ShellStatusStrip.tsx`. */}
        <ShellStatusStrip
          runtimeMode={runtimeMode}
          activeSessionId={activeSessionId}
        />

        <div className="min-h-0 flex-1">
          {studio ? <StudioCenter /> : <SessionPanel />}
        </div>
      </section>

      <div className="relative z-10 min-w-0 overflow-visible">
        {/* Always mounted — the panel owns its collapsed rendering, so a
         * derived auto-close never remounts it. `bookEffectiveOpen` folds the
         * concession solve into the open flag WITHOUT touching the stored
         * preference. */}
        <BookPanel
          activeSessionId={activeSessionId}
          bookOpen={welcomeStage ? bookOpen : bookEffectiveOpen}
          onToggle={toggleBook}
        />
      </div>

      {/* The collapsed rail is fixed-width: no resize handle while closed.
       * The BOOK handle exists only while the panel is effectively open. */}
      {!sidebarCollapsed ? (
        <ShellDragHandle
          side="sidebar"
          left={cols.sidebar}
          label="Resize the sessions sidebar"
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onEnd={onDragEnd}
        />
      ) : null}
      {bookEffectiveOpen ? (
        <ShellDragHandle
          side="book"
          left={viewport - cols.book}
          label="Resize the BOOK panel"
          onStart={onBookStart}
          onDrag={onBookDrag}
          onEnd={onDragEnd}
        />
      ) : null}

      {/* §C3b — when the AGENT asks the user to launch a token, the consent
        * dialog opens ITSELF, centered, over the whole shell. Mounted at
        * frame level because the agent can ask while the BOOK is collapsed. */}
      <AgentLaunchFormHost sessionId={activeSessionId} />

      {/* THE board modal, mounted once for the whole shell. A transcript card
        * binds it through `board-surface-store`; it renders nothing until one
        * does. Frame level, like the launch form, because a board must stay
        * open while its originating message scrolls out of the transcript. */}
      <BoardModalHost
        headerSlot={BoardModalChrome}
        subtitleSlot={BoardSubtitle}
        gridSlot={BoardGrid}
        spotlightSlot={BoardSpotlightWithChart}
        askSlot={AskVexPanel}
      />
    </div>
  );
}
