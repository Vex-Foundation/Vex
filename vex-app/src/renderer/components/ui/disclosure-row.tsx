/**
 * DisclosureRow: shared 24px disclosure chrome for compact flow rows. The
 * 16px leading box crossfades icon <-> chevron on hover (house pattern:
 * "this row expands" without a permanent chevron); expanded content is
 * controlled by the owner.
 *
 * ## The chevron is ONE element that ROTATES
 *
 * The reference tree row (deepseek `Rows.module.css` `.arrow` / `.arrowOpen`)
 * keeps a single right-pointing chevron and turns it 90 degrees when the row
 * opens, so the eye follows one glyph from "will expand" to "is expanded".
 * Ours used to swap a hover chevron for a second, permanent one on open, which
 * is a cut rather than a turn. The same element now survives the toggle: while
 * closed it is the hover-revealed half of the crossfade, and on open it drops
 * the hover class, stays visible and rotates through `.vex-twistie` (the
 * explorer's own folder twistie, so a section header and a folder row turn on
 * the same 150ms token and honour reduced motion through the same block).
 *
 * The body rides `.vex-disclosure-body` so it can fade in on open (opacity
 * only; the reference animates no heights, and neither does this).
 */

import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { IconChevronRight } from "../icons/index.js";
import { cn } from "../../lib/utils.js";

export interface DisclosureRowProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly open: boolean;
  readonly expandable: boolean;
  readonly onToggle: () => void;
  /** Makes the complete title row the disclosure target. */
  readonly expandOnRowClick?: boolean;
  /** Crossfade the collapsed icon to a chevron while the row is hovered. */
  readonly previewChevron?: boolean;
  /** Keeps `collapsedContent` inline while open. */
  readonly keepContentWhenOpen?: boolean;
  readonly collapsedContent?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly titleClassName?: string;
  /**
   * Classes for the expanded body wrapper. A pane that must take the rest of
   * its column passes the flex chain here (`flex min-h-0 flex-1 flex-col`),
   * because the wrapper sits between the root and the children and would
   * otherwise pin the pane to its content height.
   */
  readonly bodyClassName?: string;
}

export function DisclosureRow({
  icon,
  title,
  open,
  expandable,
  onToggle,
  expandOnRowClick = false,
  previewChevron = expandable,
  keepContentWhenOpen = false,
  collapsedContent,
  children,
  className,
  titleClassName,
  bodyClassName,
}: DisclosureRowProps): JSX.Element {
  const rowExpands = expandable && expandOnRowClick;
  const toggleFromLeading = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onToggle();
  };
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!rowExpands || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onToggle();
  };
  // Positions are stable across the toggle on purpose: the icon is always the
  // first child and the chevron always the second, so React keeps the chevron
  // ELEMENT when `open` flips and the rotation transitions instead of
  // remounting at its end state.
  const showChevron = open || previewChevron;
  const leading = (
    <>
      {open ? null : previewChevron ? (
        <span className="vex-disclosure-icon-idle">{icon}</span>
      ) : (
        icon
      )}
      {showChevron ? (
        <IconChevronRight
          size={14}
          className={cn(
            "vex-twistie",
            open ? "rotate-90" : "vex-disclosure-chevron-hover",
          )}
        />
      ) : null}
    </>
  );

  return (
    <div
      className={cn("vex-disclosure-root", className)}
      data-open={open || undefined}
    >
      <div
        className="vex-disclosure-row"
        data-disclosure-row
        data-expandable={rowExpands || undefined}
        role={rowExpands ? "button" : undefined}
        tabIndex={rowExpands ? 0 : undefined}
        aria-expanded={rowExpands ? open : undefined}
        onClick={rowExpands ? onToggle : undefined}
        onKeyDown={rowExpands ? toggleFromKeyboard : undefined}
      >
        {expandable && !rowExpands ? (
          <button
            type="button"
            className="vex-disclosure-leading"
            aria-expanded={open}
            onClick={toggleFromLeading}
          >
            {leading}
          </button>
        ) : (
          <span className="vex-disclosure-leading">{leading}</span>
        )}
        <span className={cn("vex-disclosure-title", titleClassName)}>
          {title}
        </span>
        {(keepContentWhenOpen || !open) && collapsedContent}
      </div>
      {open ? (
        <div className={cn("vex-disclosure-body", bodyClassName)}>{children}</div>
      ) : null}
    </div>
  );
}
