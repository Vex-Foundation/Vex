/**
 * Runtime probe for the uiStore `notificationsEnabled` slot (owned by the
 * F4 errors lane, merged separately). The Settings row only renders when
 * the slot exists, so this branch neither depends on that merge order nor
 * fakes a preference that persists nowhere. The `Record` view is the one
 * sanctioned unknown-cast: the slot is absent from this branch's store
 * type until the owning lane lands, at which point these helpers keep
 * working unchanged.
 */

import { useUiStore } from "../../../../stores/uiStore.js";

type SlotView = Record<string, unknown>;

function storeView(): SlotView {
  return useUiStore.getState() as unknown as SlotView;
}

/** True when the store carries both the flag and its setter. */
export function notificationsSlotPresent(): boolean {
  const view = storeView();
  return (
    typeof view["notificationsEnabled"] === "boolean" &&
    typeof view["setNotificationsEnabled"] === "function"
  );
}

/** Reactive read of the flag; false while the slot is absent. */
export function useNotificationsEnabled(): boolean {
  return useUiStore(
    (state) => (state as unknown as SlotView)["notificationsEnabled"] === true,
  );
}

/** Write through the slot's setter; a no-op while the slot is absent. */
export function setNotificationsEnabled(next: boolean): void {
  const setter = storeView()["setNotificationsEnabled"];
  if (typeof setter === "function") {
    (setter as (value: boolean) => void)(next);
  }
}
