/**
 * Sidebar brand + home control: a small STATIC logo mark crowns the rail
 * header as the sole brand (no "VEX" wordmark): the vx script monogram as
 * inline SVG on currentColor, so it reads in both themes. No canvas, no
 * animation.
 *
 * Doubles as the "Back to welcome" control. When a session is open the mark
 * is a real button that clears the active session and returns the panel to
 * the welcome stage. On the welcome stage itself (no active session: the
 * center panel is always the session panel since the Chronos screens
 * redesign) there is nowhere to navigate to, so it renders as an inert
 * decorative mark: the button semantics only exist when the action does
 * something.
 */

import type { JSX } from "react";
import { VexMark } from "../../components/common/VexMark.js";
import { useUiStore } from "../../stores/uiStore.js";

export function SidebarHomeSigil({
  sidebarOpen,
}: {
  readonly sidebarOpen: boolean;
}): JSX.Element {
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);

  // Already on the welcome stage → the mark is inert, not a button.
  const onWelcome = activeSessionId === null;

  // Height-driven size; width flows from the mark's native aspect: 30 x 24
  // in the left page's mast (docs/design/V10-SPREAD.md section 3), 20 high
  // in a collapsed rail.
  const mark = (
    <span data-vex-home-mark className="select-none text-brand-mark">
      <VexMark size={sidebarOpen ? 24 : 20} />
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
