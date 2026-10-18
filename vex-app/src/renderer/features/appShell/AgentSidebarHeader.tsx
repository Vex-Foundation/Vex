/**
 * THE LEFT SIDEBAR'S HEAD ROW (docs/design/R3-MINIMAL.md sections 2.2 and 4):
 * 44 high with a quiet rule under it, the vx wordmark (30 wide, blue) at the
 * left and the collapse key (32 x 32, the panel icon) at the right. On macOS
 * the content starts at 92, clear of the traffic lights; on Windows and Linux
 * at 16. The row is a window drag region; the mark and the key opt out.
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
}: {
  readonly onCollapse: () => void;
}): JSX.Element {
  return (
    <header className="vex-ls-head vex-drag vex-lights-start">
      <SidebarHomeSigil sidebarOpen />
      <Tooltip label="Collapse sidebar" side="bottom">
        <button
          type="button"
          aria-label="Collapse sessions sidebar"
          aria-expanded
          onClick={onCollapse}
          className="vex-ls-ikey"
        >
          <LinePanelLeft />
        </button>
      </Tooltip>
    </header>
  );
}
