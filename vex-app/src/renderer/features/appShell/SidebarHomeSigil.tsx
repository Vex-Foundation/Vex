/**
 * Sidebar brand + home control: the vx wordmark crowns the chats column as
 * the sole brand (no "VEX" text): the vx script monogram as inline SVG in the
 * accent, which H3 sets in ink. No canvas, no animation.
 *
 * Three sizes, by where the mark stands:
 *   - the header's LOGO CELL (docs/design/H3-DESKTOP.md section 1.3), over
 *     the chats column and over its rail alike: 27 high, so 34 wide, VEX
 *     Cloud's header mark (`.hd-home svg`, 34 x 27, the H3 mockup's app.css);
 *     Desktop draws the mark alone where H3 writes "CLOUD" beside it
 *     (Appendix A.1);
 *   - R3's open head row, where a sidebar still draws its own (Studio's
 *     standalone mount): 24 high, 30 wide (docs/design/R3-MINIMAL.md
 *     section 4);
 *   - R3's rail cap (the Lighter desk's rail): 20 high.
 *
 * Doubles as the "Back to welcome" control. When a session is open the mark
 * is a real button that clears the active session and returns the panel to
 * the welcome stage. On the welcome stage itself (no active session) there is
 * nowhere to navigate to, so it renders as an inert decorative mark: the
 * button semantics only exist when the action does something.
 */

import type { JSX } from "react";
import { VexMark } from "../../components/common/VexMark.js";
import { useUiStore } from "../../stores/uiStore.js";

/** The mark's height in the header's logo cell, open or over the rail. */
export const LOGO_CELL_MARK_SIZE = 27;

export function SidebarHomeSigil({
  sidebarOpen,
  cell = false,
}: {
  readonly sidebarOpen: boolean;
  /** The mark stands in the header's logo cell: H3's size, open or rail. */
  readonly cell?: boolean;
}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);

  // Already on the welcome stage → the mark is inert, not a button.
  const onWelcome = activeSessionId === null;

  // Height-driven size; width flows from the mark's native aspect (5:4):
  // 34 x 27 in the logo cell, 30 x 24 in R3's open head, 20 high on its rail.
  const size = cell ? LOGO_CELL_MARK_SIZE : sidebarOpen ? 24 : 20;
  const mark = (
    <span data-vex-home-mark className="select-none text-accent-primary">
      <VexMark size={size} />
    </span>
  );

  if (onWelcome) {
    return <div className="flex items-center justify-center">{mark}</div>;
  }

  return (
    <button
      type="button"
      aria-label="Back to welcome"
      onClick={() => setActiveSessionId(null)}
      className="flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--vex-alias-focus)]"
    >
      {mark}
    </button>
  );
}
