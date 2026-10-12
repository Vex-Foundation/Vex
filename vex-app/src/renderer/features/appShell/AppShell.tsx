/**
 * Main app shell: the window as an open book (docs/design/V10-SPREAD.md
 * sections 2 to 5). The frame lays out
 *
 *   left page | gutter | (Studio rail) | centre | BOOK
 *
 * on grid tracks solved by `lib/shell-columns.ts`, plus the full-app overlay
 * screens and the new-session modal. The frame owns viewport measurement, the
 * page and rail narrow breakpoint, the drag handles, and the derived BOOK
 * auto-close; column CONTENT belongs to SessionsList / StudioSidebar /
 * SessionPanel / BookPanel.
 *
 * - The LEFT PAGE is the print (`ShellBackdrop`), with the sessions index over
 *   it in agent mode. Closed, and always in Lighter and Studio, it is the 56px
 *   spine: a paper cap in the head row, then the print.
 * - The GUTTER carries the spread caption (`ShellGutter`), an `aria-hidden`
 *   echo of the running head, the session and the connection.
 * - The CENTRE opens with the RUNNING HEAD (`RunningHead`), the 44px drag row
 *   that holds the mission rail, the tape word, the notices, the approvals
 *   inbox and the export key. Under the spread the gutter folds into it.
 * - The BOOK is the outer column; on the welcome stage the Portfolio tab
 *   fills the same track.
 *
 * `data-vex-shell="true"` scopes the shell tokens; `data-vex-screen="appShell"`
 * stays the e2e/test selector. Lighter moves navigation into its top bar above
 * the grid, so its page is always the spine.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  BOOK_COLLAPSED,
  BOOK_MAX,
  BOOK_MIN,
  PAGE_MIN,
  RAIL_COLLAPSED,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SPINE_WIDTH,
  bookDragMax,
  computeShellColumns,
  isBookResizable,
  isSpreadNarrow,
  pageDragMax,
  type ShellColumns,
} from "../../lib/shell-columns.js";
import { BookPanel } from "./BookPanel.js";
import { SessionCreator } from "./SessionCreator.js";
import { SessionPanel } from "./SessionPanel.js";
import { SessionsList } from "./SessionsList.js";
import { RunningHead } from "./RunningHead.js";
import { ShellGutter, SpreadCaptionFold } from "./ShellGutter.js";
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
import { LighterCenter } from "./lighterTrading/LighterCenter.js";
import { LIGHTER_TOPBAR_HEIGHT, LighterSidebar } from "./lighterTrading/LighterSidebar.js";
import { AgentLighterSetupHost } from "./lighterTrading/AgentLighterSetupHost.js";

import { LockVexControl } from "./LockVexControl.js";

export function AppShell(): JSX.Element {
  return <LockVexControl><AppShellContent /></LockVexControl>;
}

function AppShellContent(): JSX.Element {
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

  return (
    // `relative isolate`: anchors the frame and traps the shell's z-layering
    // in one stacking context.
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
      <ShellFrame
        runtimeMode={runtimeMode}
        activeSessionId={activeSessionId}
        activeProjectId={activeProjectId}
        onCreate={(initialMessage) => openCreateSession(initialMessage ?? null)}
      />

      <SessionCreator
        open={createSessionOpen}
        onOpenChange={(next) => {
          if (!next) closeCreateSession();
        }}
      />
      <AgentLighterSetupHost sessionId={activeSessionId} />
    </main>
  );
}

/**
 * The spread: measures its own box (rAF-throttled ResizeObserver), decides
 * whether the first column is open, solves the tracks, and hosts the drag
 * handles. The BOOK auto-close is DERIVED from the solve (the stored
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
  readonly onCreate: (initialMessage?: string) => void;
}): JSX.Element {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const sidebarNarrowExpanded = useUiStore((s) => s.sidebarNarrowExpanded);
  const setSidebarNarrowExpanded = useUiStore((s) => s.setSidebarNarrowExpanded);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const bookOpen = useUiStore((s) => s.bookOpen);
  const toggleBook = useUiStore((s) => s.toggleBook);
  const setBookOpen = useUiStore((s) => s.setBookOpen);
  const bookWidth = useUiStore((s) => s.bookWidth);
  const setBookWidth = useUiStore((s) => s.setBookWidth);
  const lighterChatShare = useLighterAnalysisStore((s) => s.desk.chatShare);
  const saveLighterDesk = useLighterAnalysisStore((s) => s.saveDesk);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const [lighterZen, setLighterZen] = useState(false);
  const [zenAssistantOpen, setZenAssistantOpen] = useState(false);
  const [zenControlsOpen, setZenControlsOpen] = useState(false);

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

  const lighter = runtimeMode === "lighter";
  const studio = runtimeMode === "studio";
  useEffect(() => {
    if (lighter) return;
    setLighterZen(false);
    setZenAssistantOpen(false);
    setZenControlsOpen(false);
  }, [lighter]);

  const setZenMode = useCallback((next: boolean): void => {
    setLighterZen(next);
    setZenAssistantOpen(false);
    setZenControlsOpen(false);
    setSidebarNarrowExpanded(false);
  }, [setSidebarNarrowExpanded]);

  const openZenAssistant = useCallback((): void => {
    setZenAssistantOpen(true);
    setSidebarNarrowExpanded(false);
    if (activeSessionId === null) {
      onCreate();
      return;
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session draft"]')
        ?.focus({ preventScroll: true });
    });
  }, [activeSessionId, onCreate, setSidebarNarrowExpanded]);

  useEffect(() => {
    if (!lighter || !lighterZen) return undefined;
    const onZenKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (zenAssistantOpen) setZenAssistantOpen(false);
      else if (zenControlsOpen) setZenControlsOpen(false);
      else setZenMode(false);
    };
    window.addEventListener("keydown", onZenKey);
    return () => window.removeEventListener("keydown", onZenKey);
  }, [lighter, lighterZen, setZenMode, zenAssistantOpen, zenControlsOpen]);

  // Under the spread the left page (agent) and the project rail (Studio)
  // close to their spines; a manual toggle there flips the ephemeral
  // re-expand override instead of the persisted preference, and the BOOK
  // concedes to make room. Crossing back into the spread clears the override
  // so the next narrow entry starts closed again. Lighter has no first column;
  // the same ephemeral flag opens its desk-navigation tray.
  const narrow = isSpreadNarrow(viewport);
  useEffect(() => {
    if (!lighter && !narrow) setSidebarNarrowExpanded(false);
  }, [lighter, narrow, setSidebarNarrowExpanded]);
  const sidebarCollapsed = lighter
    ? !sidebarNarrowExpanded
    : narrow ? !sidebarNarrowExpanded : !sidebarOpen;
  const toggleSidebar = useCallback((): void => {
    if (lighter || narrow) setSidebarNarrowExpanded(!sidebarNarrowExpanded);
    else setSidebarOpen(!sidebarOpen);
  }, [
    lighter,
    narrow,
    sidebarNarrowExpanded,
    setSidebarNarrowExpanded,
    setSidebarOpen,
    sidebarOpen,
  ]);

  // WELCOME stage, per mode: no session (agent), no project (Studio); Lighter
  // has none, the desk is always resident. The Portfolio tab fills the BOOK
  // track there, and closed it gives the whole track back (no spine).
  const welcomeStage = lighter
    ? false
    : studio ? activeProjectId === null : activeSessionId === null;
  const zen = lighter && lighterZen;
  const closedBook = welcomeStage || zen ? 0 : BOOK_COLLAPSED;
  const requestedBookWidth = zen || !bookOpen
    ? 0
    : lighter ? Math.max(1, viewport * lighterChatShare) : bookWidth;
  const cols: ShellColumns = computeShellColumns({
    viewport,
    mode: runtimeMode,
    zen,
    sidebar: sidebarCollapsed ? 0 : sidebarWidth,
    book: requestedBookWidth,
    closedBook,
  });
  const colsRef = useRef(cols);
  colsRef.current = cols;
  // Derived auto-close: preference stays `true`, the rendered panel collapses.
  const bookEffectiveOpen = !zen && bookOpen && cols.book > closedBook;
  const spine = cols.page <= SPINE_WIDTH;

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0);
  const bookBase = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragEnd = useCallback(() => setDragging(false), []);
  const onSidebarStart = useCallback(() => {
    // Studio drags its rail; agent mode drags the left page.
    sidebarBase.current = studio ? colsRef.current.rail : colsRef.current.page;
    setDragging(true);
  }, [studio]);
  const onBookStart = useCallback(() => {
    bookBase.current = colsRef.current.book;
    setDragging(true);
  }, []);
  const onSidebarDrag = useCallback(
    (dx: number) => setSidebarWidth(sidebarBase.current + dx),
    [setSidebarWidth],
  );
  const onBookDrag = useCallback(
    (dx: number) => {
      const width = bookBase.current - dx;
      if (lighter && viewport > 0) saveLighterDesk({ chatShare: width / viewport });
      else setBookWidth(width);
    },
    [lighter, viewport, saveLighterDesk, setBookWidth],
  );

  // The left page keeps its drag handle only while it can widen without
  // pushing the centre under its floor (owner decision 2026-10-12).
  const pageMax = pageDragMax(cols, viewport);
  const pageHandle = runtimeMode === "agent" && !spine && pageMax > PAGE_MIN;
  const railHandle = studio && cols.rail > RAIL_COLLAPSED;
  const bookHandle = bookEffectiveOpen && !welcomeStage
    && isBookResizable(viewport, runtimeMode);

  const captionSource = { runtimeMode, activeSessionId, activeProjectId };
  const networkOnline = useNetworkOnline();

  // Every track is a LENGTH: the 300ms track transition then only ever
  // interpolates length-to-length (`auto` <-> length is not interpolable and
  // once swept the BOOK through the centre column on the welcome edge).
  const frameStyle: CSSProperties &
    Record<"--vex-book-track" | "--vex-overlay-left", string> = {
    gridTemplateColumns:
      `${cols.page}px ${cols.gutter}px ${cols.rail}px minmax(0, 1fr) ${cols.book}px`,
    paddingTop: lighter && !lighterZen ? LIGHTER_TOPBAR_HEIGHT : undefined,
    // The running head reserves the caption buttons wherever the BOOK below
    // them is narrower than they are (shell.css).
    "--vex-book-track": `${cols.book}px`,
    // Where an overlay sheet starts: past the left page and the gutter, which
    // stay standing (docs/design/V10-SPREAD.md section 2, Overlay row).
    "--vex-overlay-left": `${cols.page + cols.gutter}px`,
  };

  return (
    <div
      ref={frameRef}
      className="vex-shell-frame relative z-10 h-full min-w-0 flex-1"
      style={frameStyle}
      data-vex-area="shell-frame"
      data-vex-spread={spine ? "spine" : "page"}
      data-vex-spread-narrow={narrow || undefined}
      data-dragging={dragging || undefined}
      data-vex-sidebar-collapsed={sidebarCollapsed || undefined}
      data-lighter-zen={zen ? "true" : undefined}
      data-lighter-zen-assistant={lighter && zenAssistantOpen ? "open" : undefined}
      data-lighter-zen-controls={zen
        ? zenControlsOpen ? "open" : "closed"
        : undefined}
    >
      {/* G10 - fixed strip; only an actual outage renders it. */}
      <ConnectionBanner
        reconnecting={!networkOnline}
        label="Offline - waiting for the network to come back"
      />
      {lighter ? (
        <LighterSidebar
          collapsed={sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          zenMode={lighterZen}
          zenAssistantOpen={zenAssistantOpen}
          zenControlsOpen={zenControlsOpen}
          onToggleZen={() => setZenMode(!lighterZen)}
          onToggleZenControls={() => setZenControlsOpen((current) => !current)}
          onToggleZenAssistant={() => {
            if (zenAssistantOpen) setZenAssistantOpen(false);
            else openZenAssistant();
          }}
        />
      ) : null}

      {/* TRACK 1 - the left page: the print, and in agent mode the sessions
        * index over it. The print layer clips itself; the column stays
        * overflow-visible so nothing the index opens is cut at its edge. */}
      <div
        className="vex-left-page relative z-20 h-full min-h-0 min-w-0"
        data-vex-area="left-page"
        data-vex-left-page={spine ? "spine" : "page"}
      >
        {/* The agent state canvas (the eagle and its flock) mounts here as
          * the print's child, over the grain and under the index. */}
        <ShellBackdrop />
        {spine && !lighter ? (
          <div aria-hidden className="vex-left-page__cap vex-drag" />
        ) : null}
        {runtimeMode === "agent" ? (
          <div className="vex-left-page__content">
            <SessionsList
              onCreate={onCreate}
              collapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
            />
          </div>
        ) : null}
      </div>

      {/* TRACK 2 - the gutter and its spread caption. */}
      <ShellGutter {...captionSource} width={cols.gutter} />

      {/* TRACK 3 - Studio's project rail, the centre's left edge; empty and
        * zero-wide in the other modes. */}
      <div className="vex-rail-slot relative z-20 h-full min-h-0 min-w-0 overflow-visible">
        {studio ? (
          <StudioSidebar
            collapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            activeProjectId={activeProjectId}
            onSelectProject={setActiveProjectId}
            onSelectWelcome={() => setActiveProjectId(null)}
          />
        ) : null}
      </div>

      {/* TRACK 4 - the centre page: its running head, then the mode's
        * surface. */}
      <section className="relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {/* THE RUNNING HEAD, mounted ONCE for the whole frame regardless of
          * mode. It carries `GlobalApprovals`, which owns the approvals live
          * sync, and preload allows one subscriber per event kind per window -
          * so a per-shell head would mean two subscriptions across a mode
          * switch. See `RunningHead.tsx`. */}
        <RunningHead
          runtimeMode={runtimeMode}
          activeSessionId={activeSessionId}
          fold={cols.gutter === 0 && !zen ? <SpreadCaptionFold {...captionSource} /> : null}
          empty={runtimeMode === "agent" && activeSessionId === null}
        />

        <div className="min-h-0 flex-1">
          {/* In Lighter mode the conversation lives in the BOOK column
           * (`LighterChatRail`), so the center is the desk alone. */}
          {lighter ? (
            <LighterCenter
              zenMode={lighterZen}
              onOpenZenAssistant={openZenAssistant}
            />
          ) : studio ? <StudioCenter /> : <SessionPanel />}
        </div>
      </section>

      {/* TRACK 5 - the BOOK. */}
      <div className="lit-zen-assistant relative z-10 h-full min-h-0 min-w-0 overflow-visible">
        {/* Always mounted - the panel owns its collapsed rendering, so a
         * derived auto-close never remounts it. `bookEffectiveOpen` folds the
         * concession solve into the open flag WITHOUT touching the stored
         * preference. */}
        <BookPanel
          activeSessionId={activeSessionId}
          bookOpen={zen ? zenAssistantOpen : bookEffectiveOpen}
          onToggle={() => {
            if (zen) {
              setZenAssistantOpen(false);
              return;
            }
            if (lighter && !bookEffectiveOpen) {
              setBookOpen(true);
              setSidebarNarrowExpanded(false);
            }
            else toggleBook();
          }}
        />
      </div>

      {/* A closed first column is fixed-width: no resize handle while closed.
       * The BOOK handle exists only while the panel is open AND free to move
       * (it holds its floor under the full spread). */}
      {pageHandle ? (
        <ShellDragHandle
          side="sidebar"
          left={cols.page}
          label="Resize the sessions sidebar"
          value={cols.page}
          min={PAGE_MIN}
          max={pageMax}
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onEnd={onDragEnd}
        />
      ) : null}
      {railHandle ? (
        <ShellDragHandle
          side="sidebar"
          left={cols.page + cols.gutter + cols.rail}
          label="Resize the sessions sidebar"
          value={cols.rail}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onEnd={onDragEnd}
        />
      ) : null}
      {bookHandle ? (
        <ShellDragHandle
          side="book"
          left={viewport - cols.book}
          label={lighter ? "Resize the Vex panel" : "Resize the BOOK panel"}
          value={cols.book}
          min={BOOK_MIN}
          max={lighter ? BOOK_MAX : Math.max(BOOK_MIN, bookDragMax(cols, viewport))}
          onStart={onBookStart}
          onDrag={onBookDrag}
          onEnd={onDragEnd}
        />
      ) : null}

      {/* §C3b - when the AGENT asks the user to launch a token, the consent
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

      {/* Full-app overlay screens (Memory, Sessions, Settings, assets, agent
        * scan, token history): one paper sheet over the centre and the BOOK,
        * absolute inside the frame so it never reflows a column. */}
      <ShellScreens />
    </div>
  );
}
