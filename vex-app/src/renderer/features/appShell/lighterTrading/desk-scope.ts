/**
 * The desk's current scope tag, published by the chat rail while the desk is
 * mounted and read by `composer-submit.ts` when a typed message is sent. Null
 * outside the desk (the rail clears it on unmount), so the composer needs no
 * mode check of its own. UI-only, never persisted.
 */

import { create } from "zustand";

interface DeskScopeState {
  readonly tag: string | null;
  readonly setDeskScopeTag: (tag: string | null) => void;
}

export const useDeskScopeStore = create<DeskScopeState>((set) => ({
  tag: null,
  setDeskScopeTag: (tag) => set({ tag }),
}));
