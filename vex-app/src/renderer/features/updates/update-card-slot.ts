/**
 * Where the update card lands (docs/design/R3-MINIMAL.md sections 4 and 12):
 * one sticky card in the left sidebar above the account row, never over the
 * conversation. The sidebar mounts an empty element for it; `UpdateCard`
 * portals into that element while it exists and floats over the window's
 * lower left corner where no sidebar offers one (the pre-shell screens, the
 * rail), so a prompt is never lost for want of a place to stand.
 *
 *   <div ref={setUpdateCardSlot} className="vex-upd-slot" />
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
export function setUpdateCardSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

export function useUpdateCardSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
