/**
 * TerminalPanelHeader - what a terminal panel SAYS about itself.
 *
 * Three facts and one action: the panel's name, the directory the active shell
 * is in, and the picker that decides which shell the NEXT terminal runs.
 *
 * ## The `+` the mockup draws here is deliberately absent
 *
 * The mockup puts a `+` in this header as well as in the tab strip above it,
 * and both would open a terminal in this project - the same action, reached
 * twice. `terminal-copy.ts` already settled what that costs, on the empty
 * state's own button: "two controls sharing one accessible name is ambiguous
 * to anyone navigating by name". Giving one of them a different name does not
 * help, because a different name for the same action is a false name.
 *
 * So the strip's `+` remains the one way to open a terminal, and this header
 * carries only what is genuinely new: where the shell is, and which shell the
 * next one will be. Making the header's `+` a DIFFERENT action - a new pane in
 * this group rather than a new tab - would resolve the ambiguity honestly, but
 * it is a product decision about what the mockup's two buttons mean, and it is
 * not one to invent here.
 *
 * ## Presentational, and deliberately so
 *
 * It owns no state. The directory arrives as a LABEL that main and the pty host
 * already derived (`pty-host/display-cwd.ts`); this component could not turn it
 * back into a path if it wanted to, and nothing here would know what to do with
 * one. The shell list arrives as ids and labels; picking one calls back with an
 * ID, which is the only thing the renderer is ever allowed to say about a
 * shell. Every authority question - may this shell be launched, does it exist -
 * is answered in main, after this component has had its say.
 *
 * ## The picker is a listbox, not a `<select>`
 *
 * A native `<select>` would be less code and is genuinely tempting. It is
 * rejected for one reason that matters here: a row must be able to render as
 * PRESENT BUT NOT INSTALLED, and `<option disabled>` is skipped by keyboard
 * navigation on every platform, so a user arrowing through the list would never
 * learn that Vex supports fish and they do not have it. The ARIA listbox
 * pattern lets an unavailable row be focusable and announced while still not
 * being selectable, which is the behaviour the copy promises.
 *
 * The pattern is the WAI-ARIA one and the obligations are met explicitly:
 * `aria-haspopup="listbox"` and `aria-expanded` on the button, `role="listbox"`
 * with an accessible name on the popup, `role="option"` plus `aria-selected`
 * and `aria-disabled` on the rows, roving focus driven by Arrow/Home/End,
 * Escape closing and RESTORING focus to the button, and a click outside doing
 * the same. VS Code's terminal tab list is the reference for deriving the
 * accessible name from the same identity the row renders from
 * (`terminalTabsList.ts`, `getAriaLabel`), which is why the option's name is
 * built from the label and the availability rather than from the DOM.
 */

import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import type {
  TerminalShellId,
  TerminalShellOption,
} from "@shared/schemas/terminal.js";
import { IconChevronDown } from "../../../../components/icons/index.js";
import { cn } from "../../../../lib/utils.js";
import {
  SHELL_PICKER_LABEL,
  SHELL_UNAVAILABLE_SUFFIX,
  terminalLocationLabel,
} from "./terminal-copy.js";

export interface TerminalPanelHeaderProps {
  /** The panel's name. The tab's title, which follows the shell's own title. */
  readonly title: string;
  /**
   * The active shell's directory AS A LABEL, or `null` before the first
   * property arrives. Never a filesystem path; see the module header.
   */
  readonly displayCwd: string | null;
  /** Which shell the NEXT terminal opens with. */
  readonly shellId: TerminalShellId;
  /** The catalogue rows, in main's order. Empty while the read is in flight. */
  readonly shells: readonly TerminalShellOption[];
  readonly onSelectShell: (shellId: TerminalShellId) => void;
}

export function TerminalPanelHeader({
  title,
  displayCwd,
  shellId,
  shells,
  onSelectShell,
}: TerminalPanelHeaderProps): JSX.Element {
  const selected = shells.find((shell) => shell.id === shellId);

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-line-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[12px] font-medium tracking-wide text-ink-primary uppercase">
          {title}
        </h2>
        {/*
          The directory is a SEPARATE line with its own accessible name rather
          than a suffix on the heading: a screen-reader user moving by heading
          should hear the panel's name, not the panel's name plus wherever the
          shell happens to have wandered.
        */}
        <p
          className="truncate text-[12px] text-accent-primary"
          aria-label={terminalLocationLabel(displayCwd)}
        >
          {displayCwd ?? ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <ShellPicker
          shells={shells}
          shellId={shellId}
          selectedLabel={selected?.label ?? shellId}
          onSelectShell={onSelectShell}
        />
      </div>
    </div>
  );
}

/** The accessible name of one row: the shell, and whether it can be chosen. */
function optionLabel(shell: TerminalShellOption): string {
  return shell.available ? shell.label : `${shell.label}${SHELL_UNAVAILABLE_SUFFIX}`;
}

function ShellPicker({
  shells,
  shellId,
  selectedLabel,
  onSelectShell,
}: {
  readonly shells: readonly TerminalShellOption[];
  readonly shellId: TerminalShellId;
  readonly selectedLabel: string;
  readonly onSelectShell: (shellId: TerminalShellId) => void;
}): JSX.Element {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  /**
   * Close and RESTORE FOCUS to the button.
   *
   * Restoration is not optional politeness: a popup that closes leaving focus
   * on a removed node drops the user to the document body, and the next Tab
   * starts from the top of the page rather than from the control they were
   * using.
   */
  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const openList = useCallback((): void => {
    const current = shells.findIndex((shell) => shell.id === shellId);
    setActiveIndex(current === -1 ? 0 : current);
    setOpen(true);
  }, [shellId, shells]);

  // INITIAL FOCUS into the list, once it exists. The listbox is the thing the
  // user just asked for; leaving focus on the button would make Arrow keys
  // move the page instead of the selection.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // A click ANYWHERE ELSE closes, without stealing focus back - the user is
  // already on their way somewhere and pulling focus would fight them.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (listRef.current?.contains(target) === true) return;
      if (buttonRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const choose = useCallback(
    (shell: TerminalShellOption): void => {
      // Not selectable, and NOT closed either: the user pressed Enter on a row
      // that says it is not installed, and closing would read as "it worked".
      if (!shell.available) return;
      onSelectShell(shell.id);
      close(true);
    },
    [close, onSelectShell],
  );

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const last = shells.length - 1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index >= last ? 0 : index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index <= 0 ? last : index - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(last);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const shell = shells[activeIndex];
        if (shell !== undefined) choose(shell);
      }
    },
    [activeIndex, choose, close, shells],
  );

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={SHELL_PICKER_LABEL}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) close(true);
          else openList();
        }}
        className="flex items-center gap-1 rounded-md border border-line-3 px-2 py-1 text-[12px] text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="max-w-[10rem] truncate">{selectedLabel}</span>
        <IconChevronDown size={12} />
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={SHELL_PICKER_LABEL}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          className="absolute top-full right-0 z-20 mt-1 min-w-[12rem] rounded-md border border-line-3 bg-surface-raised py-1 shadow-lg"
        >
          {shells.map((shell, index) => (
            <div
              key={shell.id}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              role="option"
              aria-selected={shell.id === shellId}
              // FOCUSABLE THOUGH UNSELECTABLE. `aria-disabled` rather than the
              // `disabled` attribute is what keeps an uninstalled shell in the
              // keyboard order, so the user learns it exists.
              aria-disabled={!shell.available}
              aria-label={optionLabel(shell)}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => {
                setActiveIndex(index);
              }}
              onClick={() => {
                choose(shell);
              }}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 px-2 py-1 text-[12px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                shell.available ? "text-ink-primary" : "cursor-default text-ink-tertiary",
                shell.id === shellId ? "bg-interactive-hover" : null,
              )}
            >
              <span className="truncate">{shell.label}</span>
              {shell.available ? null : (
                <span aria-hidden="true" className="shrink-0 text-ink-tertiary">
                  {SHELL_UNAVAILABLE_SUFFIX.trim()}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
