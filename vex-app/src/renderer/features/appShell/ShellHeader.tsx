/**
 * THE HEADER (docs/design/H3-DESKTOP.md sections 1.3 and 6.2): one row of
 * cells across the window, over all three columns, and the window's drag
 * region. Its own grid (`shellHeadTemplateColumns`) names each cell; in D2's
 * order, left to right and in the DOM:
 *
 *   header.vex-shell-head[data-vex-area="shell-head"]
 *     [data-vex-head-cell="chats"]     over the chats column: the logo cell
 *                                      (the vx mark) and the sidebar key, or
 *                                      the logo cell alone over the rail
 *                                      (`AgentSidebarHeader`)
 *     RunningHead, mounted ONCE:
 *       [data-vex-head-cell="title"]   over the chat: the title, the mission
 *                                      badge and the title bar's cluster
 *     [data-vex-head-cell="needs"]     NEEDS YOU and its count; a press opens
 *                                      the Needs you page and never decides
 *                                      (`NeedsYouHeadCell`)
 *     ChatHeaderCells, the chat's cells after it:
 *       [data-vex-head-cell="funds"]   the static network statement: Mainnet
 *                                      and the Real funds mark, never a menu
 *                                      (desktop is mainnet only, section 4.2)
 *       [data-vex-head-cell="caption-reserve"]
 *                                      the Windows and Linux caption buttons'
 *                                      reserve, `--overlay-w` wide, at the
 *                                      window's top right
 *     [data-vex-head-cell="vex-key"]   over Vex's column at the right edge:
 *                                      VEX and its 44 hide or show key
 *                                      (`VexHeadCell`), which replaced H3's
 *                                      Vex key; it shares the column with the
 *                                      caption reserve
 *
 * Every cell that is not a control is a window drag region (`.vex-drag`);
 * each control inside opts out on its own (window-chrome.css).
 *
 * MOUNTED ONCE, for the reason `RunningHead.tsx` states: it hosts
 * `GlobalApprovalsSync`, and preload allows one subscriber per event kind per
 * window. The frame renders this header first in every mode and every
 * layout, and the header renders `RunningHead` at one tree position whatever
 * else it draws (each slot around it renders in every mode, empty where it
 * has nothing), so neither a mode switch, the welcome edge nor a change of
 * layout mounts a second head or remounts the one there is
 * (`ShellHeader.test.tsx`).
 *
 * THE LIGHTER DESK (docs/design/H3-DESKTOP.md section 4.9, the approved desk
 * plate) has the same row with its own cells and keeps H3's Vex key at the
 * right end over her column:
 *
 *     [data-vex-head-cell="chats"]     the logo cell over the rail
 *     [data-vex-head-cell="title"]     the desk's head (`deskHead`, the
 *                                      desk's `LighterSidebar`): "Lighter"
 *                                      over the section and deployment, then
 *                                      its three icon keys; the running
 *                                      head's cluster after the words
 *     [data-vex-head-cell="funds"]     Mainnet and Real funds, no chevron
 *     [data-vex-head-cell="caption-reserve"]
 *     [data-vex-head-cell="vex-key"]   H3's Vex key (`VexKey`) over her
 *                                      column, which on Windows and Linux
 *                                      shares the column with the caption
 *                                      reserve at its top right
 *
 * Exit Lighter is not in the row: the nav is the way out. The desk's plate
 * has no Needs you header control; its console carries it.
 */

import type { CSSProperties, JSX, ReactNode } from "react";
import type { RuntimeMode } from "../../stores/uiStore.js";
import { NeedsYouHeadCell } from "../vex/NeedsYouHeadCell.js";
import { VexHeadCell } from "../vex/VexHeadCell.js";
import { VexKey } from "../vex/VexKey.js";
import { AgentSidebarHeader } from "./AgentSidebarHeader.js";
import { ChatHeaderCells } from "./ChatHeaderCells.js";
import { RunningHead, type VexToggle } from "./RunningHead.js";
import { STUDIO_SIDEBAR_COLLAPSE_LABEL } from "./studio/studio-copy.js";

export interface ShellHeaderProps {
  readonly runtimeMode: RuntimeMode;
  readonly activeSessionId: string | null;
  /** The welcome stage: the title cell has nothing to say. */
  readonly empty: boolean;
  /** The Vex toggle as the frame solved it; null where there is none. */
  readonly vex: VexToggle | null;
  /** The header's column template (`shellHeadTemplateColumns`). */
  readonly columns: string;
  /** The chats column under it is its rail: the logo cell stands alone. */
  readonly chatsRail: boolean;
  /** The sidebar key: fold or unfold the chats column. */
  readonly onToggleSidebar: () => void;
  /** The Lighter desk's head cells, drawn in the title cell on the desk. */
  readonly deskHead?: ReactNode;
}

/** The sidebar key's name in each mode that has one. */
function collapseLabel(runtimeMode: RuntimeMode): string {
  return runtimeMode === "studio" ? STUDIO_SIDEBAR_COLLAPSE_LABEL : "Collapse sidebar";
}

export function ShellHeader({
  runtimeMode,
  activeSessionId,
  empty,
  vex,
  columns,
  chatsRail,
  onToggleSidebar,
  deskHead = null,
}: ShellHeaderProps): JSX.Element {
  const style: CSSProperties = { gridTemplateColumns: columns };
  const desk = runtimeMode === "lighter";
  return (
    <header className="vex-shell-head vex-drag" data-vex-area="shell-head" style={style}>
      <AgentSidebarHeader
        rail={chatsRail}
        label={collapseLabel(runtimeMode)}
        onCollapse={onToggleSidebar}
      />
      <RunningHead
        runtimeMode={runtimeMode}
        activeSessionId={activeSessionId}
        empty={empty}
        vex={vex}
        deskHead={deskHead}
      />
      {/* Needs you, the shell's (section 6.2); the desk's plate has none. */}
      {desk ? null : <NeedsYouHeadCell />}
      <ChatHeaderCells />
      {/* The cell over Vex's column (sections 1.6 and 6.2): D2's VEX cell in
        * the shell, H3's Vex key on the desk, or nothing where the frame has
        * no Vex to toggle (Zen). Always this slot, last, so the running head
        * before it keeps its place in the tree. */}
      <div data-vex-head-cell="vex-key" className="vex-shell-head__vex vex-drag">
        {vex === null ? null : desk ? (
          <VexKey open={vex.open} onToggle={vex.onToggle} held={vex.held ?? null} />
        ) : (
          <VexHeadCell open={vex.open} onToggle={vex.onToggle} held={vex.held ?? null} />
        )}
      </div>
    </header>
  );
}
