/**
 * Where the desk's own review lands (docs/design/R3-MINIMAL.md section 8.6):
 * "Review order" replaces the ticket inline, in the ticket's column, instead
 * of a modal over the desk.
 *
 * The ticket owns the place (it renders the slot element beside its form);
 * `DeskApprovalDialog` stays mounted where the desk mounts it, owns the
 * decision state, and portals its cards into the slot. While a review shows
 * there, the ticket hides its form (kept mounted, so a draft survives the
 * review) and shows the slot; when the last card resolves or the trader
 * presses Escape, the ticket comes back.
 *
 * Two facts, one tiny store: the slot element, and whether a review is
 * showing in it.
 */

import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
let showing = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Callback ref for the ticket's slot element; a null on unmount clears it. */
export function setDeskReviewSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  emit();
}

export function useDeskReviewSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

/** Set by the review: true while it shows its cards in the slot. */
export function setDeskReviewShowing(next: boolean): void {
  if (showing === next) return;
  showing = next;
  emit();
}

export function useDeskReviewShowing(): boolean {
  return useSyncExternalStore(subscribe, () => showing, () => false);
}
