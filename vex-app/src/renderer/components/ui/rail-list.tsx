/**
 * Generic left-rail list primitives: a dense 32px row, a titled group with an
 * eyebrow header, and a compact search field. Presentational only — callers
 * supply an item model (title/time/actions) and all copy; nothing here knows
 * about sessions, so a future list (projects, workspaces) reuses the same
 * chrome.
 *
 * Row grammar (design catalog §5): h32, radius 8, title 14/20 ellipsis, time
 * 12/20 tertiary; hover fill and selected fill are the SAME
 * interactive-hover tint (selection persists it). Actions live in the time's
 * slot and reveal on hover/focus — or stay pinned while `actionsPinned`
 * (an open row menu must not lose its highlight or its buttons).
 */

import type { JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export interface RailRowProps {
  readonly selected: boolean;
  /** Icon-only rail rendering (56px column). */
  readonly collapsed?: boolean;
  /** Leading 16px glyph; rendered only when collapsed. */
  readonly icon?: ReactNode;
  /** Expanded-row 16px leading status slot (a state dot); omitted = no slot. */
  readonly leading?: ReactNode;
  readonly title: string;
  /** Trailing quiet metadata (a time), hidden while actions reveal. */
  readonly trailing?: ReactNode;
  /** Hover-revealed action cluster occupying the trailing slot. */
  readonly actions?: ReactNode;
  /** Keep the actions revealed and the row highlighted (open menu pins). */
  readonly actionsPinned?: boolean;
  readonly onSelect: () => void;
  readonly onDoubleClick?: () => void;
  /** Accessible name for a collapsed (icon-only) row. */
  readonly label?: string;
}

/**
 * One dense list row. The select control and the actions are SIBLINGS inside
 * a non-interactive wrapper — never nested buttons — so Enter/Space on an
 * action cannot bubble into row selection.
 */
export function RailRow({
  selected,
  collapsed = false,
  icon,
  leading,
  title,
  trailing,
  actions,
  actionsPinned = false,
  onSelect,
  onDoubleClick,
  label,
}: RailRowProps): JSX.Element {
  const hasActions = actions !== undefined && !collapsed;
  return (
    <div
      className={cn(
        "group/rail-row relative flex rounded-lg transition-colors",
        collapsed ? "h-9" : "h-8",
        // Hover fill and selected fill are deliberately the same tint.
        selected || actionsPinned
          ? "bg-interactive-hover"
          : "hover:bg-interactive-hover",
      )}
      data-rail-row-pinned={actionsPinned || undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        aria-current={selected ? "true" : undefined}
        aria-label={collapsed ? label ?? title : undefined}
        title={collapsed ? label ?? title : undefined}
        className={cn(
          "flex h-full w-full min-w-0 items-center rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
          collapsed ? "justify-center px-0" : "gap-2 px-2",
        )}
      >
        {collapsed ? (
          <span className="flex h-7 w-7 items-center justify-center text-ink-tertiary">
            {icon}
          </span>
        ) : (
          <>
            {leading !== undefined ? (
              <span className="flex h-5 w-4 shrink-0 items-center justify-center text-ink-tertiary">
                {leading}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-[14px] leading-[20px] text-ink-primary">
              {title}
            </span>
            {trailing !== undefined ? (
              <span
                className={cn(
                  "shrink-0 text-[12px] leading-[20px] tabular-nums text-ink-tertiary",
                  hasActions &&
                    (actionsPinned
                      ? "opacity-0"
                      : "group-focus-within/rail-row:opacity-0 group-hover/rail-row:opacity-0"),
                )}
              >
                {trailing}
              </span>
            ) : null}
          </>
        )}
      </button>

      {hasActions ? (
        <div
          className={cn(
            "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5",
            actionsPinned
              ? "opacity-100"
              : "opacity-0 transition-opacity duration-100 group-focus-within/rail-row:opacity-100 group-hover/rail-row:opacity-100",
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export interface RailGroupProps {
  /** Eyebrow heading; hidden while collapsed (rows become icon-only). */
  readonly title: string;
  readonly collapsed?: boolean;
  /** `<section aria-labelledby>` id namespace (lists can coexist on a page). */
  readonly headingId?: string;
  readonly children: ReactNode;
}

/** A titled row group: eyebrow header + a 2px-gapped column of rows. */
export function RailGroup({
  title,
  collapsed = false,
  headingId,
  children,
}: RailGroupProps): JSX.Element {
  return (
    <section
      aria-labelledby={!collapsed ? headingId : undefined}
      aria-label={collapsed ? title : undefined}
    >
      {!collapsed ? (
        <h2 id={headingId} className="mb-1 flex h-6 items-center px-2">
          <span className="vex-eyebrow">{title}</span>
        </h2>
      ) : null}
      <ol className="flex flex-col gap-0.5">{children}</ol>
    </section>
  );
}

export interface RailSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onClose: () => void;
  readonly placeholder: string;
  /** Accessible names for the field and its close control. */
  readonly label: string;
  readonly closeLabel: string;
  readonly inputRef?: (el: HTMLInputElement | null) => void;
  /** Leading magnifier glyph (callers inject the icon set). */
  readonly icon?: ReactNode;
  readonly closeIcon?: ReactNode;
}

/** Compact search well for a rail. Escape closes (and clears) via onClose. */
export function RailSearchField({
  value,
  onChange,
  onClose,
  placeholder,
  label,
  closeLabel,
  inputRef,
  icon,
  closeIcon,
}: RailSearchFieldProps): JSX.Element {
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-line-input bg-surface-1 px-2.5 transition-colors">
      {icon !== undefined ? (
        <span className="shrink-0 text-ink-tertiary">{icon}</span>
      ) : null}
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-[13px] leading-[20px] text-ink-primary caret-accent-primary placeholder:text-ink-tertiary focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-tertiary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        {closeIcon}
      </button>
    </div>
  );
}
