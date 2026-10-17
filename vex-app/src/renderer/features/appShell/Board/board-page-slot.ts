/**
 * Where the Board page hands the board host its body
 * (docs/design/R3-MINIMAL.md section 9.4). The host (`BoardModalHost`) stays
 * mounted once at shell level, because it owns the board's lifecycle: the
 * one close path, the exits on a session switch and on shell teardown, and
 * the identity every slot is keyed by. The page (`screens/BoardScreen.tsx`)
 * only provides the element the host renders into, so opening and leaving
 * the page never moves the lease to a second owner.
 *
 * The slot exists only while the page is mounted: the page's callback ref
 * clears it on unmount and the host then renders nothing.
 *
 *   <div ref={setBoardPageSlot} />                 the page
 *   const slot = useBoardPageSlot();               the host
 *   return slot === null ? null : createPortal(<Body />, slot);
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

/** Callback ref for the page's body element; a null on unmount clears it. */
export function setBoardPageSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

export function useBoardPageSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
