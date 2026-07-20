/**
 * Sidebar brand + home control — a small STATIC logo mark crowns the rail
 * header as the sole brand (no "VEX" wordmark). The particle-constellation
 * sigil broke down at rail size, so this is the clean mark the rail carried
 * originally: the script monogram (`/logo_clean.png`) in the Vex theme, the
 * white Robinhood feather (`/logo/robinhood.svg`) in the Robinhood theme —
 * a plain <img> swap by theme, no canvas, no animation.
 *
 * Doubles as the "Back to welcome" control. When a session is open — or the
 * panel is showing a sub-view (library / memory) — the mark is a real button
 * that clears the active session and returns the panel to the welcome stage.
 * On the welcome stage itself (no session AND the default session view) there
 * is nowhere to navigate to, so it renders as an inert decorative mark: the
 * button semantics only exist when the action does something.
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useBrandMarkSrc } from "./brandMark.js";

export function SidebarHomeSigil({
  sidebarOpen,
}: {
  readonly sidebarOpen: boolean;
}): JSX.Element {
  const src = useBrandMarkSrc();
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const appShellView = useUiStore((s) => s.appShellView);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const setAppShellView = useUiStore((s) => s.setAppShellView);

  // Already on the welcome stage → the mark is inert, not a button.
  const onWelcome = activeSessionId === null && appShellView === "session";

  // Height-driven size; width flows from each mark's own aspect. A light rail
  // crown (~24px open / ~20px collapsed), not a billboard.
  const sizeClass = sidebarOpen ? "h-6" : "h-5";

  const mark = (
    <img
      src={src}
      alt=""
      aria-hidden
      data-vex-home-mark
      className={cn("w-auto select-none object-contain", sizeClass)}
    />
  );

  if (onWelcome) {
    return <div className="flex items-center justify-center">{mark}</div>;
  }

  return (
    <button
      type="button"
      aria-label="Back to welcome"
      onClick={() => {
        setActiveSessionId(null);
        setAppShellView("session");
      }}
      className={cn(
        "flex items-center justify-center rounded-xl p-1 transition-colors",
        "hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--vex-surface-1)]",
      )}
    >
      {mark}
    </button>
  );
}
