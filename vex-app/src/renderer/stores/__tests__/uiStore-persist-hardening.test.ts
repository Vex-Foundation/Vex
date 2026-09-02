/**
 * THE READ SIDE of `vex-ui` persistence is a trust boundary.
 *
 * localStorage is user-writable, so a `vex-ui` payload is untrusted input in
 * exactly the sense rule 04 means it. Before stage B4a the write side had a
 * whitelist (`partializeUiState`) and the read side had a SPREAD - it merged
 * whatever object it found over the live state and coerced seven fields. A
 * hand-edited payload could therefore inject any slot the store declares:
 * `runtimeMode` (which decides whether the shell mounts Studio),
 * `activeProjectId`, `currentView` (the boot machine), `activeSessionId`.
 *
 * These tests pin the fix from BOTH directions: the ephemeral slots cannot
 * arrive from storage, the persisted ones still round-trip, and the two new
 * actions never appear in what is written.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  mergeUiState,
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
    activeSessionId: null,
    currentView: "appShell",
    sidebarOpen: true,
    bookOpen: true,
    bookTab: "portfolio",
    hideDustBalances: true,
    notificationsEnabled: true,
    bookSectionOrder: [],
  });
});

describe("mergeUiState rejects everything outside the persisted whitelist", () => {
  it("drops every ephemeral slot a hand-edited payload can name", () => {
    const current = currentState();
    const injected = {
      // The whole point: none of these may survive the rehydrate.
      runtimeMode: "studio",
      activeProjectId: "9c1b0e8e-0000-4000-8000-000000000000",
      activeSessionId: "44444444-4444-4444-8444-444444444444",
      currentView: "wizard",
      setupGateActive: false,
      sessionModeFilter: "mission",
      createSessionOpen: true,
      shellRoute: { kind: "memory" },
      // A FUNCTION-SHAPED value aimed at an action slot. A spread would have
      // installed it and the shell would call attacker-supplied code on the
      // next mode switch.
      setRuntimeMode: () => undefined,
      logBuffer: [{ level: "error", message: "injected" }],
    } as unknown;

    const merged = mergeUiState(injected, current);

    expect(merged.runtimeMode).toBe("agent");
    expect(merged.activeProjectId).toBeNull();
    expect(merged.activeSessionId).toBeNull();
    expect(merged.currentView).toBe("appShell");
    expect(merged.setupGateActive).toBe(current.setupGateActive);
    expect(merged.sessionModeFilter).toBe("all");
    expect(merged.createSessionOpen).toBe(false);
    expect(merged.shellRoute).toEqual({ kind: "none" });
    expect(merged.logBuffer).toEqual([]);
    // The real action survived; the injected function never reached the slot.
    expect(merged.setRuntimeMode).toBe(current.setRuntimeMode);
  });

  it("still round-trips every whitelisted field", () => {
    const current = currentState();
    const payload = {
      themePreference: "celeris",
      sidebarOpen: false,
      bookOpen: false,
      sidebarWidth: 300,
      bookWidth: 400,
      hideDustBalances: false,
      notificationsEnabled: false,
      bookSectionOrder: ["wallets", "balances"],
      bookTab: "board",
    };

    const merged = mergeUiState(payload, current);

    expect(merged.themePreference).toBe("celeris");
    expect(merged.sidebarOpen).toBe(false);
    expect(merged.bookOpen).toBe(false);
    expect(merged.sidebarWidth).toBe(300);
    expect(merged.bookWidth).toBe(400);
    expect(merged.hideDustBalances).toBe(false);
    expect(merged.notificationsEnabled).toBe(false);
    expect(merged.bookSectionOrder).toEqual(["wallets", "balances"]);
    expect(merged.bookTab).toBe("board");
  });

  it("coerces the rail booleans, which the whitelist let through RAW", () => {
    // Being ON the whitelist makes a key persistable, not trustworthy.
    // `sidebarOpen` and `bookOpen` are declared persisted keys, so before this
    // coercion a hand-edited value went straight into the slot and reached the
    // column solver and the rails' width/hidden props as a non-boolean.
    const current = currentState();
    const hostile = [
      "yes",
      "false",
      0,
      1,
      null,
      [],
      {},
      () => undefined,
    ] as const;

    for (const value of hostile) {
      const merged = mergeUiState(
        { sidebarOpen: value, bookOpen: value } as unknown,
        current,
      );
      // The fallback is the STORE-CONSTRUCTED value, not a literal written a
      // second time here.
      expect(merged.sidebarOpen).toBe(current.sidebarOpen);
      expect(merged.bookOpen).toBe(current.bookOpen);
      expect(typeof merged.sidebarOpen).toBe("boolean");
      expect(typeof merged.bookOpen).toBe("boolean");
    }
  });

  it("survives a payload that is not an object at all", () => {
    const current = currentState();
    for (const hostile of [null, 42, "vex", true]) {
      const merged = mergeUiState(hostile, current);
      expect(merged.runtimeMode).toBe("agent");
      expect(merged.bookTab).toBe("portfolio");
    }
  });
});

describe("partializeUiState writes exactly the whitelist", () => {
  it("never carries runtimeMode, activeProjectId or their actions", () => {
    useUiStore.getState().setRuntimeMode("studio");
    useUiStore.getState().setActiveProjectId("9c1b0e8e-0000-4000-8000-000000000000");

    const payload = partializeUiState(currentState());
    const keys = Object.keys(payload).toSorted();

    expect(keys).toEqual([...PERSISTED_UI_KEYS].toSorted());
    expect(keys).not.toContain("runtimeMode");
    expect(keys).not.toContain("activeProjectId");
    expect(keys).not.toContain("setRuntimeMode");
    expect(keys).not.toContain("setActiveProjectId");
  });

  it("is the SAME list the merge reads, so the two cannot drift", () => {
    const written = Object.keys(partializeUiState(currentState())).toSorted();
    expect(written).toEqual([...PERSISTED_UI_KEYS].toSorted());
  });
});

describe("the new uiStore actions", () => {
  it("setRuntimeMode switches the mode and nothing else", () => {
    useUiStore.getState().setRuntimeMode("studio");
    expect(currentState().runtimeMode).toBe("studio");
    expect(currentState().activeSessionId).toBeNull();
    useUiStore.getState().setRuntimeMode("agent");
    expect(currentState().runtimeMode).toBe("agent");
  });

  it("setActiveProjectId selects and clears", () => {
    useUiStore.getState().setActiveProjectId("9c1b0e8e-0000-4000-8000-000000000000");
    expect(currentState().activeProjectId).toBe(
      "9c1b0e8e-0000-4000-8000-000000000000",
    );
    useUiStore.getState().setActiveProjectId(null);
    expect(currentState().activeProjectId).toBeNull();
  });
});
