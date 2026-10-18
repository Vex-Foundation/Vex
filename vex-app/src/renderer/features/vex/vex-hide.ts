/**
 * HIDING VEX PLAYS HER CLOSE FIRST (docs/design/R3-MINIMAL.md sections 2.4, 5.1 and 11): when the
 * user hides the Vex sidebar, she collapses into her token in the plate (the K2 close episode) and
 * only then does the column go (its track closes to zero on the shell's reveal transition). Under
 * reduced motion or Save-Data there is no episode to wait for, so the column goes at once; with
 * the avatar off, or her plate hidden under the inspect view, there is nothing of her to close, so
 * it goes at once too.
 *
 * Three controls hide her (the sidebar's own hide key, the title bar's token chip and the
 * Cmd or Ctrl + Shift + Period shortcut) and one component plays the close (the open sidebar).
 * They meet here: a toggle asks `requestVexHide(commit)`, where `commit` is the store write it
 * would have made at once; the open sidebar either plays her close and commits when it ends, or
 * declines and the commit runs now. Pressing a toggle again while she closes keeps her
 * (`keepVex`): the close stops and she opens from the token again, and nothing was written.
 *
 * Only a hide the user asked for waits. A column the shell closes on its own (the narrow tier's
 * derived close, a table page's default, Lighter's Zen) goes at once, so a left sidebar opening
 * beside her is never held back.
 *
 * Module state, not store state: a closing is a moment of the open sidebar, never persisted, and
 * there is at most one sidebar. `useVexClosing()` lets the chip read it, so while she closes the
 * chip already reads "Show Vex" and its press keeps her.
 */

import { useSyncExternalStore } from "react";
import { CLOSE_MS } from "../../components/vex/k2/k2-time.js";

/**
 * How long a hide waits for her close: the episode's own length on her clock, imported rather
 * than restated, so the column never goes in the middle of it nor stands as a bare token after.
 */
export const VEX_HIDE_EPISODE_MS = CLOSE_MS;

/** What the open sidebar answers when a toggle asks to hide it. */
export interface VexCloser {
  /**
   * Play her close, then run `commit`; `true` when it took the request. `false` declines (the
   * still frame, no plate on screen): the caller commits now.
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
