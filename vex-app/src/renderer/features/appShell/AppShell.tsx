/**
 * Main app shell: three calm columns (docs/design/R3-MINIMAL.md section 2),
 *
 *   left sidebar | centre | Vex sidebar
 *
 * on grid tracks solved by `lib/shell-columns.ts`, plus the new-session modal.
 * The frame owns viewport measurement, the narrow override, the derived Vex
 * auto-close and Lighter's chat share drag; column CONTENT belongs to
 * SessionsList / StudioSidebar / SessionPanel / VexSidebar.
 *
 * - The LEFT column hosts the sessions sidebar in agent mode, the Studio
 *   projects and explorer in Studio, and the vx mark on the rail in Lighter.
 *   Its widths are fixed (264, 224 at the medium tier, the 56px rail closed);
 *   there is no drag handle.
 * - The CENTRE opens with the RUNNING HEAD (`RunningHead`), the 44px drag row,
 *   then the mode's surface. Pages (Memory, Settings, Portfolio and the rest)
 *   open INSIDE the centre (`ShellScreens`), so both sidebars stay standing.
 * - The RIGHT column is Vex's (`VexSidebar`, docs/design/R3-MINIMAL.md
 *   section 5): open in chat by default, hidden by default on the table pages
 *   and on the Lighter desk, and absent on the welcome stage. Hidden is zero
 *   width; the title bar's token chip brings her back.
 *
 * `data-vex-shell="true"` scopes the shell tokens; `data-vex-screen="appShell"`
 * stays the e2e/test selector. Lighter moves navigation into its top bar above
 * the grid, so its left column is always the rail.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { selectVexOpen, useUiStore, type RuntimeMode } from "../../stores/uiStore.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  LIGHTER_CHAT_MIN,
  RAIL_WIDTH,
  computeShellColumns,
  lighterChatDragMax,
  shellTier,
  type ShellColumns,
} from "../../lib/shell-columns.js";
import { SessionCreator } from "./SessionCreator.js";
import { SessionPanel } from "./SessionPanel.js";
import { SessionsList } from "./SessionsList.js";
import { RunningHead } from "./RunningHead.js";
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
import { LeftPageOpenContext } from "./leftPage/leftPageContext.js";
import { VexMark } from "../../components/common/VexMark.js";
import { ShellDragHandle } from "./ShellDragHandle.js";
import { ShellScreens } from "./screens/ShellScreens.js";
import { LighterCenter } from "./lighterTrading/LighterCenter.js";
import { LIGHTER_TOPBAR_HEIGHT, LighterSidebar } from "./lighterTrading/LighterSidebar.js";
import { AgentLighterSetupHost } from "./lighterTrading/AgentLighterSetupHost.js";
import { VexSidebar } from "../vex/VexSidebar.js";

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
 * The frame: measures its own box (rAF-throttled ResizeObserver), decides
 * what each sidebar is asked to be, solves the tracks, and hosts Lighter's
 * chat share handle. The Vex auto-close is DERIVED from the solve (the stored
 * choice is never rewritten, so widening the window restores an open Vex).
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
  const leftOpen = useUiStore((s) => s.leftOpen);
  const setLeftOpen = useUiStore((s) => s.setLeftOpen);
  const sidebarNarrowExpanded = useUiStore((s) => s.sidebarNarrowExpanded);
  const setSidebarNarrowExpanded = useUiStore((s) => s.setSidebarNarrowExpanded);
  const vexOpen = useUiStore(selectVexOpen);
  const setVexOpen = useUiStore((s) => s.setVexOpen);
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

  // Under the medium tier the left sidebar (agent and Studio) closes to its
  // rail; a manual toggle there flips the ephemeral re-expand override instead
  // of the persisted preference. Crossing back into the medium tier clears the
  // override so the next narrow entry starts at the rail again. Lighter has no
  // left sidebar of its own; the same ephemeral flag opens its top bar drawer.
  const tier = shellTier(viewport);
  const narrow = tier === "narrow";
  useEffect(() => {
    if (!lighter && !narrow) setSidebarNarrowExpanded(false);
  }, [lighter, narrow, setSidebarNarrowExpanded]);
  const leftAsked = narrow ? sidebarNarrowExpanded : leftOpen;
  const toggleSidebar = useCallback((): void => {
    if (lighter || narrow) setSidebarNarrowExpanded(!sidebarNarrowExpanded);
    else setLeftOpen(!leftOpen);
  }, [lighter, narrow, sidebarNarrowExpanded, setSidebarNarrowExpanded, setLeftOpen, leftOpen]);

  // WELCOME stage, per mode: no session (agent), no project (Studio); Lighter
  // has none, the desk is always resident. Vex sits in the centre there, so
  // the right column is empty.
  const welcomeStage = lighter
    ? false
    : studio ? activeProjectId === null : activeSessionId === null;
  const zen = lighter && lighterZen;
  // A hidden Vex keeps nothing: her column closes to zero width.
  const cols: ShellColumns = computeShellColumns({
    viewport,
    mode: runtimeMode,
    left: leftAsked,
    vex: vexOpen,
    welcome: welcomeStage,
    lighterChat: Math.max(1, viewport * lighterChatShare),
    zen,
  });
  const colsRef = useRef(cols);
  colsRef.current = cols;
  // Derived auto-close: the stored choice stays `true`, the column collapses.
  const vexEffectiveOpen = !zen && vexOpen && cols.vex > 0;
  const rail = cols.left <= RAIL_WIDTH;
  // What the left column's content renders: Lighter's drawer state, or the
  // solved column (open, or its rail).
  const sidebarCollapsed = lighter ? !sidebarNarrowExpanded : rail;

  // The chat share drag base is the rendered width captured at drag start
  // (grabbing a concession-clamped chat must not jump back to the stored
  // share); it stays frozen for the whole gesture so dx deltas do not compound.
  const chatBase = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragEnd = useCallback(() => setDragging(false), []);
  const onChatStart = useCallback(() => {
    chatBase.current = colsRef.current.vex;
    setDragging(true);
  }, []);
  const onChatDrag = useCallback(
    (dx: number) => {
      if (viewport > 0) saveLighterDesk({ chatShare: (chatBase.current - dx) / viewport });
    },
    [viewport, saveLighterDesk],
  );
  // The sidebars have fixed widths; the one drag left is Lighter's chat share.
  const chatHandle = lighter && vexEffectiveOpen;

  const networkOnline = useNetworkOnline();

  // Every track is a LENGTH: the 300ms track transition then only ever
  // interpolates length-to-length (`auto` <-> length is not interpolable and
  // once swept the right column through the centre on the welcome edge).
  const frameStyle: CSSProperties &
    Record<"--vex-vex-track" | "--vex-overlay-left", string> = {
    gridTemplateColumns: `${cols.left}px minmax(0, 1fr) ${cols.vex}px`,
    paddingTop: lighter && !lighterZen ? LIGHTER_TOPBAR_HEIGHT : undefined,
    // The running head reserves the caption buttons wherever the right column
    // under them is narrower than they are (shell.css).
    "--vex-vex-track": `${cols.vex}px`,
    // Where a page starts in the window: past the left column. The page
    // itself sits inside the centre (shell.css resets it there); this value
    // is the frame-level box its entrance morph measures against.
    "--vex-overlay-left": `${cols.left}px`,
  };

  return (
    <div
      ref={frameRef}
      className="vex-shell-frame relative z-10 h-full min-w-0 flex-1"
      style={frameStyle}
      data-vex-area="shell-frame"
      data-vex-tier={tier}
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

      {/* TRACK 1 - the left sidebar: the sessions sidebar (agent), the
        * projects and explorer (Studio), the vx mark on the rail (Lighter).
        * The column stays overflow-visible so nothing the sidebar opens is
        * cut at its edge. */}
      <div
        className="vex-left-page relative z-20 h-full min-h-0 min-w-0"
        data-vex-area="left-page"
        data-vex-left-page={rail ? "spine" : "page"}
      >
        {rail && !lighter ? (
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
        ) : studio ? (
          <div className="vex-left-page__content">
            <StudioSidebar
              collapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              activeProjectId={activeProjectId}
              onSelectProject={setActiveProjectId}
              onSelectWelcome={() => setActiveProjectId(null)}
            />
          </div>
        ) : cols.left > 0 ? (
          // Lighter keeps the rail: the vx mark at the top of the print.
          <div aria-hidden className="vex-left-page__content">
            <span className="vex-left-page__mark">
              <VexMark size={22} />
            </span>
          </div>
        ) : null}
      </div>

      {/* TRACK 2 - the centre: its running head, then the mode's surface, and
        * the pages over both inside this column. */}
      <section className="vex-shell-centre relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {/* THE RUNNING HEAD, mounted ONCE for the whole frame regardless of
          * mode. It carries `GlobalApprovals`, which owns the approvals live
          * sync, and preload allows one subscriber per event kind per window -
          * so a per-shell head would mean two subscriptions across a mode
          * switch. See `RunningHead.tsx`. */}
        <RunningHead
          runtimeMode={runtimeMode}
          activeSessionId={activeSessionId}
          empty={runtimeMode === "agent" && activeSessionId === null}
        />

        <div className="min-h-0 flex-1">
          {/* In Lighter mode the conversation lives in the right column
           * (`LighterChatRail`), so the center is the desk alone. */}
          {lighter ? (
            <LighterCenter
              zenMode={lighterZen}
              onOpenZenAssistant={openZenAssistant}
            />
          ) : studio ? <StudioCenter /> : (
            // The welcome hero seats the mode capsule only while the left
            // sidebar is its rail; the open sidebar's mast carries it otherwise.
            <LeftPageOpenContext.Provider value={!rail}>
              <SessionPanel />
            </LeftPageOpenContext.Provider>
          )}
        </div>

        {/* Pages (Memory, Sessions, Settings, Portfolio, Board, Needs you, the
          * money registers): one paper sheet over the centre, absolute inside
          * this column so it never reflows a track. */}
        <ShellScreens />
      </section>

      {/* TRACK 3 - Vex's column. Empty on the welcome stage, where she
        * stands in the centre; in Lighter's Zen it is the assistant overlay. */}
      <div className="lit-zen-assistant relative z-10 h-full min-h-0 min-w-0 overflow-visible">
        {/* Mounted in every session - the sidebar owns its hidden rendering,
         * so a derived auto-close never remounts the column. `vexEffectiveOpen`
         * folds the solve into the open flag WITHOUT touching the stored
         * choice. */}
        {welcomeStage ? null : (
          <VexSidebar
            open={zen ? zenAssistantOpen : vexEffectiveOpen}
            onHide={() => {
              if (zen) setZenAssistantOpen(false);
              else setVexOpen(false);
            }}
          />
        )}
      </div>

      {chatHandle ? (
        <ShellDragHandle
          left={viewport - cols.vex}
          label="Resize the Vex panel"
          value={cols.vex}
          min={LIGHTER_CHAT_MIN}
          max={lighterChatDragMax(cols, viewport)}
          onStart={onChatStart}
          onDrag={onChatDrag}
          onEnd={onDragEnd}
        />
      ) : null}

      {/* §C3b - when the AGENT asks the user to launch a token, the consent
        * dialog opens ITSELF, centered, over the whole shell. Mounted at
        * frame level because the agent can ask while the right column is
        * collapsed. */}
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
