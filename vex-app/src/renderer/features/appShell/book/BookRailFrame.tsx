/**
 * THE BOOK RAIL'S CHROME - the right page and its 44px head, shared by the
 * agent rail and the Studio rail (docs/design/V10-SPREAD.md section 2).
 *
 * Chrome only. It owns no sections, no registry, no query and no tab: the two
 * rails put entirely different instruments inside it, and this file must never
 * learn which. What it does own is the geometry and the collapse contract that
 * BOTH rails have to keep identical, because they are the same object to the
 * user and to the shell-columns solver:
 *
 *  - the rail is paper with one rule down its left edge (`.vex-bk`,
 *    styles/global-css/book.css): no glass, no blur, no shadow;
 *  - width is OWNED by the AppShell grid track (the shell-columns solver
 *    derives auto-close and the 48px spine); the rail only fills its track;
 *  - the head row (first child, a window drag region) carries the tab slot
 *    (`book-head-slot.ts`), the headline when a rail has one, and the toggle
 *    that calls the same `toggleBook` the DESK RULE toggle uses. When
 *    collapsed the head stays MOUNTED (toggle-only spine) and the children are
 *    not rendered - the panel is never remounted by a collapse, so the
 *    `vex-book-enter` keyframe cannot replay on expand;
 *  - the version stamp sits in the foot and shows only when expanded.
 */

import { useState, type JSX, type ReactNode } from "react";
import { PxIcon } from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";
import { BookHeadSlotContext } from "./book-head-slot.js";

export function BookRailFrame({
  label,
  headline,
  toggleLabel = "BOOK panel",
  collapsedLabel,
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
  readonly toggleLabel?: string;
  readonly collapsedLabel?: string;
  readonly bookOpen: boolean;
  readonly onToggle: () => void;
  /** Rendered only while expanded; the header bar persists in both states. */
  readonly children: ReactNode;
}): JSX.Element {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <aside
      data-vex-area="book-panel"
      data-vex-book-open={bookOpen ? "true" : "false"}
      aria-label={label}
      className="vex-book-enter vex-bk"
    >
      {/* The BOOK's head row: a window drag region that runs the page's
          full width, its rule included, under the Windows and Linux
          caption buttons, while its content (the tab slot, then the toggle,
          which never shrinks) keeps clear of them. A size container: the
          strip turns to icons when its words no longer fit (book.css,
          shell.css, docs/design/V10-SPREAD.md section 8). */}
      <div
        className={cn(
          "vex-bk__head vex-drag",
          bookOpen && "vex-overlay-end",
          !bookOpen && "vex-book-head",
        )}
      >
        {bookOpen ? <div ref={setSlot} className="vex-bk__slot" /> : null}
        {bookOpen && headline !== undefined ? (
          <span className="vex-bk__name">{headline}</span>
        ) : null}
        {/* One static glyph for both states, like the left rail toggle - the
            open/close semantic lives in the aria-label. */}
        {!bookOpen && collapsedLabel !== undefined ? (
          <button
            type="button"
            aria-label={collapsedLabel}
            aria-expanded="false"
            onClick={onToggle}
            className="vex-bk__key"
            style={{ flexDirection: "column", minHeight: 56, width: 40 }}
          >
            <PxIcon name="panel-right" />
            <span className="vex-bs__k" style={{ fontSize: 10 }}>
              {collapsedLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            aria-label={`${bookOpen ? "Collapse" : "Expand"} the ${toggleLabel}`}
            onClick={onToggle}
            className="vex-bk__key"
          >
            <PxIcon name="panel-right" />
          </button>
        )}
      </div>
      {bookOpen ? (
        <BookHeadSlotContext.Provider value={slot}>
          {children}
        </BookHeadSlotContext.Provider>
      ) : null}
      {/* The build stamp, in the foot of the page. */}
      {bookOpen ? (
        <span className="vex-bk__foot">v{__VEX_APP_VERSION__}</span>
      ) : null}
    </aside>
  );
}
