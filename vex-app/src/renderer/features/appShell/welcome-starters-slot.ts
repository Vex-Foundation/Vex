/**
 * THE WELCOME'S SUGGESTIONS SLOT (docs/design/H3-DESKTOP.md section 6.6; the
 * owner's D2 plate "New chat, greeting"): the greeting, its notes and the
 * two-by-two suggestions are one group at the top of the reading column. The
 * suggestions are the composer's (`ComposerQuickActions`, which owns the
 * draft they seed, their concealment while the draft has text and their
 * dimming while a send is made), so the welcome opens a slot under its notes
 * and the composer portals the grid into it. With no welcome mounted (no
 * slot) the composer keeps the grid in its own seat, as before.
 *
 * One slot per window, as the Vex column's own slot (`vex-sidebar-slot.ts`).
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

/** Callback ref for the welcome's slot element; a null on unmount clears it. */
export function setWelcomeStartersSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

/** The welcome's slot while the welcome stands, else null. */
export function useWelcomeStartersSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
