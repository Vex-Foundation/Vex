/**
 * THE VEX TOGGLE SHORTCUT, BOUND AT THE SHELL (docs/design/H3-DESKTOP.md
 * sections 3.3 and 4.4): Cmd + Shift + B on macOS, Ctrl + Shift + B on Windows
 * and Linux (and, for one release, R3's Period chord, unspelled) opens and
 * closes her from anywhere in the shell. The frame mounts this once
 * (`AppShell.tsx`), with the toggle it solved: the same open state and the
 * same write the Vex key and the desk's token chip are handed, pressed
 * through the same `pressVexToggle`, so a chord and a click never mean
 * different things. R3 bound it inside the token chip, so it lived only while
 * a chip was mounted; this listener lives as long as the shell.
 *
 * The guards are the chip's, unchanged:
 *   - a held key's repeats are ignored: one press, one toggle;
 *   - a key someone nearer already took (`defaultPrevented`) is theirs;
 *   - while a modal dialog is open no shortcut moves the shell under it
 *     (`isDialogOnScreen`), as the Studio table is suspended too;
 *   - with no Vex to toggle (Lighter's Zen, where her column is the assistant
 *     overlay) the frame hands in `null` and nothing is bound.
 * The Studio terminal refuses both chords to xterm (`XtermHost.tsx`), so the
 * keypress reaches this listener instead of the shell in the pane. A text
 * field does not stop it: the chord types nothing, and her column is one
 * press away wherever focus is.
 */

import { useEffect, useRef } from "react";
import { isDialogOnScreen } from "../../components/ui/dialog.js";
import { studioPlatform, type StudioPlatform } from "../appShell/studio/keybindings-labels.js";
import { pressVexToggle } from "./vex-hide.js";
import { isVexToggleChord } from "./vex-toggle-shortcut.js";

/** What the shortcut presses: her open state as the frame solved it, and its write. */
export interface VexToggleTarget {
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function useVexToggleShortcut(
  toggle: VexToggleTarget | null,
  platform: StudioPlatform = studioPlatform,
): void {
  // The listener reads the latest toggle without rebinding on every render.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const bound = toggle !== null;
  useEffect(() => {
    if (!bound) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (!isVexToggleChord(event, platform)) return;
      // A modal decision is pending: no shortcut moves the shell under it.
      if (isDialogOnScreen(document)) return;
      const current = toggleRef.current;
      if (current === null) return;
      event.preventDefault();
      pressVexToggle(current.open, current.onToggle);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [bound, platform]);
}
