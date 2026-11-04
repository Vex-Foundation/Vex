/**
 * KEYCAPS: a chord drawn as its keys, one cap per key, in the platform's own
 * spelling (docs/design/H3-DESKTOP.md section 2.4 and Appendix A.9).
 *
 *   <Keycaps chord={VEX_TOGGLE_CHORD} />   ⇧ ⌘ B on macOS, Ctrl Shift B elsewhere
 *
 * THE SPELLING IS THE STUDIO LABEL HELPER'S (`keybindings-labels.ts`), split
 * into caps instead of joined: off macOS the words in VS Code's order (Ctrl,
 * Shift, the key), on macOS the glyphs with Cmd last, because Cmd is the Meta
 * modifier there (⇧ ⌘ B, never ⌘ ⇧ B). The literal Control key, which only a
 * macOS override can name, goes first (⌃). The key's own name comes from the
 * same table (`keyLabel`), so a chord this module cannot spell renders no caps
 * rather than a cap with a code in it. `keycaps.test.tsx` holds the two to
 * one spelling: the caps joined as the label helper joins them are its label.
 *
 * WORDS ARE WRITTEN IN SENTENCE CASE ("Ctrl", "Shift", "B") and the Vex key's
 * caps register uppercases them (CTRL, SHIFT, B), so a screen reader reads
 * words. The first-close hint (`variant="hint"`, S4-15) draws the same caps
 * larger and in title case, as the plate does ("Ctrl", "Shift", "B").
 *
 * Each cap is a `kbd` inside the chord's `kbd`, HTML's own markup for a key
 * combination. Beside a control whose name already carries the chord
 * (`aria-keyshortcuts`, a tooltip "Show Vex (Ctrl+Shift+B)") the caps are a
 * picture of it: `decorative` hides them from assistive technology, so the
 * chord is not read twice.
 *
 * Styles: `.vex-keycaps` in `styles/global-css/title-bar.css` (19 high, a 1px
 * chosen-rule border, caps 11 to 12, 3 apart; section 2.4).
 */

import type { JSX } from "react";
import { cn } from "../../lib/utils.js";
import type { StudioChord } from "../../features/appShell/studio/keybindings.js";
import {
  keyLabel,
  studioPlatform,
  type StudioPlatform,
} from "../../features/appShell/studio/keybindings-labels.js";

/** What each modifier is called on a cap, per platform, and whether Cmd prints last. */
interface CapNames {
  readonly ctrlOrCmd: string;
  readonly shift: string;
  /** The literal Control key: only a macOS chord can name it apart from Ctrl-or-Cmd. */
  readonly control: string;
  /** Ctrl-or-Cmd is the Meta modifier here, so it follows Shift. */
  readonly ctrlOrCmdLast: boolean;
}

const CAP_NAMES: Readonly<Record<StudioPlatform, CapNames>> = {
  darwin: { ctrlOrCmd: "⌘", shift: "⇧", control: "⌃", ctrlOrCmdLast: true },
  win32: { ctrlOrCmd: "Ctrl", shift: "Shift", control: "Ctrl", ctrlOrCmdLast: false },
  linux: { ctrlOrCmd: "Ctrl", shift: "Shift", control: "Ctrl", ctrlOrCmdLast: false },
};

/**
 * The caps of `chord` on `platform`, in the order they are pressed and read,
 * or an empty list when the key has no name in the label table.
 */
export function keycapsOf(chord: StudioChord, platform: StudioPlatform): readonly string[] {
  const key = keyLabel(chord.code);
  if (key === null) return [];
  const names = CAP_NAMES[platform];
  const caps: string[] = [];
  if (chord.control === true) caps.push(names.control);
  if (chord.ctrlOrCmd && !names.ctrlOrCmdLast) caps.push(names.ctrlOrCmd);
  if (chord.shift) caps.push(names.shift);
  if (chord.ctrlOrCmd && names.ctrlOrCmdLast) caps.push(names.ctrlOrCmd);
  caps.push(key);
  return caps;
}

export interface KeycapsProps {
  readonly chord: StudioChord;
  /** Whose keys to spell; this window's by default. */
  readonly platform?: StudioPlatform;
  /**
   * `key`: the Vex key's caps, caps letters at 11 (the default). `hint`: the
   * first-close hint's, larger and in title case.
   */
  readonly variant?: "key" | "hint";
  /** Hidden from assistive technology: the control beside it already names the chord. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function Keycaps({
  chord,
  platform = studioPlatform,
  variant = "key",
  decorative = false,
  className,
}: KeycapsProps): JSX.Element | null {
  const caps = keycapsOf(chord, platform);
  if (caps.length === 0) return null;
  return (
    <kbd
      className={cn("vex-keycaps", className)}
      data-variant={variant}
      data-platform={platform}
      aria-hidden={decorative ? true : undefined}
    >
      {caps.map((cap) => (
        <kbd key={cap} className="vex-keycap">
          {cap}
        </kbd>
      ))}
    </kbd>
  );
}
