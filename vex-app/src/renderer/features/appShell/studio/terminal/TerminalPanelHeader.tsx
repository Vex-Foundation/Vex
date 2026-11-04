/**
 * TerminalPanelHeader - what a terminal panel SAYS about itself.
 *
 * The panel's name, what the active pane runs and where, its state, and the
 * actions that name THIS terminal. In H3 cells (our approved Studio plate,
 * docs/design/H3-DESKTOP.md section 4.9; terminal.css): a 56 row, the name
 * at 15 over the process and the directory in mono 12, muted ("zsh ·
 * ~/Vex/projects/vex-core"), then the state cell (its square and word in
 * caps) and four 56 key cells, split right, split down, rename and kill. The
 * picker that decides which shell the NEXT terminal runs is the tabs row's
 * (`ShellPicker`, exported from here and mounted by `TerminalTabs`): it
 * decides the strip's next tab, not this panel's terminal.
 *
 * ## The action cluster, and the one button of it that is still missing
 *
 * The mockup draws `+`, split, trash and `...` here, and the owner settled what
 * the `+` means (2026-09-02): it opens a NEW TERMINAL as a tab, never a split
 * pane. That answer is what makes it a duplicate of the strip's own `+`, which
 * is already on screen a few pixels above and does exactly that, so it is NOT
 * rendered here: the audit that asked for this cluster also files "two controls
 * named New terminal in the centre" as a defect, and shipping the second one
 * deliberately would close a finding by re-opening it. The strip's `+` is the
 * one owner of "open a terminal".
 *
 * What IS here is everything that names THIS terminal and could not be said in
 * a list of tabs:
 *
 *  - SPLIT, which used to sit beside every tab in the strip (three tabs, nine
 *    icons, none of them saying which terminal they would change);
 *  - KILL, which is not the tab's close: on a split tab it ends the one shell
 *    this header describes and leaves the tab open. The two therefore keep two
 *    names, so a keyboard user can tell them apart;
 *  - RENAME, as a direct action rather than the mockup's `...` menu, because
 *    the other two things a menu would hold - colour and icon - are out of this
 *    stage's scope, and a menu with one item is a click in front of a button.
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

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import type {
  TerminalShellId,
  TerminalShellOption,
} from "@shared/schemas/terminal.js";
import {
  LineCheck,
  LineChevronDown,
  LineEdit,
  LineSplitHorizontal,
  LineSplitVertical,
  LineTrash,
} from "../../../../components/icons/line/index.js";
import { cn } from "../../../../lib/utils.js";
import {
  RENAME_FIELD_LABEL,
  RENAME_HINT_COPY,
  SHELL_PICKER_LABEL,
  SHELL_PICKER_WORD,
  TERMINAL_STATE_COPY,
  SHELL_UNAVAILABLE_SUFFIX,
  killTerminalLabel,
  renameTabLabel,
  splitTerminalLabel,
  splitTerminalVerticalLabel,
  terminalLocationLabel,
  terminalShellLabel,
} from "./terminal-copy.js";
import type { TerminalTabRunState } from "./terminal-tab-model.js";
import { TerminalStateSquare } from "./TerminalStateSquare.js";

export interface TerminalPanelHeaderProps {
  /** The panel's name: `Terminal n`, or whatever the user renamed it to. */
  readonly title: string;
  /**
   * The active shell's directory AS A LABEL, or `null` before the first
   * property arrives. Never a filesystem path; see the module header.
   */
  readonly displayCwd: string | null;
  /** What the host says is running here, or `null` before it has said. */
  readonly shellLabel: string | null;
  /** The panel's state: its square and its word. */
  readonly state: TerminalTabRunState;
  readonly onSplit: (orientation: "horizontal" | "vertical") => void;
  readonly onKill: () => void;
  readonly onRename: (title: string) => void;
}

export function TerminalPanelHeader({
  title,
  displayCwd,
  shellLabel,
  state,
  onSplit,
  onKill,
  onRename,
}: TerminalPanelHeaderProps): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);

  const endRename = useCallback(
    (commit: string | null): void => {
      setRenaming(false);
      if (commit !== null && commit.trim() !== "") onRename(commit.trim());
      // The field is about to be removed; focus goes back to the control that
      // opened it rather than to the document body.
      queueMicrotask(() => {
        renameButtonRef.current?.focus();
      });
    },
    [onRename],
  );

  return (
    // THE PANEL HEADER (our approved Studio plate): a 56 row of cells, the
    // name over the process and directory, then the state cell and the keys.
    <div data-vex-terminal-header="" className="vex-ws-head">
      <div className="vex-ws-head__id">
        {/*
          SENTENCE CASE, in the display face. The heading used to be
          `text-transform: uppercase` over the shell's own path, so a terminal
          announced itself as `/BIN/BASH`. The name is the tab's name now, and a
          name is not shouted.
        */}
        {renaming ? (
          <HeaderRenameField initial={title} onEnd={endRename} />
        ) : (
          <h2 className="vex-ws-head__name">{title}</h2>
        )}
        {/*
          The shell and the directory are a SEPARATE line with their own
          accessible names rather than a suffix on the heading: a screen-reader
          user moving by heading should hear the panel's name, not the panel's
          name plus whatever the shell is and wherever it has wandered.
        */}
        <p className="vex-ws-head__where vex-num">
          <span data-vex-terminal-shell="" className="shrink-0">
            {terminalShellLabel(shellLabel)}
          </span>
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          <span
            className="truncate"
            aria-label={terminalLocationLabel(displayCwd)}
          >
            {displayCwd ?? ""}
          </span>
        </p>
      </div>

      <span className="vex-ws-head__state" data-vex-terminal-state={state}>
        <TerminalStateSquare state={state} />
        <span>{TERMINAL_STATE_COPY[state]}</span>
      </span>
      <ClusterButton label={splitTerminalLabel(title)} onClick={() => { onSplit("horizontal"); }}>
        <LineSplitVertical size={16} />
      </ClusterButton>
      <ClusterButton
        label={splitTerminalVerticalLabel(title)}
        onClick={() => { onSplit("vertical"); }}
      >
        <LineSplitHorizontal size={16} />
      </ClusterButton>
      <ClusterButton
        ref={renameButtonRef}
        label={renameTabLabel(title)}
        onClick={() => { setRenaming(true); }}
      >
        <LineEdit size={16} />
      </ClusterButton>
      <ClusterButton label={killTerminalLabel(title)} onClick={onKill}>
        <LineTrash size={16} />
      </ClusterButton>
    </div>
  );
}

/**
 * One key cell in the header: 56 square behind a rule, its 16 icon in ink.
 * Named, never a bare glyph. Kill hovers like the rest: an end is never red
 * on its key; red is the error square's alone.
 */
const ClusterButton = forwardRef<
  HTMLButtonElement,
  {
    readonly label: string;
    readonly onClick: () => void;
    readonly children: ReactNode;
  }
>(({ label, onClick, children }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className="vex-ws-head__key"
  >
    {children}
  </button>
));
ClusterButton.displayName = "ClusterButton";

/**
 * Rename in the header's own title slot.
 *
 * Enter commits, Escape cancels, blur commits - the same three keys the tab's
 * inline rename answers to, because two rename affordances that behaved
 * differently would be two features.
 */
function HeaderRenameField({
  initial,
  onEnd,
}: {
  readonly initial: string;
  readonly onEnd: (commit: string | null) => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={RENAME_FIELD_LABEL}
      title={RENAME_HINT_COPY}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onEnd(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onEnd(null);
        }
      }}
      onBlur={() => {
        onEnd(value);
      }}
      className="h-6 w-48 border border-rule bg-surface-field px-2 text-[14px] leading-5 text-ink-primary caret-accent-primary focus-visible:border-accent-primary focus-visible:outline-none"
    />
  );
}

/** The accessible name of one row: the shell, and whether it can be chosen. */
function optionLabel(shell: TerminalShellOption): string {
  return shell.available ? shell.label : `${shell.label}${SHELL_UNAVAILABLE_SUFFIX}`;
}

/**
 * THE SHELL PICKER, the tabs row's last cell (our approved Studio plate):
 * SHELL in caps, muted, then the shell the next terminal runs in mono and a
 * chevron. When the selected shell is not on this machine the key says so IN
 * WORDS after the label (the same suffix the option names carry), because a
 * fill alone is never a state.
 */
export function ShellPicker({
  shells,
  shellId,
  onSelectShell,
}: {
  /** The catalogue rows, in main's order. Empty while the read is in flight. */
  readonly shells: readonly TerminalShellOption[];
  /** Which shell the NEXT terminal opens with. */
  readonly shellId: TerminalShellId;
  readonly onSelectShell: (shellId: TerminalShellId) => void;
}): JSX.Element {
  const selected = shells.find((shell) => shell.id === shellId);
  const selectedLabel = selected?.label ?? shellId;
  const available = selected?.available ?? false;
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
    <div className="vex-ws-shell">
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
        // THE PICKER CELL (geometry in terminal.css): the row's height
        // behind a rule, SHELL muted in caps, the shell in mono 13 ink, the
        // chevron muted.
        className="vex-ws-picker"
      >
        <span aria-hidden="true" className="vex-ws-picker__word">
          {SHELL_PICKER_WORD}
        </span>
        <span className="vex-ws-picker__value vex-num">
          {available ? selectedLabel : `${selectedLabel}${SHELL_UNAVAILABLE_SUFFIX}`}
        </span>
        <LineChevronDown size={14} className="shrink-0 text-ink-tertiary" />
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={SHELL_PICKER_LABEL}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          /*
            A MENU PANEL (docs/design/R3-MINIMAL.md section 12): the field, a
            1px ink border, padding 4 0, no shadow and no radius. The field is
            a utility the theme DEFINES: an earlier `bg-surface-raised` named a
            token that does not exist, Tailwind emitted no rule, and the rows
            floated over the terminal's canvas, so the AVAILABLE shells were
            the ones you could not read in the light theme.
          */
          className="absolute top-full right-0 z-20 mt-1 min-w-[180px] border border-rule-ink bg-surface-field py-1"
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
                // A ROW is 32 high at 13.5 with padding 0 12; the selected one
                // takes the selection wash, and focus is an outline drawn inside.
                "flex min-h-8 cursor-pointer items-center justify-between gap-3 px-3 text-[13.5px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
                shell.available
                  ? "text-ink-primary hover:bg-interactive-hover"
                  : "cursor-default text-ink-tertiary",
                shell.id === shellId ? "bg-interactive-active hover:bg-interactive-active" : null,
              )}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {/* A CHECK, not only a fill. The selected row used to be told
                    apart by a background tint alone, which is a colour-only
                    signal and disappears at high contrast. */}
                <span aria-hidden="true" className="w-3.5 shrink-0">
                  {shell.id === shellId ? <LineCheck size={14} /> : null}
                </span>
                <span className="vex-num truncate font-mono">{shell.label}</span>
              </span>
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
