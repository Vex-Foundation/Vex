/**
 * THE PAGE FRAME'S TABS ROW (docs/design/H3-DESKTOP.md sections 1.9 and 4.8;
 * Appendix A.8). H3 opens every page with one row of cells about 57 high
 * across the page: the page's tabs at the left as square cells (OVERVIEW
 * selected on a raised fill, WALLET beside it), then "Updated 12:41" at the
 * right; the page body starts under the row's rule. Desktop draws the same
 * row with the page's OWN tabs and its own keys:
 *
 *   - the tabs are what the page already lets the person pick between (the
 *     Portfolio's scope, a chart's range); a page with nothing to pick draws
 *     none. H3's OVERVIEW and WALLET are Cloud's page names and are never
 *     copied as words;
 *   - while the page's first read runs, its words ("Loading your
 *     portfolio…") stand in the stamp's slot after the stepping hatch, and
 *     while a later read runs the hatch stands before "Updated" (VEX Cloud's
 *     `.vx-pgfresh`; H3-DESKTOP section 5.6);
 *   - "Updated {time}" is the page's REAL refresh time: the fetch time of the
 *     read behind its figures (TanStack Query's `dataUpdatedAt`), never the
 *     clock at render and never a time the read does not carry. A page whose
 *     read has not answered yet draws no stamp rather than a guess;
 *   - the page's keys (Portfolio's refresh) stand at the right beside the
 *     stamp, where section 4.8 moves them out of the title bar.
 *
 * The row is drawn by `ShellScreen` above the page's scroller, so it stays in
 * place while the body scrolls under it. A page with no tabs, no stamp and no
 * keys draws no row at all (`hasPageBar`), so the frame never shows an empty
 * band.
 *
 * TABS ARE TOGGLE BUTTONS, NOT ARIA TABS. Each one narrows or switches the
 * SAME body (one scroller, no separate tab panels), which is the toggle group
 * the Portfolio's scope chips already were (`aria-pressed` in a labelled
 * group). Words are written in sentence case and set in caps by the sheet
 * (section 2.3), so a screen reader reads "All wallets", not letters.
 *
 * Styles: `.vex-pg-bar` and friends in `styles/global-css/book.css`.
 */

import type { JSX, ReactNode } from "react";
import { LoadingHatch } from "../../../components/ui/cover.js";
import { clockFromMs } from "../book/portfolio/portfolio-format.js";

/** One tab cell: its word, an optional muted second word, a tooltip. */
export interface PageTab {
  readonly key: string;
  readonly label: string;
  /** A muted word after " · " ("Primary", a short address). */
  readonly detail?: string | null;
  /** The full statement behind a short word (a wallet's address). */
  readonly title?: string | null;
}

/**
 * The tab cells: a labelled group of toggle buttons, the selected one
 * pressed, in the frame's 57 high row.
 */
export function PageTabs({
  label,
  tabs,
  selectedKey,
  onSelect,
}: {
  /** The group's accessible name ("Portfolio scope"). */
  readonly label: string;
  readonly tabs: readonly PageTab[];
  readonly selectedKey: string;
  readonly onSelect: (key: string) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label={label} className="vex-pg-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          title={tab.title ?? undefined}
          aria-pressed={tab.key === selectedKey}
          onClick={() => onSelect(tab.key)}
          className="vex-pg-tab"
        >
          <span>{tab.label}</span>
          {tab.detail !== undefined && tab.detail !== null ? (
            <span className="vex-pg-tab__d">{` · ${tab.detail}`}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * "Updated 14:30": the local clock of a read's own fetch time. Null when the
 * read has not answered (TanStack Query reports 0 until it has data), so no
 * stamp stands in for a time nobody measured. The `<time>` carries the
 * machine-readable instant and, as its tooltip, the full local date and time
 * (VEX Cloud's `.vx-pgfresh`), so "14:30" is never a guess about which day.
 */
export function UpdatedStamp({
  at,
  reading = false,
}: {
  readonly at: number | null | undefined;
  /** A read is running now: the stepping hatch stands before the stamp. */
  readonly reading?: boolean;
}): JSX.Element | null {
  const clock = clockFromMs(at);
  if (clock === null || at === null || at === undefined) return null;
  const instant = new Date(at);
  return (
    <p className="vex-pg-stamp" data-vex-area="page-updated" data-reading={reading ? "" : undefined}>
      {reading ? <LoadingHatch /> : null}
      Updated{" "}
      <time
        className="vex-num"
        dateTime={instant.toISOString()}
        title={STAMP_TITLE.format(instant)}
      >
        {clock}
      </time>
    </p>
  );
}

/** The stamp's tooltip: the whole local date and time, "3 Nov 2026, 14:30:05". */
const STAMP_TITLE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * The first read's words in the stamp slot ("Loading your portfolio…"), the
 * stepping hatch before them (VEX Cloud's `Fresh` while loading). They repeat
 * the body's one loading status, so the slot is hidden from assistive tech.
 */
function LoadingStamp({ words }: { readonly words: string }): JSX.Element {
  return (
    <p className="vex-pg-stamp" data-vex-area="page-loading" aria-hidden="true">
      <LoadingHatch />
      {words}
    </p>
  );
}

/** Whether a page has anything for its tabs row; with nothing, no row. */
export function hasPageBar({
  tabs,
  updatedAt,
  keys,
  loading,
}: {
  readonly tabs?: ReactNode;
  readonly updatedAt?: number | null;
  readonly keys?: ReactNode;
  readonly loading?: string | null;
}): boolean {
  const filled = (node: ReactNode): boolean =>
    node !== undefined && node !== null && node !== false;
  return (
    filled(tabs) ||
    clockFromMs(updatedAt) !== null ||
    filled(keys) ||
    (loading !== undefined && loading !== null)
  );
}

/**
 * The row: tabs at the left, then the stamp and the page's keys at the right.
 * `ShellScreen` mounts it above the scroller; a page hands it the parts.
 */
export function PageBar({
  tabs,
  updatedAt,
  keys,
  reading = false,
  loading = null,
}: {
  /** The page's tab cells (`PageTabs`), or none. */
  readonly tabs?: ReactNode;
  /** The fetch time of the read behind the page's figures, in ms. */
  readonly updatedAt?: number | null;
  /** The page's keys (refresh), at the right after the stamp. */
  readonly keys?: ReactNode;
  /** A read of figures already shown is running: the hatch before "Updated". */
  readonly reading?: boolean;
  /** The first read is running: these words, with the hatch, take the stamp's slot. */
  readonly loading?: string | null;
}): JSX.Element | null {
  if (!hasPageBar({ tabs, updatedAt, keys, loading })) return null;
  return (
    <div className="vex-pg-bar" data-vex-area="page-tabs-row">
      {tabs ?? null}
      <div className="vex-pg-bar__end">
        {loading !== null ? <LoadingStamp words={loading} /> : <UpdatedStamp at={updatedAt} reading={reading} />}
        {keys ?? null}
      </div>
    </div>
  );
}
