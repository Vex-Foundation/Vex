/**
 * Main app shell: three calm columns in H3's order (docs/design/H3-DESKTOP.md
 * section 1; R3-MINIMAL.md section 2 for what each column holds),
 *
 *   left sidebar (the chats) | Vex sidebar | centre (the chat)
 *
 * on grid tracks solved by `lib/shell-columns.ts`, plus the new-session modal.
 * Vex's column sits between the chats and the chat in the agent shell and
 * Studio, in the DOM as on screen, so focus reaches her before the chat; the
 * Lighter desk keeps R3's left sidebar | centre | Vex sidebar.
 * The grid also has H3's two window-wide rows (docs/design/H3-DESKTOP.md
 * section 1.1), a header row over the columns and a bottom row under them.
 * The frame owns viewport measurement, the narrow override, the derived Vex
 * auto-close and Lighter's chat share drag; column CONTENT belongs to
 * SessionsList / StudioSidebar / SessionPanel / VexSidebar.
 *
 * - THE HEADER (`ShellHeader`, H3-DESKTOP.md section 1.3) is the first row,
 *   one row of cells across the window and its drag region: the logo cell
 *   and the sidebar key over the left column, the chat's title and the
 *   title bar's cluster (`RunningHead`, mounted once) over the centre, the
 *   Vex key over the Vex column, the static Mainnet and Real funds, and
 *   the caption buttons' reserve. The columns stand under it. The bottom row
 *   holds no cell yet, so it is 0.
 *
 * - The LEFT column hosts the sessions sidebar in agent mode, the Studio
 *   projects and explorer in Studio, and the vx mark on the rail in Lighter.
 *   Its widths are fixed (H3's 248 and the 76px rail; R3's 56px rail on the
 *   desk); there is no drag handle. From 1024 to 1267 it starts folded
 *   (H3-DESKTOP.md section 4.12) and under 1024 it is the rail.
 * - The CENTRE is the mode's surface. Pages (Memory, Settings, Portfolio and
 *   the rest) open INSIDE the centre (`ShellScreens`), so both sidebars stay
 *   standing.
 * - The VEX column (`VexSidebar`, docs/design/R3-MINIMAL.md section 5) is
 *   open in chat by default, hidden by default on the table pages and on the
 *   Lighter desk (where it is the right-hand column); the welcome keeps it
 *   (H3-DESKTOP.md section 1.7). Hidden is zero width; the header's Vex key
 *   (the desk's token chip) and Cmd or Ctrl + Shift + B bring her back.
 *
 * `data-vex-shell="true"` scopes the shell tokens; `data-vex-screen="appShell"`
 * stays the e2e/test selector. The Lighter desk keeps R3's one-row frame
 * until its own restyle: no header row, the left sidebar always its rail,
 * and the centre opening with the desk's own title row (`LighterSidebar`,
 * docs/design/R3-MINIMAL.md section 9.3), which carries the title bar's
 * cluster.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from "react";
import { selectVexOpen, useUiStore, vexPageClass, type RuntimeMode } from "../../stores/uiStore.js";
import { useLighterAnalysisStore } from "../../stores/lighterAnalysisStore.js";
import {
  LIGHTER_CHAT_MIN,
  RAIL_WIDTH,
  computeH3ShellColumns,
  computeShellColumns,
  h3GridTemplateColumns,
  h3ShellTier,
  lighterChatDragMax,
  shellColumnOrder,
  shellFrameKind,
  shellGridTemplateRows,
  shellHeadTemplateColumns,
  shellTier,
  type ShellColumnName,
  type ShellColumns,
} from "../../lib/shell-columns.js";
import { SessionCreator } from "./SessionCreator.js";
import { SessionPanel } from "./SessionPanel.js";
import { SessionsList } from "./SessionsList.js";
import { SidebarProfile } from "./SidebarProfile.js";
import { ShellHeader } from "./ShellHeader.js";
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
import {
  ErrorBoundary,
  ErrorBoundaryFallback,
  type ErrorBoundaryAction,
} from "../../components/ui/error-boundary.js";
import { useNetworkOnline } from "../../lib/use-network-online.js";
import { useEngineErrorRetentionSync } from "../../lib/api/engine-errors.js";
import { useInferenceNoticeRetentionSync } from "../../lib/api/inference-notices.js";
import { useUserMcpNotices } from "../../lib/user-mcp-notices.js";
import { usePriceAlertNotices } from "../../lib/api/alerts.js";
import {
  useActivityProgressInvalidation,
  useActivityResolvedInvalidation,
} from "../../lib/api/portfolio.js";
import { ShellDragHandle } from "./ShellDragHandle.js";
import { ShellScreens } from "./screens/ShellScreens.js";
import { LighterCenter } from "./lighterTrading/LighterCenter.js";
import { LighterSidebar } from "./lighterTrading/LighterSidebar.js";
import { AgentLighterSetupHost } from "./lighterTrading/AgentLighterSetupHost.js";
import { VexSidebar } from "../vex/VexSidebar.js";
import { TaglineCell } from "../vex/TaglineCell.js";
import { useVexToggleShortcut } from "../vex/useVexToggleShortcut.js";

import { LockVexControl } from "./LockVexControl.js";

export function AppShell(): JSX.Element {
  return <LockVexControl><AppShellContent /></LockVexControl>;
}

function AppShellContent(): JSX.Element {
  // App-wide engine-error RETENTION. Mounted here, not per session: a wake or
  // compact failure for a session the user is not currently looking at must
  // still be waiting for them when they select it.
  useEngineErrorRetentionSync();
  useInferenceNoticeRetentionSync();
  // F12: a user MCP server changed its tools or stopped answering.
  useUserMcpNotices();
  // F01: a fired price alert raises its notice wherever the user is, and the
  // ones that fired with no window open are shown once on mount.
  usePriceAlertNotices();
  // App-wide activity pushes (settled and progress) refresh the portfolio
  // queries wherever the user is, not only on the Portfolio page. Mounted
  // once, here (the page mounts none of its own), so each push invalidates
  // the portfolio queries once.
  useActivityResolvedInvalidation();
  useActivityProgressInvalidation();
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
 * The centre boundary's way out of a page that throws: close it. Module-level
 * so the array identity is stable across renders; offered only while a page is
 * open (the base surfaces have no page to close).
 */
const CLOSE_PAGE_ACTIONS: readonly ErrorBoundaryAction[] = [
  {
    label: "Close this page",
    onSelect: () => {
      useUiStore.getState().setShellRoute({ kind: "none" });
    },
  },
];
const NO_ACTIONS: readonly ErrorBoundaryAction[] = [];

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
  // The table pages (Portfolio, Board, Settings and the rest): the one place
  // her column itself folds (docs/design/H3-DESKTOP.md section 1.9).
  const tablePage = useUiStore((s) => vexPageClass(s) === "pages");
  const setVexOpen = useUiStore((s) => s.setVexOpen);
  const lighterChatShare = useLighterAnalysisStore((s) => s.desk.chatShare);
  const saveLighterDesk = useLighterAnalysisStore((s) => s.saveDesk);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const shellRouteKind = useUiStore((s) => s.shellRoute.kind);
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

  // Escape in Zen closes Zen's own panels, then Zen, and never Vex
  // (docs/design/H3-DESKTOP.md sections 3.5 and 4.4: Esc never closes her).
  // Her overlay is not Zen's to close: leaving Zen with her open keeps her
  // open, on the desk's own chat column (the desk's stored choice).
  useEffect(() => {
    if (!lighter || !lighterZen) return undefined;
    const onZenKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (zenControlsOpen) {
        setZenControlsOpen(false);
        return;
      }
      if (zenAssistantOpen) setVexOpen(true);
      setZenMode(false);
    };
    window.addEventListener("keydown", onZenKey);
    return () => window.removeEventListener("keydown", onZenKey);
  }, [lighter, lighterZen, setZenMode, setVexOpen, zenAssistantOpen, zenControlsOpen]);

  // THE TIERS. The agent shell and Studio stand on H3's
  // (docs/design/H3-DESKTOP.md sections 1.2 and 4.12): from 1268 up the
  // chats column is the stored choice; from 1024 to 1267 (the medium tier)
  // it starts folded to the 76px rail so the chat keeps 640, and the sidebar
  // key flips the ephemeral override instead of the stored choice; under
  // 1024 (the band) it is the rail, whatever either says. Leaving the medium
  // tier clears the override, so the next entry starts folded again. The
  // Lighter desk keeps R3's tiers; it has no left sidebar of its own, and
  // the same ephemeral flag opens its top bar drawer.
  const tier = lighter ? shellTier(viewport) : h3ShellTier(viewport);
  const overrideTier = !lighter && tier === "medium";
  useEffect(() => {
    if (!lighter && !overrideTier) setSidebarNarrowExpanded(false);
  }, [lighter, overrideTier, setSidebarNarrowExpanded]);
  const leftAsked = overrideTier ? sidebarNarrowExpanded : leftOpen;
  const toggleSidebar = useCallback((): void => {
    if (lighter || overrideTier) setSidebarNarrowExpanded(!sidebarNarrowExpanded);
    else setLeftOpen(!leftOpen);
  }, [lighter, overrideTier, sidebarNarrowExpanded, setSidebarNarrowExpanded, setLeftOpen, leftOpen]);

  // WELCOME stage, per mode: no session (agent), no project (Studio); Lighter
  // has none, the desk is always resident. R3 stood Vex in its centre with no
  // column of hers; H3's welcome keeps her column (docs/design/H3-DESKTOP.md
  // section 1.7), so the stage no longer enters the H3 solve, and only R3's
  // solver still reads it. An open page covers the welcome and is not part
  // of it: the title bar keeps the page's name.
  const pageOpen = useUiStore((s) => s.shellRoute.kind !== "none");
  const welcomeStage = lighter || pageOpen
    ? false
    : studio ? activeProjectId === null : activeSessionId === null;
  const zen = lighter && lighterZen;
  // THE TRACKS. The agent shell and Studio: H3's solve, chats | Vex | chat,
  // the Vex column 30% of the frame, the welcome's included. In a chat its
  // width is a function of the window alone: hiding Vex hides only her plate
  // inside the column (docs/design/H3-DESKTOP.md section 3.6, the money
  // rule), so nothing about her reaches the solve. On a table page hiding her
  // folds the column to the page's strip (section 1.9), the page taking the
  // room. The Lighter desk: R3's solve, its chat share included; a hidden
  // Vex keeps nothing there: her column closes to zero width.
  const h3Cols = lighter
    ? null
    : computeH3ShellColumns({ viewport, chats: leftAsked, vexStrip: tablePage && !vexOpen });
  const cols: ShellColumns =
    h3Cols === null
      ? computeShellColumns({
          viewport,
          mode: runtimeMode,
          left: leftAsked,
          vex: vexOpen,
          welcome: welcomeStage,
          lighterChat: Math.max(1, viewport * lighterChatShare),
          zen,
        })
      : { left: h3Cols.chats, center: h3Cols.chat, vex: h3Cols.vex };
  const colsRef = useRef(cols);
  colsRef.current = cols;
  // Under 1024 Vex is the band under the header, over the chat
  // (docs/design/H3-DESKTOP.md section 1.10): no track of her own, a row.
  const band = h3Cols?.vexSeat === "band";
  // R3's derived auto-close: the stored choice stays `true`, the column
  // collapses. H3 has none, so there Vex is shown exactly when asked: her
  // plate where the column stays, the column itself on a table page.
  const vexEffectiveOpen = !zen && vexOpen && (cols.vex > 0 || band);
  // Whether her column (or the band) stands at all, whatever she shows in it.
  const vexColumnStands = h3Cols === null ? vexEffectiveOpen : cols.vex > 0 || band;
  // THE VEX TOGGLE, as the frame solved it: her section in a chat, the
  // column on a table page, the desk chat's column on the Lighter desk. The
  // Vex key, the desk's token chip and the shortcut all press this one, and
  // it writes the same stored choice as ever. Zen has no column: no toggle.
  const vexToggle = zen
    ? null
    : { open: vexEffectiveOpen, onToggle: () => setVexOpen(!vexEffectiveOpen) };
  // Cmd or Ctrl + Shift + B from anywhere in the shell
  // (docs/design/H3-DESKTOP.md section 4.4), bound here for as long as the
  // shell stands rather than inside a key that may not be mounted.
  useVexToggleShortcut(vexToggle);
  const rail = h3Cols === null ? cols.left <= RAIL_WIDTH : h3Cols.chatsRail;
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
  // The desk keeps its chat on the right (`shellColumnOrder`), so the handle
  // grips the chat's left edge, `viewport - cols.vex` from the frame's left,
  // and a drag to the left (dx < 0) widens it.
  const chatHandle = lighter && vexEffectiveOpen;
  const frameKind = shellFrameKind(runtimeMode);

  const networkOnline = useNetworkOnline();

  // Every track is a LENGTH: the 300ms track transition then only ever
  // interpolates length-to-length (`auto` <-> length is not interpolable and
  // once swept the right column through the centre on the welcome edge).
  const frameStyle: CSSProperties &
    Record<"--vex-vex-track" | "--vex-overlay-left", string> = {
    // chats | Vex | chat (docs/design/H3-DESKTOP.md section 1); the Lighter
    // desk keeps R3's rail | desk | chat.
    gridTemplateColumns:
      h3Cols === null
        ? `${cols.left}px minmax(0, 1fr) ${cols.vex}px`
        : h3GridTemplateColumns(h3Cols),
    // head | body | foot (docs/design/H3-DESKTOP.md section 1.1): the header
    // row holds the header's cells, the bottom row the account cell, the
    // tagline cell and the chat's composer seat (section 1.8). The Lighter
    // desk keeps R3's one-row frame, its title row and account row its own.
    gridTemplateRows: shellGridTemplateRows({ head: !lighter, foot: !lighter, band }),
    // The Lighter desk's title row reserves the caption buttons wherever the
    // right column under them is narrower than they are (lighter-desk.css).
    "--vex-vex-track": `${cols.vex}px`,
    // Where a page starts in the window: where the chat does, past the
    // chats and Vex's column (H3), past the left column (R3). The page itself
    // sits inside the centre (shell.css resets it there); this value is the
    // frame-level box its entrance morph measures against.
    "--vex-overlay-left": `${h3Cols === null ? cols.left : h3Cols.chatLeft}px`,
  };

  // The header's cells over the columns (docs/design/H3-DESKTOP.md section
  // 1.3), on its own grid: the chats cells over the chats track, the Vex key
  // over the Vex column, 30% of the frame even where the body folds the
  // column (the frame solved without the fold), and as wide as the key in
  // the band, which has no Vex column.
  const headVex = computeH3ShellColumns({ viewport, chats: leftAsked }).vex;
  const headColumns = shellHeadTemplateColumns({
    chats: cols.left,
    vex: headVex > 0 ? headVex : null,
    vexBetween: true,
  });

  // The three columns, each keyed so a change of order moves its node and
  // never remounts it, in the order `shellColumnOrder` gives the mode.
  /* TRACK 1 - the left sidebar, the chats column: the sessions sidebar
   * (agent), the projects and explorer (Studio), its rail on the Lighter desk.
   * The column stays overflow-visible so nothing the sidebar opens is
   * cut at its edge. */
  const leftColumn = (
    <div
      key="left"
      className="vex-left-page relative z-20 h-full min-h-0 min-w-0"
      data-vex-area="left-page"
      data-vex-left-page={rail ? "spine" : "page"}
    >
      {/* The rail's paper cap across R3's head row, on the desk only: under
        * the header the rail starts below it. */}
      {rail && lighter ? (
        <div aria-hidden className="vex-left-page__cap vex-drag" />
      ) : null}
      {runtimeMode === "agent" ? (
        <div className="vex-left-page__content">
          <SessionsList
            onCreate={onCreate}
            collapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            // The band keeps the rail whatever is asked: no way to open it.
            expandable={tier !== "band"}
            headless
          />
        </div>
      ) : studio ? (
        <div className="vex-left-page__content">
          <StudioSidebar
            headless
            collapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            // The band keeps the rail: its files open in the rail's drawer.
            expandable={tier !== "band"}
            activeProjectId={activeProjectId}
            onSelectProject={setActiveProjectId}
            onSelectWelcome={() => setActiveProjectId(null)}
          />
        </div>
      ) : cols.left > 0 ? (
        // Lighter keeps the left sidebar on its rail: New chat, Search, the
        // nav and the account. It never opens into the sidebar, so it has
        // no Expand key; the desk's drawer opens from Markets & sessions.
        // Keyed, so the agent sidebar's own state never carries across a
        // mode switch.
        <div key="lighter-rail" className="vex-left-page__content">
          <SessionsList
            onCreate={onCreate}
            collapsed
            expandable={false}
            onToggleSidebar={toggleSidebar}
          />
        </div>
      ) : null}
    </div>
  );

  /* The centre, the chat's column: the mode's surface under the header, and
   * the pages over it inside this column. The last track in the agent shell
   * and Studio, the middle one on the Lighter desk. */
  const centreColumn = (
    <section
      key="centre"
      className="vex-shell-centre relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {/* The Lighter desk's title row: the centre's head row on the desk,
        * with the title bar's cluster portalled into its right end (the
        * header draws no cells there). In Zen it folds to a handle over
        * the chart. */}
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

      {/* G10 - the offline row: only an actual outage renders it. A row of
        * the centre column under its head row (R3-MINIMAL.md section 12,
        * the d3x-offline mockup), so the left sidebar's New chat, Vex's
        * state line and the transcript's top all stay uncovered; a page
        * opened while offline starts under it (overlay.css). */}
      <ConnectionBanner
        reconnecting={!networkOnline}
        label="Offline: waiting for the network to come back"
      />

      {/* The centre's own error boundary (R3-MINIMAL.md section 12): a
        * surface or page that throws is replaced by the recovery card
        * between the two sidebars, which stay standing. The header stays
        * outside it (it owns the approvals live sync). Reset by the mode,
        * the session and the page, so a healthy subject is never blacked
        * out by the one that failed. */}
      <ErrorBoundary
        surface="shell.centre"
        extent="region"
        resetKey={`${runtimeMode}:${activeSessionId ?? ""}:${shellRouteKind}`}
        actions={shellRouteKind === "none" ? NO_ACTIONS : CLOSE_PAGE_ACTIONS}
        fallback={(props) => (
          <div className="min-h-0 flex-1">
            <ErrorBoundaryFallback
              {...props}
              title="Something in Vex stopped rendering"
              extent="region"
            />
          </div>
        )}
      >
        <div className="min-h-0 flex-1">
          {/* In Lighter mode the conversation lives in the right column
           * (`LighterChatRail`), so the center is the desk alone. */}
          {lighter ? (
            <LighterCenter
              zenMode={lighterZen}
              onOpenZenAssistant={openZenAssistant}
            />
          ) : studio ? <StudioCenter /> : <SessionPanel />}
        </div>

        {/* Pages (Memory, Sessions, Settings, Portfolio, Board, Needs you,
          * the money registers): one paper sheet over the centre, absolute
          * inside this column so it never reflows a track. */}
        <ShellScreens />
      </ErrorBoundary>
    </section>
  );

  /* Vex's column: between the chats and the chat (track 2) in the agent
   * shell and Studio, the welcome's included, at the right (track 3) on the
   * Lighter desk; in Lighter's Zen it is the assistant overlay. */
  const vexColumn = (
    <div
      key="vex"
      className="vex-shell-vex lit-zen-assistant relative z-10 h-full min-h-0 min-w-0 overflow-visible"
    >
      {/* Mounted in every session - the sidebar owns its hidden rendering,
       * so a fold never remounts the column. `vexColumnStands` folds the
       * solve into the open flag WITHOUT touching the stored choice, which
       * reaches the plate instead. */}
      <VexSidebar
        open={zen ? zenAssistantOpen : vexColumnStands}
        seat={band ? "band" : "column"}
        // In H3's frame the stored choice shows or hides her plate; her
        // column stays wherever the solve keeps it (a chat), and hiding
        // there keeps focus where it is.
        plate={h3Cols === null || vexOpen}
        stays={h3Cols !== null && !tablePage}
        onHide={() => {
          if (zen) setZenAssistantOpen(false);
          else setVexOpen(false);
        }}
      />
    </div>
  );

  /* THE BOTTOM ROW (docs/design/H3-DESKTOP.md section 1.8), 72 high across
   * the window in H3's frame:
   *   - the ACCOUNT cell under the chats column: the account row
   *     (`SidebarProfile`), moved out of the sidebars, which are headless
   *     here; on the rail, its box alone;
   *   - the TAGLINE cell under the Vex column: the moment's tagline
   *     (`TaglineCell`); 0 wide where her column is;
   *   - the chat's composer seat: the centre runs on into the row, so the
   *     composer ends at the window's foot under the chat (composer.css).
   * Each follows its column in the DOM, so focus reaches a column's foot
   * before the next column. */
  const accountCell = (
    <div
      key="account"
      className="vex-shell-account vex-ls"
      data-vex-area="account-cell"
      data-rail={rail || undefined}
    >
      <footer className="vex-ls-foot" data-rail-foot>
        <SidebarProfile sidebarOpen={!rail} />
      </footer>
    </div>
  );
  const taglineCell = (
    <div key="tagline" className="vex-shell-tagline vex-drag" data-vex-area="tagline-cell">
      {/* The moment's tagline (H3-DESKTOP.md Appendix A.6), from her state. */}
      <TaglineCell />
    </div>
  );

  const columnOf: Readonly<Record<ShellColumnName, readonly JSX.Element[]>> = {
    chats: lighter ? [leftColumn] : [leftColumn, accountCell],
    vex: lighter ? [vexColumn] : [vexColumn, taglineCell],
    chat: [centreColumn],
  };

  return (
    <div
      ref={frameRef}
      className="vex-shell-frame relative z-10 h-full min-w-0 flex-1"
      style={frameStyle}
      data-vex-area="shell-frame"
      // H3's frame (the header row over the columns) in the agent shell and
      // Studio; the Lighter desk keeps R3's until its own restyle.
      data-vex-frame={frameKind}
      // Where Vex is drawn (H3): her column, the band under the header, or a
      // page's strip; the band's row placement keys off it (shell.css).
      data-vex-seat={h3Cols?.vexSeat}
      data-vex-tier={tier}
      data-dragging={dragging || undefined}
      data-vex-sidebar-collapsed={sidebarCollapsed || undefined}
      data-lighter-zen={zen ? "true" : undefined}
      data-lighter-zen-assistant={lighter && zenAssistantOpen ? "open" : undefined}
      data-lighter-zen-controls={zen
        ? zenControlsOpen ? "open" : "closed"
        : undefined}
    >
      {/* THE HEADER, the frame's first child in every mode and layout: it
        * mounts the running head, and with it the approvals live sync, ONCE
        * (`ShellHeader.tsx`). Preload allows one subscriber per event kind
        * per window, so its place in the tree never changes. */}
      <ShellHeader
        runtimeMode={runtimeMode}
        activeSessionId={activeSessionId}
        empty={runtimeMode === "agent" && activeSessionId === null && !pageOpen}
        // The Vex key (the token chip on the Lighter desk) shows and hides
        // Vex as the frame SOLVED her (`vexToggle`); on the desk a column
        // its R3 solve closed reads closed. The welcome has her column too,
        // so the key stands there as well; Zen has no column, no toggle.
        vex={vexToggle}
        columns={headColumns}
        chatsRail={rail}
        onToggleSidebar={toggleSidebar}
      />

      {/* The columns in their order (docs/design/H3-DESKTOP.md section 1):
        * chats | Vex | chat in the agent shell and Studio, each with its
        * bottom row cell after it, so Vex's column comes before the chat in
        * focus order too; the Lighter desk keeps R3's rail | desk | chat
        * until its own restyle. */}
      {shellColumnOrder(runtimeMode).flatMap((name) => columnOf[name])}

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
