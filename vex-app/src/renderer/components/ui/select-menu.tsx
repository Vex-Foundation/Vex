/**
 * SelectMenu — a dark-themed, accessible single-select dropdown (ARIA
 * "select-only combobox" pattern).
 *
 * Why this exists: native <select> renders its option list with the OS
 * default (white) chrome, which is unreadable on Vex's dark modals. This
 * is a fully-styled replacement (dark panel, aria-activedescendant, useId)
 * without Radix/portals.
 *
 * CSP: NO inline styles — the panel is anchored with Tailwind classes only,
 * so it stays compatible with `style-src 'self'`.
 *
 * Form safety: the trigger is `type="button"` so it can never submit a
 * surrounding <form>, and every handled key calls preventDefault so
 * keyboard open/select cannot synthesize a click or submit.
 *
 * Focus model: focus stays on the trigger; the active option is conveyed
 * via `aria-activedescendant` + a highlight class (no roving focus).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import { ChevronDownIcon, VexIcon } from "../icons/index.js";
import { cn } from "../../lib/utils.js";

export interface SelectMenuOption {
  readonly value: string;
  readonly label: string;
}

export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabelledBy,
  ariaLabel,
  placeholder = "Select…",
  disabled = false,
  placement = "bottom",
  className,
  shimmerLabels = false,
}: {
  readonly value: string;
  readonly options: ReadonlyArray<SelectMenuOption>;
  readonly onChange: (value: string) => void;
  readonly ariaLabelledBy?: string;
  readonly ariaLabel?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /**
   * Static open direction. "bottom" (default) opens below the trigger;
   * "top" opens above it. There is no dynamic geometry measurement — a
   * caller sitting near the bottom of a scrollable modal passes "top" so
   * the absolutely-positioned panel never extends its parent's scroll
   * bounds (which would surface a modal scrollbar).
   */
  readonly placement?: "top" | "bottom";
  readonly className?: string;
  /**
   * Opt-in brand shimmer on the VALUE labels (trigger + every option): each
   * label span carries `.vex-preview-shimmer` + `data-shimmer-text`, so the
   * slow accent band sweeps the level names themselves (owner decree
   * 2026-07-21 — the reasoning-effort selector; other consumers stay
   * plain). The base text remains solid; reduced motion stills the band.
   */
  readonly shimmerLabels?: boolean;
}): JSX.Element {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel =
    selectedIndex >= 0 ? options[selectedIndex]!.label : placeholder;

  const getOptionId = useCallback(
    (index: number): string => `${listboxId}-option-${index}`,
    [listboxId],
  );

  const openMenu = useCallback((): void => {
    if (disabled || options.length === 0) return;
    // Highlight the current selection (or the first option) when opening.
    setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex);
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  const choose = useCallback(
    (index: number): void => {
      const opt = options[index];
      if (opt === undefined) return;
      onChange(opt.value);
      setOpen(false);
      buttonRef.current?.focus();
    },
    [onChange, options],
  );

  // Close when a pointer goes down outside the control. `mousedown` (not
  // `pointerdown`) for robust jsdom test support; it also fires before the
  // option `click`, but the containment check leaves inside-clicks alone.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const onDocMouseDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (disabled) return;
      const count = options.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (!open) {
            openMenu();
          } else if (count > 0) {
            setActiveIndex((i) => (i + 1) % count);
          }
          break;
        case "ArrowUp":
          event.preventDefault();
          if (!open) {
            openMenu();
          } else if (count > 0) {
            setActiveIndex((i) => (i - 1 + count) % count);
          }
          break;
        case "Home":
          if (open && count > 0) {
            event.preventDefault();
            setActiveIndex(0);
          }
          break;
        case "End":
          if (open && count > 0) {
            event.preventDefault();
            setActiveIndex(count - 1);
          }
          break;
        case "Enter":
        case " ":
          // preventDefault so a focused button never synthesizes a click or
          // submits the surrounding form via Space/Enter.
          event.preventDefault();
          if (!open) {
            openMenu();
          } else {
            choose(activeIndex);
          }
          break;
        case "Escape":
          if (open) {
            event.preventDefault();
            setOpen(false);
          }
          break;
        case "Tab":
          // Let focus leave naturally, but collapse the popup first.
          if (open) setOpen(false);
          break;
        default:
          break;
      }
    },
    [disabled, open, options.length, openMenu, choose, activeIndex],
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? getOptionId(activeIndex) : undefined}
        aria-labelledby={ariaLabelledBy}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line-input bg-transparent px-2 text-left text-sm text-ink-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
          "disabled:cursor-not-allowed disabled:opacity-40",
          className,
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate",
            shimmerLabels && "vex-preview-shimmer",
            selectedIndex < 0 && "text-ink-tertiary",
          )}
          data-shimmer-text={shimmerLabels ? selectedLabel : undefined}
        >
          {selectedLabel}
        </span>
        <VexIcon
          icon={ChevronDownIcon}
          size={15}
          aria-hidden
          className={cn(
            "shrink-0 text-ink-tertiary transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          // Solid layer-2 popover: hairline + lv3 elevation, never blur or
          // glow; its scrollbar rebinds to the elevated (l2) pair.
          // `placement` flips the anchor edge (down vs up). The listbox
          // FLOATS (absolute + z-30 + its own max-h scroll): it overlays
          // whatever follows the trigger and never pushes layout.
          className={cn(
            "vex-scroll-elevated absolute left-0 right-0 z-30 max-h-56 overflow-y-auto rounded-xl border border-line-1 bg-surface-2 p-1 text-ink-primary shadow-lv3",
            placement === "top" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {options.map((opt, index) => {
            const active = index === activeIndex;
            const selected = opt.value === value;
            return (
              <li
                key={opt.value}
                id={getOptionId(index)}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm",
                  active
                    ? "bg-interactive-hover text-ink-primary"
                    : "text-ink-secondary",
                  selected && !active && "text-ink-primary",
                )}
              >
                <span
                  className={cn("min-w-0 truncate", shimmerLabels && "vex-preview-shimmer")}
                  data-shimmer-text={shimmerLabels ? opt.label : undefined}
                >
                  {opt.label}
                </span>
                {selected ? (
                  <span
                    aria-hidden
                    className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary"
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
