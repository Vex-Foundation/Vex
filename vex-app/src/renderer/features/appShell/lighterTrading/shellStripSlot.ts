/**
 * Where the shell strip's flank (notices, approvals, export) lands in Lighter
 * mode. The desk has no header row of its own: the market bar is the top
 * edge, exchange-style, so the strip portals its controls into the bar's
 * right end instead of drawing an empty 44px band above it. The strip stays
 * mounted once in `AppShell` (it owns the approvals live sync); only its DOM
 * output moves.
 */

import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Callback ref for the desk's slot element; a null on unmount clears it. */
export function setShellStripSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

export function useShellStripSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
