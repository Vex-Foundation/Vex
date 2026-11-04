/**
 * THE VEX TOGGLE SHORTCUT: Cmd + Shift + B on macOS, Ctrl + Shift + B on Windows and Linux
 * (docs/design/H3-DESKTOP.md section 4.4 and Appendix A.9). It opens and closes her exactly as the
 * header's Vex key does, from anywhere in the shell: the frame binds it once
 * (`useVexToggleShortcut.ts`), and the key's tooltip and keycaps spell it. Desktop binds it on
 * Linux too, where Cloud leaves it unbound: the app owns its keys, and the chord collides with
 * nothing in it.
 *
 * THE RETIRING ALIAS. R3's chord, Cmd or Ctrl + Shift + Period, still matches for ONE release, so
 * a hand that learned it is not stranded the day H3 ships. It goes in the release after the one
 * that carries H3: delete `VEX_TOGGLE_RETIRING_CHORD`, its branch in `isVexToggleChord` and the
 * tests that name it. Nothing spells it: keycaps, tooltips, `aria-keyshortcuts` and the help text
 * show only the new chord.
 *
 * WHY THIS CHORD. Neither chord collides with anything the app binds, compared as whole chords
 * (the code AND its modifiers), not as keys: the Studio table (`studio/keybindings.ts`) binds KeyB
 * as Ctrl or Cmd + B with Shift UP (Toggle sidebar), and its matcher requires exact modifiers, so
 * Shift held is not that row; no Studio row is on Period. The Studio terminal's clipboard binds
 * Ctrl+Shift+C, Ctrl+Shift+V, Ctrl+C with a selection, Ctrl+V on Windows, Shift+Insert on Linux
 * and Cmd+C or Cmd+V on macOS (`studio/terminal/terminal-clipboard.ts`); Lock Vex is Cmd or Ctrl +
 * Shift + L; Lighter's market search is Cmd or Ctrl + K; the macOS menu carries Lock and the
 * standard edit, app and (dev) view roles, none on B or Period. The proof is a test that walks the
 * Studio table and the clipboard decision on every platform, surface and modifier combination
 * (`__tests__/vex-toggle-shortcut.test.ts`), so a row added there later on either chord turns it
 * red.
 *
 * THE GRAMMAR IS THE STUDIO TABLE'S. A `KeyboardEvent.code`, never a `key` (Shift+B types `B`,
 * and Shift+Period types `>` on a US layout and `:` on a German one; the physical key is what the
 * chord promises). Alt is disqualifying, because AltGr is Ctrl+Alt on many European layouts. Cmd
 * on macOS, Ctrl elsewhere, and the other one must be up. The label is the Studio label helper's
 * notation: words joined by `+` off macOS (`Ctrl+Shift+B`), glyphs in VS Code's order on macOS
 * (`⇧⌘B`).
 *
 * IN THE STUDIO TERMINAL both chords are refused to xterm (`XtermHost.tsx`), so the keypress
 * travels on to the window listener instead of being encoded for the shell.
 */

import type { StudioChord } from "../appShell/studio/keybindings.js";
import type { StudioPlatform } from "../appShell/studio/keybindings-labels.js";

/** The chord, in the Studio table's terms: KeyB, Shift, and the platform's primary modifier. */
export const VEX_TOGGLE_CHORD: StudioChord = { code: "KeyB", ctrlOrCmd: true, shift: true };

/** The physical key of the chord. */
export const VEX_TOGGLE_CODE = VEX_TOGGLE_CHORD.code;

/**
 * RETIRING: R3's chord, Cmd or Ctrl + Shift + Period. It still toggles her for one release and is
 * never spelled anywhere; see the module note for when and how it goes.
 */
export const VEX_TOGGLE_RETIRING_CHORD: StudioChord = { code: "Period", ctrlOrCmd: true, shift: true };

/** The shape the predicate reads. A `KeyboardEvent` satisfies it structurally. */
export interface VexToggleKeyEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Exactly the toggle's modifiers on `platform`: Shift, the primary modifier, the other one up, Alt never. */
function hasToggleModifiers(event: VexToggleKeyEvent, platform: StudioPlatform): boolean {
  if (event.altKey || !event.shiftKey) return false;
  if (platform === "darwin") return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && !event.metaKey;
}

/**
 * Whether a key press is the Vex toggle on `platform`: the chord, or for one release the retiring
 * Period alias. Exact modifiers, Alt never.
 */
export function isVexToggleChord(event: VexToggleKeyEvent, platform: StudioPlatform): boolean {
  if (event.code !== VEX_TOGGLE_CHORD.code && event.code !== VEX_TOGGLE_RETIRING_CHORD.code) return false;
  return hasToggleModifiers(event, platform);
}

/** The chord as a person on `platform` reads it. Never the retiring alias. */
export function vexToggleShortcutLabel(platform: StudioPlatform): string {
  return platform === "darwin" ? "⇧⌘B" : "Ctrl+Shift+B";
}

/** The chord for `aria-keyshortcuts` (WAI-ARIA names the modifiers, the key is its own value). */
export function vexToggleAriaShortcut(platform: StudioPlatform): string {
  return platform === "darwin" ? "Meta+Shift+B" : "Control+Shift+B";
}

/**
 * The toggle's name: what a press does now (docs/design/H3-DESKTOP.md section 1.6). Open, it
 * hides her; closed, it shows her. Every control that carries the press is named this.
 */
export function vexToggleName(open: boolean): string {
  return open ? "Hide Vex" : "Show Vex";
}

/**
 * The tooltip: the name and the chord that does the same (Appendix A.9), "Show Vex
 * (Ctrl+Shift+B)", "Hide Vex (⇧⌘B)".
 */
export function vexToggleTooltipLabel(open: boolean, platform: StudioPlatform): string {
  return `${vexToggleName(open)} (${vexToggleShortcutLabel(platform)})`;
}
