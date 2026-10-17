/**
 * THE VEX TOGGLE SHORTCUT: Cmd or Ctrl + Shift + Period (docs/design/R3-MINIMAL.md section 2.4).
 * It shows or hides the Vex sidebar exactly as the title bar's token chip does, and the chip's
 * tooltip spells it.
 *
 * WHY THIS CHORD. It collides with nothing the app binds: the Studio table
 * (`studio/keybindings.ts`) binds Backquote, Digit5, Backslash (macOS), KeyE, KeyP, KeyB, KeyW,
 * Enter, Tab, KeyA and KeyN; the Studio terminal's clipboard binds Ctrl+Shift+C, Ctrl+Shift+V,
 * Ctrl+C with a selection and Shift+Insert (`studio/terminal/terminal-clipboard.ts`); Lock Vex is
 * Cmd or Ctrl + Shift + L; Lighter's market search is Cmd or Ctrl + K; the macOS menu carries
 * Lock and the standard edit, app and (dev) view roles, none on Period. The proof is a test that
 * walks the Studio table and the clipboard table on every platform and surface
 * (`__tests__/vex-toggle-shortcut.test.ts`), so a row added there later on Period turns it red.
 *
 * THE GRAMMAR IS THE STUDIO TABLE'S. A `KeyboardEvent.code`, never a `key` (Shift+Period types
 * `>` on a US layout and `:` on a German one; the physical key is what the chord promises). Alt is
 * disqualifying, because AltGr is Ctrl+Alt on many European layouts. Cmd on macOS, Ctrl
 * elsewhere, and the other one must be up. The label follows the Studio label helper's notation:
 * words joined by `+` off macOS (`Ctrl+Shift+.`), glyphs in VS Code's order on macOS (`⇧⌘.`).
 *
 * IN THE STUDIO TERMINAL the chord is refused to xterm (`XtermHost.tsx`), so the keypress travels
 * on to the window listener instead of being encoded for the shell.
 */

import type { StudioPlatform } from "../appShell/studio/keybindings-labels.js";

/** The physical key. */
export const VEX_TOGGLE_CODE = "Period";

/** The shape the predicate reads. A `KeyboardEvent` satisfies it structurally. */
export interface VexToggleKeyEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Whether a key press is the Vex toggle on `platform`. Exact modifiers, Alt never. */
export function isVexToggleChord(event: VexToggleKeyEvent, platform: StudioPlatform): boolean {
  if (event.code !== VEX_TOGGLE_CODE) return false;
  if (event.altKey || !event.shiftKey) return false;
  if (platform === "darwin") return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && !event.metaKey;
}

/** The chord as a person on `platform` reads it. */
export function vexToggleShortcutLabel(platform: StudioPlatform): string {
  return platform === "darwin" ? "⇧⌘." : "Ctrl+Shift+.";
}

/** The chord for `aria-keyshortcuts` (WAI-ARIA names the modifiers, the key is its own value). */
export function vexToggleAriaShortcut(platform: StudioPlatform): string {
  return platform === "darwin" ? "Meta+Shift+." : "Control+Shift+.";
}
