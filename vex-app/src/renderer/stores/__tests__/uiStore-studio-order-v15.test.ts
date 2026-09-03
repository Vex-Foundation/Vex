/**
 * The Studio rail's persisted order, and the v15 hop that introduced it.
 *
 * Three properties carry the risk, and each is red if its line is reverted:
 *  1. `studioBookSectionOrder` is ON THE WHITELIST. Absent from
 *     `PERSISTED_UI_KEYS` the slot is ephemeral in BOTH directions by
 *     construction - the user's Studio arrangement would silently vanish on
 *     relaunch while every other rail preference survived.
 *  2. The read side COERCES it. The payload is user-writable localStorage and
 *     `migrate` only runs on a version hop, so a hand-edited current-version
 *     payload reaches `merge` unmigrated.
 *  3. The v15 migration is EXPAND-ONLY: it seeds the key on an older payload
 *     and rewrites nothing else - including the agent rail's own order, which
 *     is a separate key precisely so one rail cannot overwrite the other.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  mergeUiState,
  migrateUiState,
  partializeUiState,
  PERSISTED_UI_KEYS,
} from "../uiStore/persistence.js";
import { useUiStore } from "../uiStore.js";

function currentState(): ReturnType<typeof useUiStore.getState> {
  return useUiStore.getState();
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    runtimeMode: "agent",
    activeProjectId: null,
    bookSectionOrder: [],
    studioBookSectionOrder: [],
  });
});

describe("the Studio order is a persisted slot of its own", () => {
  it("is on the ONE whitelist, so it round-trips in both directions", () => {
    expect([...PERSISTED_UI_KEYS]).toContain("studioBookSectionOrder");
    useUiStore.getState().setStudioBookSectionOrder(["balances", "portfolio"]);
    const payload = partializeUiState(currentState());
    expect(payload["studioBookSectionOrder"]).toEqual([
      "balances",
      "portfolio",
    ]);
  });

  it("round-trips through the merge without touching the agent order", () => {
    const merged = mergeUiState(
      {
        bookSectionOrder: ["trench", "wallets"],
        studioBookSectionOrder: ["balances", "portfolio"],
      },
      currentState(),
    );
    expect(merged.bookSectionOrder).toEqual(["trench", "wallets"]);
    expect(merged.studioBookSectionOrder).toEqual(["balances", "portfolio"]);
  });

  it("the two rails are genuinely separate keys, not one alias", () => {
    const merged = mergeUiState(
      { bookSectionOrder: ["trench"] },
      currentState(),
    );
    expect(merged.bookSectionOrder).toEqual(["trench"]);
    expect(merged.studioBookSectionOrder).toEqual([]);
  });
});

describe("a hand-edited Studio order is coerced on EVERY rehydrate", () => {
  it("degrades an off-shape payload to the default order", () => {
    const current = currentState();
    for (const hostile of [
      "portfolio",
      42,
      { 0: "portfolio" },
      [1, 2, 3],
      ["portfolio", null],
      [""],
      ["x".repeat(33)],
      Array.from({ length: 33 }, () => "portfolio"),
    ]) {
      const merged = mergeUiState(
        { studioBookSectionOrder: hostile },
        current,
      );
      expect(merged.studioBookSectionOrder).toEqual([]);
    }
  });

  it("keeps a bounded, well-shaped order verbatim (resolution happens later)", () => {
    // The merge is a BOUND, not a registry: unknown-id filtering belongs to
    // `resolveStudioBookSectionOrder`, which the rail runs before rendering.
    const merged = mergeUiState(
      { studioBookSectionOrder: ["balances", "not-a-section"] },
      currentState(),
    );
    expect(merged.studioBookSectionOrder).toEqual([
      "balances",
      "not-a-section",
    ]);
  });

  it("an injected ephemeral slot is still dropped alongside it", () => {
    // `currentView` is the boot machine and is still ephemeral in both
    // directions. `runtimeMode` moved onto the whitelist in v17 (the last
    // Studio location) and is coerced rather than dropped; that pair is pinned
    // in `uiStore-persist-hardening.test.ts`.
    const current = currentState();
    const merged = mergeUiState(
      { studioBookSectionOrder: ["portfolio"], currentView: "wizard" },
      current,
    );
    expect(merged.studioBookSectionOrder).toEqual(["portfolio"]);
    // The STORE-CONSTRUCTED value, not a literal written a second time here.
    expect(merged.currentView).toBe(current.currentView);
  });
});

describe("the v15 migration", () => {
  it("seeds the key on a v14 payload and rewrites nothing else", () => {
    const v14 = {
      bookTab: "board",
      bookSectionOrder: ["trench", "wallets"],
      themePreference: "celeris",
    };
    const migrated = migrateUiState(v14, 14) as Record<string, unknown>;
    expect(migrated["studioBookSectionOrder"]).toEqual([]);
    expect(migrated["bookSectionOrder"]).toEqual(["trench", "wallets"]);
    expect(migrated["bookTab"]).toBe("board");
    expect(migrated["themePreference"]).toBe("celeris");
  });

  it("never overwrites an order a v15 payload already carries", () => {
    const migrated = migrateUiState(
      { studioBookSectionOrder: ["balances"] },
      15,
    ) as Record<string, unknown>;
    expect(migrated["studioBookSectionOrder"]).toEqual(["balances"]);
  });

  it("seeds it on the oldest payload too, alongside every earlier hop", () => {
    const migrated = migrateUiState({}, 1) as Record<string, unknown>;
    expect(migrated["studioBookSectionOrder"]).toEqual([]);
    expect(migrated["bookSectionOrder"]).toEqual([]);
    expect(migrated["bookTab"]).toBe("portfolio");
  });
});
