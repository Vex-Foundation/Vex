/**
 * THE HEADER (docs/design/H3-DESKTOP.md section 1.3): one row of cells across
 * the window, over all three columns, and the window's drag region. Its own
 * grid (`shellHeadTemplateColumns`) names each cell:
 *
 *   header.vex-shell-head[data-vex-area="shell-head"]
 *     [data-vex-head-cell="chats"]     over the chats column: the logo cell
 *                                      (the vx mark) and the sidebar key, or
 *                                      the logo cell alone over the rail
 *                                      (`AgentSidebarHeader`)
 *     [data-vex-head-cell="vex-key"]   over the Vex column: the Vex key
 *                                      (`VexKey`, section 1.6), which opens
 *                                      and closes her section
 *     RunningHead, mounted ONCE:
 *       [data-vex-head-cell="title"]   over the chat: the title, the mission
 *                                      badge and the title bar's cluster
 *     ChatHeaderCells, the chat's cells after its title:
 *       [data-vex-head-cell="funds"]   the static network statement: Mainnet
 *                                      and the Real funds mark, never a menu
 *                                      (desktop is mainnet only, section 4.2)
 *       [data-vex-head-cell="caption-reserve"]
 *                                      the Windows and Linux caption buttons'
 *                                      reserve, `--overlay-w` wide, where H3
 *                                      draws PAUSE ALL
 *
 * Every cell that is not a control is a window drag region (`.vex-drag`);
 * each control inside opts out on its own (window-chrome.css).
 *
 * MOUNTED ONCE, for the reason `RunningHead.tsx` states: it hosts
 * `GlobalApprovalsSync`, and preload allows one subscriber per event kind per
 * window. The frame renders this header first in every mode and every
 * layout, and the header renders `RunningHead` at one tree position whatever
 * else it draws, so neither a mode switch, the welcome edge nor a change of
 * layout mounts a second head or remounts the one there is
 * (`ShellHeader.test.tsx`).
 *
 * The Lighter desk keeps R3's frame until its own restyle: the desk's title
 * row is its title bar and the cluster rides there through a portal, so on
 * the desk this element has no box (`contents`) and draws no cell; only the
 * head's services stay mounted.
 */

import type { CSSProperties, JSX } from "react";
import type { RuntimeMode } from "../../stores/uiStore.js";
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
}

/** The sidebar key's name in each mode that has one. */
function collapseLabel(runtimeMode: RuntimeMode): string {
  return runtimeMode === "studio" ? STUDIO_SIDEBAR_COLLAPSE_LABEL : "Collapse sessions sidebar";
}

export function ShellHeader({
  runtimeMode,
  activeSessionId,
  empty,
  vex,
  columns,
  chatsRail,
  onToggleSidebar,
}: ShellHeaderProps): JSX.Element {
  const lighter = runtimeMode === "lighter";
  const style: CSSProperties | undefined = lighter ? undefined : { gridTemplateColumns: columns };
  return (
    <header
      className={lighter ? "contents" : "vex-shell-head vex-drag"}
      data-vex-area="shell-head"
      style={style}
    >
      {lighter ? null : (
        <AgentSidebarHeader
          rail={chatsRail}
          label={collapseLabel(runtimeMode)}
          onCollapse={onToggleSidebar}
        />
      )}
      {/* The Vex key's cell, over the Vex column (section 1.6): the key, or
        * nothing where the frame has no Vex to toggle. Always this slot, so
        * the running head after it keeps its place in the tree. */}
      {lighter ? null : (
        <div data-vex-head-cell="vex-key" className="vex-shell-head__vex vex-drag">
          {vex === null ? null : <VexKey open={vex.open} onToggle={vex.onToggle} />}
        </div>
      )}
      <RunningHead
        runtimeMode={runtimeMode}
        activeSessionId={activeSessionId}
        empty={empty}
        vex={vex}
      />
      {lighter ? null : <ChatHeaderCells />}
    </header>
  );
}
