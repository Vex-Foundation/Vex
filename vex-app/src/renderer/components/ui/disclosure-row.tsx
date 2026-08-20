/**
 * DisclosureRow: shared 24px disclosure chrome for compact flow rows. The
 * 16px leading box crossfades icon <-> chevron on hover (house pattern:
 * "this row expands" without a permanent chevron); expanded content is
 * controlled by the owner.
 */

import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { IconChevronDown } from "../icons/index.js";
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
  const collapsedLeading = previewChevron ? (
    <>
      <span className="vex-disclosure-icon-idle">{icon}</span>
      <IconChevronDown size={14} className="vex-disclosure-chevron-hover" />
    </>
  ) : (
    icon
  );
  const leading = open ? <IconChevronDown size={14} /> : collapsedLeading;

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
      {open && children}
    </div>
  );
}
