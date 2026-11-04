/**
 * THE DESK'S FRAME (the plate's proposal for rows S8-07 and S8-11): H3's
 * shell frame around the Lighter desk.
 *
 *   header (76)   the rail's logo cell | the desk's head cells | MAINNET and
 *                 REAL FUNDS | the Vex key over her column
 *   body          the 76 rail | the desk | Vex's column, 30% of the window
 *   bottom (72)   the rail's account cell | the desk runs on to the foot, as
 *                 a page does (H3 section 1.9) | the desk chat's composer
 *
 * THE SHELL'S OWN PARTS. The frame is the shell's frame element with the
 * shell's classes and attributes, so `shell.css` places and sizes it exactly
 * as `AppShell` does; the logo cell over the rail (`AgentSidebarHeader`),
 * the network cell and the caption reserve (`ChatHeaderCells`), the rail
 * (`SessionsList`, folded), the account cell (`SidebarProfile`) and the drag
 * handle (`ShellDragHandle`) are the real components. The header's columns
 * are the real solver's (`shellHeadTemplateColumns` without `vexBetween`, the
 * template that puts the Vex key over a right-hand Vex column). The Vex key
 * is drawn in its own classes with the plate's state word, because the real
 * key reads her presence from the bridge. The desk's head cells are new.
 *
 * Nothing here is wired: every key presses nothing.
 */

import { useEffect, useState, type JSX, type ReactNode } from "react";
import {
  LineChevronDown,
  LineChevronUp,
  LineMarkets,
  LinePlus,
  LineSvg,
  LineZen,
} from "../../../../components/icons/line/index.js";
import { Keycaps } from "../../../../components/ui/keycaps.js";
import { Swatch } from "../../../../components/ui/swatch.js";
import { AgentSidebarHeader } from "../../../../features/appShell/AgentSidebarHeader.js";
import { ChatHeaderCells } from "../../../../features/appShell/ChatHeaderCells.js";
import { SessionsList } from "../../../../features/appShell/SessionsList.js";
import { ShellDragHandle } from "../../../../features/appShell/ShellDragHandle.js";
import { SidebarProfile } from "../../../../features/appShell/SidebarProfile.js";
import { VEX_TOGGLE_CHORD } from "../../../../features/vex/vex-toggle-shortcut.js";
import {
  H3_COLUMNS_MIN,
  H3_RAIL_WIDTH,
  H3_VEX_PERCENT,
  LIGHTER_CHAT_MAX,
  LIGHTER_CHAT_MIN,
  shellGridTemplateRows,
  shellHeadTemplateColumns,
} from "../../../../lib/shell-columns.js";
import { KIMM_STANDINS } from "../../standins/manifest.js";
import "./lighter-plates.css";

const noop = (): void => undefined;

/** The window's size, as the harness frame is the window. */
export function useWindowSize(): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/** Her column on the desk: 30% of the window, as H3's Vex column (section 1.2). */
export function deskVexWidth(windowWidth: number): number {
  return Math.round((windowWidth * H3_VEX_PERCENT) / 100);
}

export type PlateVexState = "ready" | "awaiting";

const STATE_WORDS: Readonly<Record<PlateVexState, string>> = {
  ready: "Ready",
  awaiting: "Waiting for approval",
};

function FoldGlyph(): JSX.Element {
  return (
    <LineSvg size={20}>
      <path d="M3.5 4h9" />
      <path d="M4 11.5l4-4 4 4" />
    </LineSvg>
  );
}

/**
 * The Vex key in the key's own classes (`VexKey.tsx`, vex-sidebar.css):
 * the fold glyph while her section is open, her face (the stand-in still)
 * while it is closed; the state square and word; the action and its keycaps;
 * the chevron.
 */
function PlateVexKey({ open, state }: { readonly open: boolean; readonly state: PlateVexState }): JSX.Element {
  const name = open ? "Hide Vex" : "Show Vex";
  return (
    <button
      type="button"
      className="vex-key"
      data-vex-area="vex-key"
      data-vex-state={state}
      data-vex-key-open={open ? "true" : "false"}
      aria-label={name}
      aria-expanded={open}
    >
      <span className="vex-key__portrait" data-open={open ? "" : undefined}>
        {open ? (
          <FoldGlyph />
        ) : (
          <img className="lp-key-face" src={KIMM_STANDINS.portraits.offer.src} alt="" draggable={false} />
        )}
      </span>
      <span className="vex-key__state">
        <span className="vex-key__line vex-key__status">
          <Swatch state={state === "ready" ? "idle" : "done"} size={6} className="vex-key__square" />
          <span className="vex-key__word">{STATE_WORDS[state]}</span>
        </span>
        <span className="vex-key__line vex-key__action">
          <span className="vex-key__name">{name}</span>
          <Keycaps chord={VEX_TOGGLE_CHORD} decorative />
        </span>
      </span>
      <span className="vex-key__chevron">{open ? <LineChevronUp size={16} /> : <LineChevronDown size={16} />}</span>
    </button>
  );
}

/**
 * The desk's head cells, in the header's title area: where you are
 * ("Lighter", and the section and deployment under it, as a chat's title
 * carries its kind), then the desk's two keys as icon cells, as the sidebar
 * key is one: Markets and sessions (the desk's drawer) and Zen.
 */
function DeskHeadCells(): JSX.Element {
  return (
    <div data-vex-head-cell="title" className="lp-head vex-drag">
      <span className="lp-head__title">
        <span className="lp-head__name">Lighter</span>
        <span className="lp-head__sub">Perps · Lighter Core</span>
      </span>
      <button type="button" className="lp-head__key" aria-label="Markets and sessions" title="Markets and sessions">
        <LineMarkets size={16} />
      </button>
      <button
        type="button"
        className="lp-head__key lp-shed-band"
        aria-label="New desk session"
        title="New desk session"
      >
        <LinePlus size={16} />
      </button>
      <button type="button" className="lp-head__key" aria-label="Enter Zen" title="Zen: the chart in the whole window">
        <LineZen size={16} />
      </button>
    </div>
  );
}

export function DeskFrame({ vexOpen, vexState, desk, vex, reviewing = false, handle = true }: {
  readonly vexOpen: boolean;
  readonly vexState: PlateVexState;
  readonly desk: ReactNode;
  readonly vex: ReactNode;
  /** A desk review waits in the ticket's place. */
  readonly reviewing?: boolean;
  /** Draw the drag between the desk and her column. */
  readonly handle?: boolean;
}): JSX.Element {
  const { width } = useWindowSize();
  const band = width < H3_COLUMNS_MIN;
  const vexWidth = deskVexWidth(width);
  const headColumns = shellHeadTemplateColumns({ chats: H3_RAIL_WIDTH, vex: vexWidth, vexBetween: false });
  return (
    <main
      className="relative isolate flex h-screen w-screen overflow-hidden bg-[var(--vex-surface-0)] text-foreground"
      data-vex-shell="true"
      data-vex-theme="chronos"
      data-vex-runtime-mode="lighter"
    >
      <div
        className="vex-shell-frame lp relative z-10 h-full min-w-0 flex-1"
        data-vex-area="shell-frame"
        data-vex-frame="h3"
        data-vex-seat="column"
        data-vex-tier={band ? "band" : "wide"}
        data-vex-sidebar-collapsed="true"
        data-lp-band={band ? "" : undefined}
        data-lp-reviewing={reviewing ? "" : undefined}
        style={{
          gridTemplateColumns: `${String(H3_RAIL_WIDTH)}px minmax(0, 1fr) ${String(vexWidth)}px`,
          gridTemplateRows: shellGridTemplateRows({ head: true, foot: true }),
        }}
      >
        <header className="vex-shell-head vex-drag" data-vex-area="shell-head" style={{ gridTemplateColumns: headColumns }}>
          <AgentSidebarHeader rail onCollapse={noop} />
          <DeskHeadCells />
          <ChatHeaderCells />
          <div data-vex-head-cell="vex-key" className="vex-shell-head__vex vex-drag">
            <PlateVexKey open={vexOpen} state={vexState} />
          </div>
        </header>
        <div
          className="vex-left-page relative z-20 h-full min-h-0 min-w-0"
          data-vex-area="left-page"
          data-vex-left-page="spine"
        >
          <div className="vex-left-page__content">
            <SessionsList onCreate={noop} collapsed onToggleSidebar={noop} expandable={!band} headless />
          </div>
        </div>
        <div className="vex-shell-account vex-ls" data-vex-area="account-cell" data-rail="true">
          <footer className="vex-ls-foot" data-rail-foot>
            <SidebarProfile sidebarOpen={false} />
          </footer>
        </div>
        {desk}
        {vex}
        {handle ? (
          <ShellDragHandle
            left={width - vexWidth}
            label="Resize the desk chat"
            value={vexWidth}
            min={LIGHTER_CHAT_MIN}
            max={LIGHTER_CHAT_MAX}
            onStart={noop}
            onDrag={noop}
            onEnd={noop}
          />
        ) : null}
      </div>
    </main>
  );
}
