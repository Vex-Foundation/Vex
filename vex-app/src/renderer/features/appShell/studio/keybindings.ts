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
 * ## macOS is NOT "Cmd wherever Windows has Ctrl"
 *
 * That substitution is right for most rows and WRONG for the four VS Code
 * itself writes a `mac:` override for, so this table writes the same four
 * overrides and for the same reasons, read out of the checkout:
 *
 *  - Toggle terminal is `Ctrl+\`` on macOS, not `Cmd+\``
 *    (`terminal.contribution.ts:128-129`, `KeyMod.WinCtrl` - which is the
 *    literal Control key on macOS, not Cmd);
 *  - New terminal is `Ctrl+Shift+\`` on macOS for the same reason
 *    (`terminalActions.ts:1218`);
 *  - Split terminal is `Cmd+\` on macOS with `Ctrl+Shift+5` as a SECONDARY
 *    chord (`terminalActions.ts:1057-1061`), because Cmd+Shift+5 is macOS's
 *    own screenshot capture;
 *  - Next/previous tab stay on Control, because Cmd+Tab is the macOS
 *    application switcher and never reaches a window.
 *
 * A row therefore carries an optional {@link StudioMacOverride}. Off macOS the
 * override is not consulted at all, which is why {@link StudioChord.control}
 * only ever appears inside one.
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
  | "keepTabOpen"
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
  /**
   * The LITERAL Control key, which on macOS is a different physical key from
   * Cmd. Defaults to false and is meaningful only inside a
   * {@link StudioMacOverride}: off macOS Control IS `ctrlOrCmd`, so a
   * non-macOS chord setting both would be asking for one key twice. The table
   * test enumerates that no row does.
   */
  readonly control?: boolean;
}

/**
 * What a row means on macOS, where it means something else.
 *
 * `primary` is the chord the label spells and the watermark shows; `secondary`
 * is an additional chord that resolves to the same intent and is deliberately
 * NOT shown, exactly as VS Code shows one keybinding per command while
 * accepting both.
 */
export interface StudioMacOverride {
  readonly primary: StudioChord;
  readonly secondary?: StudioChord;
}

/** One row of the contract. */
export interface StudioKeybinding {
  readonly intent: StudioIntent;
  readonly chord: StudioChord;
  /** macOS overrides, present only where VS Code itself writes one. */
  readonly mac?: StudioMacOverride;
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
    mac: { primary: { code: "Backquote", ctrlOrCmd: false, shift: true, control: true } },
    when: "anywhere",
    action: "New terminal",
  },
  {
    intent: "toggleTerminal",
    chord: { code: "Backquote", ctrlOrCmd: true, shift: false },
    mac: { primary: { code: "Backquote", ctrlOrCmd: false, shift: false, control: true } },
    when: "anywhere",
    action: "Toggle terminal panel",
  },
  {
    // Terminal-only, as in VS Code, where Split's `when` is
    // `TerminalContextKeys.focus`: there is no answer to "split which one?"
    // when no terminal has focus.
    intent: "splitTerminal",
    chord: { code: "Digit5", ctrlOrCmd: true, shift: true },
    mac: {
      primary: { code: "Backslash", ctrlOrCmd: true, shift: false },
      secondary: { code: "Digit5", ctrlOrCmd: false, shift: true, control: true },
    },
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
    // KEEP THE PREVIEW TAB, VS Code's `workbench.action.keepEditor`.
    //
    // VS CODE'S OWN CHORD IS `Ctrl+K Enter`, A CHORD SEQUENCE, and this table
    // has no sequences: a row is one chord, and `resolveStudioKeybinding` is a
    // pure function of ONE event with no prefix state to carry between two
    // presses. Adding that machinery for a single row would put a
    // "waiting for the second key" mode into every keystroke Studio sees, so
    // this is an INTERIM SINGLE CHORD (coordinator decision, 2026-09-02) and
    // the row moves to `Ctrl+K Enter` if and when the table gains sequences.
    //
    // `Ctrl+Enter` is free: it collides with no Electron menu accelerator
    // (the collision proof below enumerates them) and Studio binds no other
    // Enter. Cmd+Enter on macOS is the ordinary substitution - there is no VS
    // Code `mac:` override to copy here, because the chord it overrides does
    // not exist there either.
    intent: "keepTabOpen",
    chord: { code: "Enter", ctrlOrCmd: true, shift: false },
    when: IN_WORKSPACE,
    action: "Keep tab open",
  },
  {
    intent: "nextTab",
    chord: { code: "Tab", ctrlOrCmd: true, shift: false },
    // Cmd+Tab is the macOS application switcher and never reaches a window.
    mac: { primary: { code: "Tab", ctrlOrCmd: false, shift: false, control: true } },
    when: IN_WORKSPACE,
    action: "Next tab",
  },
  {
    intent: "previousTab",
    chord: { code: "Tab", ctrlOrCmd: true, shift: true },
    mac: { primary: { code: "Tab", ctrlOrCmd: false, shift: true, control: true } },
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
 * THE CHORDS a row is reached by ON THIS PLATFORM, primary first.
 *
 * Off macOS this is always the single base chord: {@link StudioKeybinding.mac}
 * exists precisely because macOS is the platform whose answer differs, and
 * consulting it elsewhere would bind the literal Control key on Windows, where
 * Control is already the primary modifier.
 */
export function studioChordsFor(
  binding: StudioKeybinding,
  platform: StudioPlatform,
): readonly StudioChord[] {
  const override = binding.mac;
  if (platform !== "darwin" || override === undefined) return [binding.chord];
  return override.secondary === undefined
    ? [override.primary]
    : [override.primary, override.secondary];
}

/**
 * The chord a row is SPELLED as on this platform: the primary, always.
 *
 * A secondary chord resolves but is not advertised, which is VS Code's own
 * split between `primary` and `secondary` in a keybinding registration.
 */
export function studioPrimaryChord(
  binding: StudioKeybinding,
  platform: StudioPlatform,
): StudioChord {
  const [primary] = studioChordsFor(binding, platform);
  // `studioChordsFor` never returns an empty list; the fallback exists only
  // because a tuple index is `T | undefined` under `noUncheckedIndexedAccess`.
  return primary ?? binding.chord;
}

/**
 * Whether the event's modifiers are exactly this chord's.
 *
 * EXACTLY, in every direction, and the third direction is what the macOS
 * overrides added: a chord without Shift does not match a keypress with Shift
 * held (`Ctrl+Shift+W` is not `Close tab`); Cmd and Ctrl never stand in for
 * each other; and on macOS the literal Control key must be in exactly the
 * state the chord asks for, so `Ctrl+\`` (Toggle terminal) and `Cmd+\`` (no
 * Studio binding at all) cannot be confused.
 */
function modifiersMatch(
  chord: StudioChord,
  event: StudioKeyEvent,
  platform: StudioPlatform,
): boolean {
  if (event.altKey) return false;
  if (event.shiftKey !== chord.shift) return false;
  const wantsControl = chord.control ?? false;
  if (platform === "darwin") {
    return event.metaKey === chord.ctrlOrCmd && event.ctrlKey === wantsControl;
  }
  // Off macOS Control IS the primary modifier, so a chord cannot ask for both
  // and Meta (Windows/Super) is never part of a Studio chord.
  if (wantsControl) return false;
  return event.ctrlKey === chord.ctrlOrCmd && !event.metaKey;
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
    if (!appliesOn(binding, context.surface)) continue;
    for (const chord of studioChordsFor(binding, context.platform)) {
      if (chord.code !== event.code) continue;
      if (!modifiersMatch(chord, event, context.platform)) continue;
      return binding.intent;
    }
  }
  return null;
}
