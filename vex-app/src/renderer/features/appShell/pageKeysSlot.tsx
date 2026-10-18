/**
 * The title bar's page keys (docs/design/R3-MINIMAL.md section 3: the right
 * cluster starts with the page keys, refresh and export). A page draws its
 * key with `PageKey`; the key lands at the start of the title bar's right
 * cluster, which `RunningHead` mounts once (in Lighter the cluster rides in
 * the desk's title row, and the slot with it). Without a title bar (a page
 * rendered alone, a test) the key stays where the page drew it.
 *
 * Only the key's DOM moves: it stays in the page's React tree, so its state
 * (in flight, an outcome the page shows beside its figures) is the page's.
 */

import { useSyncExternalStore, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Callback ref for the title bar's slot element; a null on unmount clears it. */
export function setPageKeysSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

export function usePageKeysSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

/**
 * A page key: in the title bar when it stands, else in place. `children`
 * gets whether it sits in the title bar, so it can take the bar's key style.
 */
export function PageKey({
  children,
}: {
  readonly children: (inTitleBar: boolean) => ReactNode;
}): JSX.Element {
  const target = usePageKeysSlot();
  return target === null ? <>{children(false)}</> : createPortal(children(true), target);
}
