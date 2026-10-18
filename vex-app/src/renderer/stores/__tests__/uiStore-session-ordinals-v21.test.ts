/**
 * v21: the session ordinal ledger joins the persisted whitelist. The hop seeds
 * the empty ledger, never overwrites a stored one, and every rehydrate coerces.
 * R3 stopped writing it (no setter, no reader) but keeps the key readable:
 * it stays on the whitelist and a stored ledger survives a write.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_ORDINAL_LEDGER,
  mergeUiState,
  migrateUiState,
  partializeUiState,
  PERSISTED_UI_KEYS,
} from "../uiStore/persistence.js";
import { useUiStore } from "../uiStore.js";

describe("uiStore v21 - the session ordinal ledger", () => {
  it("puts the key on the whitelist", () => {
    expect(PERSISTED_UI_KEYS).toContain("sessionOrdinals");
  });

  it("seeds a pre-v21 payload with the empty ledger, leaving other keys alone", () => {
    const after = migrateUiState({ bookOpen: true }, 20) as Record<string, unknown>;
    expect(after["sessionOrdinals"]).toEqual(EMPTY_ORDINAL_LEDGER);
    expect(after["bookOpen"]).toBe(true);
  });

  it("never overwrites a ledger a current-version payload carries", () => {
    const stored = { sessionOrdinals: { next: 2, byId: { a: 1 } } };
    const after = migrateUiState(stored, 21) as Record<string, unknown>;
    expect(after["sessionOrdinals"]).toEqual(stored.sessionOrdinals);
  });

  it("writes a stored ledger back unchanged and offers no setter", () => {
    const stored = { next: 3, byId: { a: 1, b: 2 } };
    const merged = mergeUiState({ sessionOrdinals: stored }, useUiStore.getState());
    expect(partializeUiState(merged)["sessionOrdinals"]).toEqual(stored);
    expect("setSessionOrdinals" in useUiStore.getState()).toBe(false);
  });

  it("coerces a hostile ledger on every rehydrate", () => {
    const merged = mergeUiState(
      { sessionOrdinals: { next: 2, byId: { a: 9 } } },
      useUiStore.getState(),
    );
    expect(merged.sessionOrdinals).toEqual(EMPTY_ORDINAL_LEDGER);
  });
});
