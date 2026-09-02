/**
 * THE STUDIO KEYBOARD CONTRACT, as a table.
 *
 * One row per shortcut, pure data; one pure function that turns a key event
 * plus a context into an INTENT or `null`. The hook owns the effects
 * (`useStudioKeybindings.ts`), the owners own the actions, and this module owns
 * the mapping - the same split `explorer/explorer-keys.ts` already uses for the
 * tree, so Studio has one answer for "what does this key do" and it is
 * table-tested without a DOM.
 *
 * ## Why these keys and not others
 *
 * They are VS Code's, wherever Studio has the same surface, so a VS Code user's
 * hands already know them. The four with no VS Code counterpart (`Focus
 * explorer` matches, `Back to Agent mode` and `New project` are ours) follow the
 * same grammar: Ctrl-or-Cmd plus Shift for a thing that CREATES or MOVES you,
 * Ctrl-or-Cmd alone for a thing that toggles what is already there.
 *
 * ## Codes, not keys
 *
 * Every chord names a `KeyboardEvent.code` (`Digit5`, `Backquote`, `KeyW`),
 * never a `key`. `key` is what the layout PRODUCES: Shift+5 is `%` on a US
 * keyboard and `(` on a French one, and a table written against `key` would
 * bind Split terminal on one layout and nothing on another. `code` is the
 * physical key, which is what VS Code's ScanCode model resolves against
 * (`base/common/keybindings.ts`, `ScanCodeChord`) and what a shortcut printed
 * as `Ctrl+Shift+5` actually promises.
 *
 * ## Alt is never part of a Studio chord, and is always disqualifying
 *
 * Not an omission: on many European layouts AltGr IS Ctrl+Alt, so a user typing
 * a Polish `ę` (AltGr+E) or a `@` on a German keyboard sends an event with both
 * `ctrlKey` and `altKey` set. A resolver that ignored `altKey` would swallow
 * those keystrokes into `Focus explorer` and the user could not type. Every row
 * requires Alt to be UP.
 *
 * ## `when`: where a binding applies
 *
 * VS Code resolves a keypress against a context and skips every rule whose
 * `when` clause the context does not satisfy
 * (`platform/keybinding/common/keybindingResolver.ts:380-399`). Studio's
 * context is much smaller than a context-key service and is deliberately not
 * one: the surface that holds focus, plus whether a modal dialog is open.
 *
 * A MODAL DIALOG SUSPENDS EVERY BINDING. It does not swallow the keystroke -
 * the event is left alone and the dialog's own handlers still see it - Studio
 * simply takes no shortcut while a decision is pending. Rule 08's floor for
 * dangerous actions is that they cannot submit from stale state, and a
 * `Ctrl+W` that closed a tab underneath an open Delete-project dialog is
 * exactly that class of surprise.
 */

import type { StudioPlatform } from "./keybindings-labels.js";

/**
 * WHAT A SHORTCUT ASKS FOR. Never what it does: the owners decide that.
 *
 * A closed union, exhaustively handled by the hook's dispatch, so a row added
 * here without a handler is a type error rather than a key that does nothing.
 */
export type StudioIntent =
  | "newTerminal"
  | "toggleTerminal"
  | "splitTerminal"
  | "focusExplorer"
  | "goToFile"
  | "toggleRail"
  | "closeTab"
  | "nextTab"
  | "previousTab"
  | "agentMode"
  | "newProject";

/**
 * The Studio surface holding keyboard focus.
 *
 * `workspace` is the project column outside a terminal and outside the viewer
 * (the tab strip, the panel header); `none` is everything else, including the
 * agent-mode shell and the welcome screen.
 */
export type StudioSurface = "rail" | "terminal" | "viewer" | "workspace" | "none";

/**
 * A chord as the table states it.
 *
 * `ctrlOrCmd` is ONE flag and not two, because the platform decides which
 * physical modifier satisfies it: Cmd on macOS, Ctrl everywhere else. Two flags
 * would let a row ask for both and there is no such Studio shortcut.
 */
export interface StudioChord {
  /** A `KeyboardEvent.code`. See the module note on codes vs keys. */
  readonly code: string;
  readonly ctrlOrCmd: boolean;
  readonly shift: boolean;
}

/** One row of the contract. */
export interface StudioKeybinding {
  readonly intent: StudioIntent;
  readonly chord: StudioChord;
  /**
   * The surfaces this binding applies on. `"anywhere"` means every surface,
   * including `none`; a list means exactly those.
   */
  readonly when: "anywhere" | readonly StudioSurface[];
  /**
   * What the action is CALLED where it is shown to a user (the empty-workspace
   * watermark). Sentence case, verb first, like every other action label in
   * Studio.
   */
  readonly action: string;
}

/** The surfaces a tab shortcut applies on: the workspace and its two panels. */
const IN_WORKSPACE: readonly StudioSurface[] = ["workspace", "terminal", "viewer"];

/**
 * THE TABLE. Order is the order the watermark lists them in.
 *
 * VS Code counterparts, verified in the checkout at
 * `contrib/terminal/browser/terminalActions.ts:1214-1221` (New terminal),
 * `terminal.contribution.ts:128-129` (Toggle terminal) and
 * `terminalActions.ts:1053-1064` (Split terminal).
 */
export const STUDIO_KEYBINDINGS: readonly StudioKeybinding[] = [
  {
    intent: "newTerminal",
    chord: { code: "Backquote", ctrlOrCmd: true, shift: true },
    when: "anywhere",
    action: "New terminal",
  },
  {
    intent: "toggleTerminal",
    chord: { code: "Backquote", ctrlOrCmd: true, shift: false },
    when: "anywhere",
    action: "Toggle terminal panel",
  },
  {
    // Terminal-only, as in VS Code, where Split's `when` is
    // `TerminalContextKeys.focus`: there is no answer to "split which one?"
    // when no terminal has focus.
    intent: "splitTerminal",
    chord: { code: "Digit5", ctrlOrCmd: true, shift: true },
    when: ["terminal"],
    action: "Split terminal",
  },
  {
    intent: "focusExplorer",
    chord: { code: "KeyE", ctrlOrCmd: true, shift: true },
    when: "anywhere",
    action: "Focus explorer",
  },
  {
    intent: "goToFile",
    chord: { code: "KeyP", ctrlOrCmd: true, shift: false },
    when: "anywhere",
    action: "Go to file",
  },
  {
    intent: "toggleRail",
    chord: { code: "KeyB", ctrlOrCmd: true, shift: false },
    when: "anywhere",
    action: "Toggle sidebar",
  },
  {
    intent: "closeTab",
    chord: { code: "KeyW", ctrlOrCmd: true, shift: false },
    when: IN_WORKSPACE,
    action: "Close tab",
  },
  {
    intent: "nextTab",
    chord: { code: "Tab", ctrlOrCmd: true, shift: false },
    when: IN_WORKSPACE,
    action: "Next tab",
  },
  {
    intent: "previousTab",
    chord: { code: "Tab", ctrlOrCmd: true, shift: true },
    when: IN_WORKSPACE,
    action: "Previous tab",
  },
  {
    intent: "agentMode",
    chord: { code: "KeyA", ctrlOrCmd: true, shift: true },
    when: "anywhere",
    action: "Back to Agent mode",
  },
  {
    intent: "newProject",
    chord: { code: "KeyN", ctrlOrCmd: true, shift: true },
    when: "anywhere",
    action: "New project",
  },
];

/** The shape the resolver reads. A `KeyboardEvent` satisfies it structurally. */
export interface StudioKeyEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Everything outside the event that decides whether a binding applies. */
export interface StudioKeyContext {
  readonly surface: StudioSurface;
  /** A modal dialog is open, so every Studio binding is suspended. */
  readonly dialogOpen: boolean;
  readonly platform: StudioPlatform;
}

/** Whether a binding's `when` admits this surface. */
function appliesOn(binding: StudioKeybinding, surface: StudioSurface): boolean {
  return binding.when === "anywhere" || binding.when.includes(surface);
}

/**
 * Whether the event's modifiers are exactly this chord's.
 *
 * EXACTLY, in both directions: a chord without Shift does not match a keypress
 * with Shift held (`Ctrl+Shift+W` is not `Close tab`), and the modifier that is
 * not Ctrl-or-Cmd on this platform must be UP - otherwise Ctrl+Cmd+B on macOS
 * would toggle the rail, which no label promises.
 */
function modifiersMatch(
  chord: StudioChord,
  event: StudioKeyEvent,
  platform: StudioPlatform,
): boolean {
  if (event.altKey) return false;
  if (event.shiftKey !== chord.shift) return false;
  const primary = platform === "darwin" ? event.metaKey : event.ctrlKey;
  const secondary = platform === "darwin" ? event.ctrlKey : event.metaKey;
  return primary === chord.ctrlOrCmd && !secondary;
}

/**
 * Resolve a key press to a Studio intent, or `null` for "not ours".
 *
 * `null` is the whole contract on the way out: the hook does nothing and does
 * not touch the event, so a key Studio has no binding for reaches the terminal,
 * the tree, the text field or the browser exactly as it would have.
 *
 * At most one binding can match any (chord, surface) pair - the table test
 * proves it by enumeration - so the first match is the only match and no
 * precedence rule is needed. VS Code needs one (`_findCommand` walks its
 * candidates backwards so the last registered rule wins) because users and
 * extensions add rules to its table at runtime; nothing adds a row to this one.
 */
export function resolveStudioKeybinding(
  event: StudioKeyEvent,
  context: StudioKeyContext,
): StudioIntent | null {
  if (context.dialogOpen) return null;
  for (const binding of STUDIO_KEYBINDINGS) {
    if (binding.chord.code !== event.code) continue;
    if (!modifiersMatch(binding.chord, event, context.platform)) continue;
    if (!appliesOn(binding, context.surface)) continue;
    return binding.intent;
  }
  return null;
}
