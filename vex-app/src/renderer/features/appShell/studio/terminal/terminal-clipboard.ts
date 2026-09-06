/**
 * COPY AND PASTE IN THE STUDIO TERMINAL.
 *
 * There was none. A user could select output with the mouse and had no gesture
 * that would copy it, and nothing that would paste into a shell - measured on
 * the owner's Windows session, and the reason this module exists.
 *
 * ## The table is VS Code's, because Ctrl+C is the hard part
 *
 * `Ctrl+C` in a terminal already means SIGINT, and a surface that took it for
 * copy would have broken the one keystroke every developer relies on. VS Code's
 * answer, read out of the checkout
 * (`terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts:245-306`):
 *
 *  - `Ctrl+Shift+C` -> `CopySelection`, `when` textSelected && terminalFocus;
 *  - `Ctrl+C` -> `CopyAndClearSelection`, registered `win:` only, same `when`;
 *  - `Ctrl+Shift+V` -> `Paste` (`win.secondary`, `linux.primary`);
 *  - macOS gets `Cmd+C` / `Cmd+V` as the plain primaries.
 *
 * THE `when` IS THE WHOLE SAFETY PROPERTY, and it is why {@link
 * decideTerminalClipboardAction} takes `hasSelection`: with nothing selected,
 * `Ctrl+C` resolves to NOTHING here, xterm encodes it as `0x03` and the shell
 * gets its interrupt exactly as before. Only a live selection can divert it,
 * and a selection is something the user made deliberately a moment ago.
 *
 * ONE ADOPTED DEVIATION, on the owner's instruction: `Ctrl+C`-with-selection is
 * enabled on Linux as well as Windows, where VS Code registers it `win:` only.
 * The X11 convention VS Code is deferring to is that a selection is already in
 * the PRIMARY buffer; Vex is a desktop app whose users come from Windows
 * terminals, and the gesture behaving the same on both is worth more here than
 * matching the platform convention. macOS is untouched: `Cmd+C` is the copy key
 * there and `Ctrl+C` is the interrupt, with no overlap to resolve.
 *
 * COPY-ON-SELECTION IS OFF, as it is in VS Code by default
 * (`TerminalSettingId.CopyOnSelection`). Writing to the system clipboard
 * because a pointer moved is a side effect the user did not ask for, and it
 * destroys whatever they had copied a moment earlier.
 *
 * ## Effects are separated from the decision
 *
 * {@link decideTerminalClipboardAction} is a pure function of an event plus two
 * facts, so the whole table is provable without a DOM, a clipboard permission
 * or a real terminal. {@link runTerminalClipboardAction} owns the effects and
 * REPORTS ITS OUTCOME rather than throwing: `navigator.clipboard` is
 * permission-gated and can reject, and a terminal that silently did nothing
 * would be indistinguishable from one whose keybinding is broken (rule 90's
 * error contract).
 */

import type { StudioPlatform } from "../keybindings-labels.js";

/** What a clipboard gesture asks the terminal to do. */
export type TerminalClipboardAction =
  | "copySelection"
  /** Copy, then drop the selection - VS Code's `CopyAndClearSelection`. */
  | "copyAndClearSelection"
  | "paste";

/** Everything outside the event that decides what a gesture means. */
export interface TerminalClipboardContext {
  /** Whether the terminal has a NON-EMPTY selection right now. */
  readonly hasSelection: boolean;
  readonly platform: StudioPlatform;
}

/** The shape the decision reads. A `KeyboardEvent` satisfies it structurally. */
export interface TerminalClipboardKeyEvent {
  readonly type: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * Resolve a keypress to a clipboard action, or `null` for "not ours".
 *
 * `null` is the contract on the way out: the caller leaves the event alone, so
 * xterm encodes it and the shell receives it exactly as it would have. That is
 * what keeps `Ctrl+C` an interrupt whenever there is no selection to copy.
 *
 * Alt is disqualifying on every row, for the reason the Studio table gives: on
 * many European layouts AltGr IS Ctrl+Alt, so a resolver that ignored `altKey`
 * would swallow the keystrokes that type `ę` or `@`.
 */
export function decideTerminalClipboardAction(
  event: TerminalClipboardKeyEvent,
  context: TerminalClipboardContext,
): TerminalClipboardAction | null {
  // KEYDOWN ONLY. xterm hands its custom handler keydown, keypress and keyup;
  // acting on more than one would copy twice per press.
  if (event.type !== "keydown") return null;
  if (event.altKey) return null;

  const mac = context.platform === "darwin";
  // On macOS the copy/paste modifier is Cmd and Control is the interrupt; off
  // macOS it is Control and Meta is never part of one of these chords.
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return null;

  if (event.code === "KeyC") {
    if (!context.hasSelection) return null;
    if (mac) return event.shiftKey ? null : "copySelection";
    // Ctrl+Shift+C copies and KEEPS the selection; Ctrl+C copies and clears it,
    // so the next Ctrl+C is an interrupt again. That asymmetry is VS Code's and
    // it is what makes stealing Ctrl+C at all defensible.
    return event.shiftKey ? "copySelection" : "copyAndClearSelection";
  }

  if (event.code === "KeyV") {
    if (mac) return event.shiftKey ? null : "paste";
    return event.shiftKey ? "paste" : null;
  }

  return null;
}

/**
 * What a right click means on this platform.
 *
 * VS Code's `terminal.integrated.rightClickBehavior` defaults to `copyPaste` on
 * Windows and to a context menu elsewhere
 * (`terminal.clipboard.contribution.ts:123-165` reads the setting; the platform
 * default is in the configuration schema). Same split here: Windows users
 * expect the conhost gesture where right click just copies-or-pastes, and every
 * other platform expects a menu.
 */
export function terminalRightClickIsCopyPaste(platform: StudioPlatform): boolean {
  return platform === "win32";
}

/**
 * WHY a clipboard gesture did nothing, when it did nothing.
 *
 * Named outcomes rather than a thrown error: `navigator.clipboard` is
 * permission-gated, and "your browser refused the clipboard" is a different
 * fact from "there was nothing to paste", with a different thing for the user
 * to do about it.
 */
export type TerminalClipboardOutcome =
  | { readonly kind: "done"; readonly action: TerminalClipboardAction }
  /** Nothing to copy, or the clipboard was empty. Not a failure. */
  | { readonly kind: "nothing"; readonly action: TerminalClipboardAction }
  | { readonly kind: "unavailable"; readonly action: TerminalClipboardAction }
  | { readonly kind: "refused"; readonly action: TerminalClipboardAction };

/** The terminal capabilities this module needs. `Terminal` satisfies it. */
export interface TerminalClipboardTarget {
  getSelection: () => string;
  hasSelection: () => boolean;
  clearSelection: () => void;
  paste: (data: string) => void;
  focus: () => void;
}

/** The clipboard capabilities this module needs. `navigator.clipboard` satisfies it. */
export interface ClipboardLike {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

/**
 * Perform a clipboard action against a terminal, and say what happened.
 *
 * @param clipboard - injected rather than read off `navigator` so a test can
 * drive the refused and unavailable branches, which are the two a real
 * clipboard will not produce on demand.
 */
export async function runTerminalClipboardAction(
  action: TerminalClipboardAction,
  terminal: TerminalClipboardTarget,
  clipboard: ClipboardLike | undefined,
): Promise<TerminalClipboardOutcome> {
  if (action === "paste") {
    if (clipboard?.readText === undefined) {
      return { kind: "unavailable", action };
    }
    let text: string;
    try {
      text = await clipboard.readText();
    } catch {
      return { kind: "refused", action };
    }
    if (text === "") return { kind: "nothing", action };
    // FOCUS FIRST, as VS Code's `_paste` does: the gesture may have come from a
    // context menu, and pasting into a terminal the caret is not in writes
    // bytes the user cannot see the effect of.
    terminal.focus();
    terminal.paste(text);
    return { kind: "done", action };
  }

  const selection = terminal.getSelection();
  if (selection === "") return { kind: "nothing", action };
  if (clipboard?.writeText === undefined) {
    return { kind: "unavailable", action };
  }
  try {
    await clipboard.writeText(selection);
  } catch {
    return { kind: "refused", action };
  }
  // CLEARED ONLY AFTER THE WRITE SUCCEEDED. Dropping the selection first would
  // leave a user whose clipboard refused with neither the text nor the
  // selection they had.
  if (action === "copyAndClearSelection") terminal.clearSelection();
  return { kind: "done", action };
}

/**
 * What the user is told when a gesture did not do what it promised.
 *
 * `null` for the outcomes that need no notice: a successful copy is visible in
 * the paste that follows it, and "nothing was selected" is a statement of what
 * the user can already see. Rule 90: never "unexpected error", always the real
 * cause and what to do instead.
 */
export function terminalClipboardNotice(
  outcome: TerminalClipboardOutcome,
): string | null {
  if (outcome.kind === "done" || outcome.kind === "nothing") return null;
  const verb = outcome.action === "paste" ? "paste" : "copy";
  if (outcome.kind === "unavailable") {
    return `This window cannot ${verb}: the system clipboard is not available to it.`;
  }
  return `Vex was not allowed to ${verb}. Your system denied clipboard access to this window.`;
}
