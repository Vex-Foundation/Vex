/**
 * WHERE THE VEX TOGGLES MEET THE OPEN COLUMN (docs/design/H3-DESKTOP.md sections 3.4 and 3.6).
 *
 * Three controls hide her (the header's Vex key, the desk's token chip and the Cmd or Ctrl +
 * Shift + B shortcut) and they meet here: a toggle asks `requestVexHide(commit)`, where `commit`
 * is the store write it would have made at once. The open column (`VexSidebar`) answers through
 * its registered closer: it may take the request, play a close and commit when that ends, or
 * decline, and the commit runs now. In H3 her section's own wipe is the close (`KimmSection`,
 * after the write), so the column hands focus on and declines: the write lands at the press.
 * Pressing a toggle again while a close plays keeps her (`keepVex`), and nothing is written.
 *
 * Only a hide the user asked for reaches the column. A column the shell closes on its own (the
 * narrow tier's derived close, a table page's default, Lighter's Zen) goes at once.
 *
 * Module state, not store state: a closing is a moment of the open column, never persisted, and
 * there is at most one column. `useVexClosing()` lets the toggles read it, so while a close plays
 * they already read "Show Vex" and a press keeps her.
 */

import { useSyncExternalStore } from "react";

/** What the open sidebar answers when a toggle asks to hide it. */
export interface VexCloser {
  /**
   * Play her close, then run `commit`; `true` when it took the request. `false` declines (her
   * section's own wipe is the close): the caller commits now.
   */
  readonly close: (commit: () => void) => boolean;
  /** Stop a close in flight: she opens again and nothing is committed. */
  readonly keep: () => void;
}

let closer: VexCloser | null = null;
let closing = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * The open sidebar registers its closer for as long as it is open. The disposer is idempotent and
 * clears only its own registration, so a StrictMode double effect never drops a live one.
 */
export function registerVexCloser(next: VexCloser): () => void {
  closer = next;
  return () => {
    if (closer !== next) return;
    closer = null;
    setVexClosing(false);
  };
}

/** The sidebar reports that her close is playing (or no longer is). */
export function setVexClosing(next: boolean): void {
  if (closing === next) return;
  closing = next;
  emit();
}

/** Whether her close is playing right now. */
export function vexClosing(): boolean {
  return closing;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `vexClosing()` as React state. */
export function useVexClosing(): boolean {
  return useSyncExternalStore(subscribe, vexClosing, () => false);
}

/**
 * Hide Vex the way a toggle should: through her close when the open sidebar can play it, else at
 * once. `commit` is the write the toggle would have made directly.
 */
export function requestVexHide(commit: () => void): void {
  if (closer !== null && closer.close(commit)) return;
  commit();
}

/** A toggle pressed again while she closes: keep her. */
export function keepVex(): void {
  closer?.keep();
}

/**
 * One press of a Vex toggle (the Vex key, the desk's token chip, the shortcut), whatever pressed
 * it: `open` is what the frame solved, `onToggle` the store write that flips it. Open and
 * closing, the press keeps her; open, it hides her through her close; closed, it shows her at
 * once. The three controls share this so a click and a chord can never mean different things.
 */
export function pressVexToggle(open: boolean, onToggle: () => void): void {
  if (open && closing) keepVex();
  else if (open) requestVexHide(onToggle);
  else onToggle();
}
