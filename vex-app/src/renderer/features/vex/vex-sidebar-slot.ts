/**
 * Where a page hands the Vex sidebar a block of its own
 * (docs/design/R3-MINIMAL.md section 5.1): the Board's "Ask Vex" about the
 * open token sits under Needs you, in Vex's column, rather than in a drawer
 * of its own. The sidebar stays mounted once in `AppShell`; the page portals
 * its block into this element, so the block keeps the page's state and the
 * sidebar never learns what a page puts there.
 *
 * The slot exists only while the sidebar is open: a hidden sidebar clears it,
 * and a page then renders nothing there (`useVexSidebarSlot()` returns
 * `null`). Under the inspect takeover the slot stays mounted, hidden with the
 * rest of the body, so the page's block keeps its state.
 *
 *   const slot = useVexSidebarSlot();
 *   return slot === null ? null : createPortal(<AskVex />, slot);
 */

import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Callback ref for the sidebar's slot element; a null on unmount clears it. */
export function setVexSidebarSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

export function useVexSidebarSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
