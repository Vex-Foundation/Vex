/**
 * THE LOGO CELL AND THE SIDEBAR KEY: the header's cells over the chats column
 * (docs/design/H3-DESKTOP.md section 1.3), drawn by the frame's one header
 * (`ShellHeader`) for the agent shell and Studio alike. Open, the vx wordmark
 * (30 wide, blue) at the left and the collapse key (32 x 32, the panel icon)
 * at the right; over the rail, the mark alone, centred, and the rail's own
 * Expand key is the way back. On macOS the open cell starts its content at
 * 92, clear of the traffic lights, and over the rail the lights take the
 * whole cell, so the mark is not drawn there; on Windows and Linux the
 * content starts at 16. The cell is a window drag region; the mark and the
 * key opt out.
 *
 * Still R3's mark and key, moved up from the sidebar's own head row, which
 * the header replaces; the H3 cells themselves are the left column's slice.
 *
 * The way into Studio is no longer a capsule in this row: the sidebar's nav
 * carries Studio (and Lighter) as rows, open and on the rail alike.
 */

import type { JSX } from "react";
import { LinePanelLeft } from "../../components/icons/line/index.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { SidebarHomeSigil } from "./SidebarHomeSigil.js";

export function AgentSidebarHeader({
  onCollapse,
  rail = false,
  label = "Collapse sessions sidebar",
}: {
  readonly onCollapse: () => void;
  /** The chats column is its rail: the logo cell stands alone. */
  readonly rail?: boolean;
  /** The collapse key's name; Studio names its own sidebar. */
  readonly label?: string;
}): JSX.Element {
  if (rail) {
    return (
      <div data-vex-head-cell="chats" className="vex-shell-head__rail vex-drag" data-rail>
        <div data-vex-head-cell="logo" className="vex-shell-head__logo">
          <SidebarHomeSigil sidebarOpen={false} />
        </div>
      </div>
    );
  }
  return (
    <div data-vex-head-cell="chats" className="vex-ls-head vex-drag vex-lights-start">
      <div data-vex-head-cell="logo" className="vex-shell-head__logo">
        <SidebarHomeSigil sidebarOpen />
      </div>
      <div data-vex-head-cell="sidebar-key" className="vex-shell-head__key">
        <Tooltip label="Collapse sidebar" side="bottom">
          <button
            type="button"
            aria-label={label}
            aria-expanded
            onClick={onCollapse}
            className="vex-ls-ikey"
          >
            <LinePanelLeft />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
