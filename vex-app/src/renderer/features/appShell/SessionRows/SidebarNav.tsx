/**
 * THE CHATS COLUMN'S NAV (docs/design/H3-DESKTOP.md sections 1.4 and 4.6):
 * Chat, Missions, Watchlist, Portfolio, Agent Scan, Lighter, Studio, Board,
 * Settings. H3 draws seven rows (Chat, Strategies, Missions, Markets,
 * Portfolio, Activity, Settings); desktop has no Strategies until F11, and it
 * keeps its own page names where H3 has others (the owner's decision of 4
 * November 2026): H3's Markets is desktop's Watchlist, and H3's Activity is
 * desktop's Agent Scan, which joins the nav here (Portfolio's activity card
 * and the profile menu still open it too). Lighter, Studio and Board are
 * desktop's own, set among H3's in the order the plan's decision 10 gives.
 *
 * The icons are H3's nav glyphs redrawn in the line family (the `h3-` names,
 * `components/icons/line/line-glyphs.tsx`: the bubble, the cube, the rising
 * bars, the case, the ticked list, the cog); Lighter, Studio and Board keep
 * their own line drawings, in the same grid and stroke (section 4.6).
 *
 * Each row is an H3 cell on the 40 pitch, edge to edge: the icon in muted, its
 * word in caps (14, tracked, ink) at 58. The selected row takes H3's one row
 * gradient, `--vex-alias-row-selected` (#181A1C at the column's left edge,
 * fading to the ground at its right), and its icon turns ink. The block
 * stands between two rules, the one under Search chats and its own. On the
 * rail the rows are keys, icon only, with the name as the tooltip and the
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
  LineH3Activity,
  LineH3Chat,
  LineH3Markets,
  LineH3Missions,
  LineH3Portfolio,
  LineH3Settings,
  LineLighter,
  LineStudio,
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
  { destination: "chat", label: "Chat", Icon: LineH3Chat },
  { destination: "missions", label: "Missions", Icon: LineH3Missions },
  // H3's Markets row, under desktop's name, with H3's glyph.
  { destination: "watchlist", label: "Watchlist", Icon: LineH3Markets },
  { destination: "portfolio", label: "Portfolio", Icon: LineH3Portfolio },
  // H3's Activity row, under desktop's name: Agent Scan's full feed.
  { destination: "agentScan", label: "Agent Scan", Icon: LineH3Activity },
  // Desktop's own three: their line drawings share H3's grid and stroke.
  { destination: "lighter", label: "Lighter", Icon: LineLighter },
  { destination: "studio", label: "Studio", Icon: LineStudio },
  { destination: "board", label: "Board", Icon: LineBoard },
  { destination: "settings", label: "Settings", Icon: LineH3Settings },
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
              className="vex-ls-nrow--nav"
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}
