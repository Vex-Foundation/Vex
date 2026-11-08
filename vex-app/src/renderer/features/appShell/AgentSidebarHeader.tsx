/**
 * THE LOGO CELL AND THE SIDEBAR KEY: the header's cells over the chats column
 * (docs/design/H3-DESKTOP.md section 1.3), drawn by the frame's one header
 * (`ShellHeader`) for the agent shell and Studio alike.
 *
 * Open, at 1440 (measured in `h3-merged__welcome-closed-1440`), two cells
 * divided by a rule:
 *   - LOGO, 0 to 171: the vx mark, 34 x 27 in ink (VEX Cloud's `.hd-home svg`), set 24 in from the cell's
 *     edge as every cell's content is (section 2.4). Desktop draws the mark
 *     alone: H3's "CLOUD" beside it is Cloud's name (Appendix A.1). On macOS
 *     the traffic lights stand in this cell, 12px circles from x 20 to 72
 *     centred on the 76 row at y 32 (section 4.7, `TRAFFIC_LIGHT_POSITION`),
 *     so the mark starts after them, at 92;
 *   - SIDEBAR KEY, 171 to 248: the panel icon in ink, centred in a 76 x 76
 *     key that is the whole cell. It folds the chats column to the rail.
 * The chats cell ends in the column's own rule, so the column's right edge
 * runs up through the header.
 *
 * Over the rail (76 wide) the logo cell stands alone and the rail's own
 * Expand key is the way back. On macOS the lights fill that cell, so the mark
 * is not drawn there; on Windows and Linux the mark stands centred.
 *
 * Every cell is a window drag region (`.vex-drag`); the mark, once it is a
 * button (Back to welcome, with a chat open), and the key opt out.
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
  label = "Collapse sidebar",
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
          <SidebarHomeSigil sidebarOpen={false} cell />
        </div>
      </div>
    );
  }
  return (
    <div data-vex-head-cell="chats" className="vex-ls-head vex-drag vex-lights-start">
      <div data-vex-head-cell="logo" className="vex-shell-head__logo">
        <SidebarHomeSigil sidebarOpen cell />
      </div>
      <div data-vex-head-cell="sidebar-key" className="vex-shell-head__key">
        <Tooltip label="Collapse sidebar" side="bottom">
          <button
            type="button"
            aria-label={label}
            aria-expanded
            onClick={onCollapse}
            className="vex-ls-ikey vex-ls-hkey"
          >
            <LinePanelLeft />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
