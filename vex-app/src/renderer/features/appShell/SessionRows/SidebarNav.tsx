/**
 * THE LEFT SIDEBAR'S NAV (docs/design/R3-MINIMAL.md section 4): Chat,
 * Missions, Portfolio, Board, Watchlist, Lighter, Studio, Settings. Each row is 34 high
 * with a 16px line icon in ink 2, gap 11, 14 type; the selected row takes the
 * selection wash, blue type, weight 500 and a blue icon. On the 56px rail the
 * rows are 40 x 40 keys, icon only, with the name as the tooltip and the
 * accessible name.
 *
 * One `navigate(destination)` store action backs every row, so the nav adds no
 * state of its own; the selected row follows the real destination
 * (`selectNavDestination`): the open page first (a page with no row of its
 * own, Memory or Sessions, selects none), then the mode, and Missions for a
 * mission chat. Missions also opens the sidebar's search on its Mission tab
 * (the owner's `onMissions`), and Chat and Missions both tell the owner to
 * show their list (`onSessionList`): on the rail the list is out of sight, so
 * a press there that only moved the filter looked like nothing. Lighter enters the desk through
 * its own command, so the desk entry is the same from every door.
 *
 * `NavKey` is the one row or key shape, shared with New chat and Search.
 */

import type { JSX, ReactNode } from "react";
import {
  LineBoard,
  LineChat,
  LineLighter,
  LineMissions,
  LinePortfolio,
  LineSettings,
  LineStudio,
  LineWatchlist,
  type LineIconComponent,
} from "../../../components/icons/line/index.js";
import { Tooltip } from "../../../components/ui/tooltip.js";
import { cn } from "../../../lib/utils.js";
import {
  selectNavDestination,
  useUiStore,
  type NavDestination,
} from "../../../stores/uiStore.js";
import { enterLighterMode } from "../lighterTrading/workspace-command.js";

const NAV_ROWS: readonly {
  readonly destination: NavDestination;
  readonly label: string;
  readonly Icon: LineIconComponent;
}[] = [
  { destination: "chat", label: "Chat", Icon: LineChat },
  { destination: "missions", label: "Missions", Icon: LineMissions },
  { destination: "portfolio", label: "Portfolio", Icon: LinePortfolio },
  { destination: "board", label: "Board", Icon: LineBoard },
  { destination: "watchlist", label: "Watchlist", Icon: LineWatchlist },
  { destination: "lighter", label: "Lighter", Icon: LineLighter },
  { destination: "studio", label: "Studio", Icon: LineStudio },
  { destination: "settings", label: "Settings", Icon: LineSettings },
];

/** One nav row (open sidebar) or key (rail). */
export function NavKey({
  icon,
  label,
  rail,
  onClick,
  current = false,
  ariaLabel,
  ariaCurrent = "page",
  className,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly rail: boolean;
  readonly onClick: (target: HTMLButtonElement) => void;
  readonly current?: boolean;
  /** The accessible name when it says more than the visible word. */
  readonly ariaLabel?: string;
  readonly ariaCurrent?: "page" | "true";
  readonly className?: string;
  /** Extra marks inside the row (New chat's signing stroke). */
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <Tooltip label={label} disabled={!rail}>
      <button
        type="button"
        onClick={(event) => onClick(event.currentTarget)}
        aria-label={ariaLabel ?? (rail ? label : undefined)}
        aria-current={current ? ariaCurrent : undefined}
        data-selected={current || undefined}
        className={cn("vex-ls-nrow", className)}
      >
        {icon}
        {rail ? null : <span className="vex-ls-nrow__label">{label}</span>}
        {children}
      </button>
    </Tooltip>
  );
}

function originOf(target: HTMLButtonElement): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const r = target.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function SidebarNav({
  rail,
  onMissions,
  onSessionList,
  activeSessionMode = null,
}: {
  readonly rail: boolean;
  /** Missions opens the sidebar's search on its Mission tab. */
  readonly onMissions: () => void;
  /** Chat and Missions: show the session list they filter. */
  readonly onSessionList?: () => void;
  /**
   * The mode of the chat in view, when the caller has the session rows: a
   * mission chat selects Missions. `null` (a desk, an unknown session) leaves
   * the Mission tab to decide.
   */
  readonly activeSessionMode?: "agent" | "mission" | null;
}): JSX.Element {
  const selected = useUiStore((s) => selectNavDestination(s, activeSessionMode));
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const navigate = useUiStore((s) => s.navigate);

  const go = (destination: NavDestination, target: HTMLButtonElement): void => {
    if (destination === "lighter" && runtimeMode !== "lighter") enterLighterMode();
    navigate(destination, originOf(target));
    if (destination === "missions") onMissions();
    if (destination === "chat" || destination === "missions") onSessionList?.();
  };

  return (
    <nav aria-label="Main" className="vex-ls-nav">
      <ul className="vex-ls-nav__list">
        {NAV_ROWS.map(({ destination, label, Icon }) => (
          <li key={destination}>
            <NavKey
              icon={<Icon className="vex-ls-nrow__i" />}
              label={label}
              rail={rail}
              current={selected === destination}
              onClick={(target) => go(destination, target)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}
