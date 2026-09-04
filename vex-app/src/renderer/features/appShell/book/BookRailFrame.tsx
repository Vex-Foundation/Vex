/**
 * THE BOOK RAIL'S CHROME - the floating right-edge aside and its collapse
 * header, shared by the agent rail and the Studio rail.
 *
 * Chrome only. It owns no sections, no registry, no query and no tab: the two
 * rails put entirely different instruments inside it, and this file must never
 * learn which. What it does own is the geometry and the collapse contract that
 * BOTH rails have to keep identical, because they are the same object to the
 * user and to the shell-columns solver:
 *
 *  - the rail floats over the Eclipse backdrop as soft translucent ink
 *    (`--vex-rail` + backdrop-blur, guard-whitelisted for exactly this file
 *    and SessionsList), with no separating stroke;
 *  - width is OWNED by the AppShell grid track (the shell-columns solver
 *    derives auto-close and the 48px spine); the rail only fills its track;
 *  - the header bar (first child) carries the version stamp and the chevron
 *    that calls the same `toggleBook` the DESK RULE toggle uses. When
 *    collapsed the bar stays MOUNTED (chevron-only spine) and the children are
 *    not rendered - the panel is never remounted by a collapse, so the
 *    `vex-book-enter` keyframe cannot replay on expand;
 *  - the version stamp shows only when expanded.
 */

import type { JSX, ReactNode } from "react";
import { IconPanelRight } from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import { SidebarIconButton } from "../SessionRows.js";

export function BookRailFrame({
  label,
  headline,
  bookOpen,
  onToggle,
  children,
}: {
  /** The aside's accessible name - each rail names its own instrument. */
  readonly label: string;
  /**
   * What the header says this rail is ABOUT: the open project's name in
   * Studio, nothing in agent mode.
   *
   * The header used to carry the app version and nothing else, so the one line
   * of text above the user's wallets named the build rather than the thing the
   * numbers belong to. The version has not been dropped - it moved to the foot,
   * where a build stamp belongs.
   */
  readonly headline?: string;
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
  /** Rendered only while expanded; the header bar persists in both states. */
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <aside
      data-vex-area="book-panel"
      data-vex-book-open={bookOpen ? "true" : "false"}
      aria-label={label}
      className={cn(
        "vex-book-enter relative flex h-full w-full shrink-0 flex-col overflow-hidden bg-[var(--vex-rail)] backdrop-blur-xl",
        bookOpen ? "gap-3 p-3" : "p-0",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center",
          bookOpen ? "justify-between" : "justify-center pt-3",
        )}
      >
        {bookOpen && headline !== undefined ? (
          <span className="min-w-0 truncate text-[13px] leading-[20px] font-medium text-ink-primary">
            {headline}
          </span>
        ) : null}
        {/* One static glyph for both states, like the left rail toggle - the
            open/close semantic lives in the aria-label. */}
        <SidebarIconButton
          label={bookOpen ? "Collapse the BOOK panel" : "Expand the BOOK panel"}
          onClick={onToggle}
        >
          <IconPanelRight size={17} />
        </SidebarIconButton>
      </div>
      {bookOpen ? children : null}
      {/* The build stamp, at the foot. `mt-auto` keeps it on the floor of the
          rail whatever the sections above it come to. It stays on the micro
          label's floor TIER (`text-ink-secondary`): moving it out of the header
          demotes what it is ABOUT, not how legible it has to be, and the shell
          design guard holds an 11px stamp to that floor. */}
      {bookOpen ? (
        <span className="vex-micro-label mt-auto shrink-0 uppercase text-ink-secondary">
          v{__VEX_APP_VERSION__}
        </span>
      ) : null}
    </aside>
  );
}
