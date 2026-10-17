/**
 * v22: the R3 frame's four slots join the persisted whitelist
 * (docs/design/R3-MINIMAL.md section 2.3). The hop seeds `leftOpen` from
 * `sidebarOpen` and `vexOpenChat` from `bookOpen`, adds `vexOpenPages` false
 * and `showAvatar` true, never overwrites a stored value, and leaves every old
 * key in the payload untouched; every rehydrate coerces.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  mergeUiState,
  migrateUiState,
  partializeUiState,
  PERSISTED_UI_KEYS,
} from "../uiStore/persistence.js";
import { selectVexOpen, useUiStore } from "../uiStore.js";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    leftOpen: true,
    sidebarOpen: true,
    vexOpenChat: true,
    vexOpenPages: false,
    vexOpenLighter: false,
    showAvatar: true,
    bookOpen: true,
    sidebarNarrowExpanded: false,
  });
});

describe("uiStore v22 - the R3 frame", () => {
  it("puts the four keys on the whitelist, which is what makes them persist", () => {
    for (const key of ["leftOpen", "vexOpenChat", "vexOpenPages", "showAvatar"] as const) {
      expect(PERSISTED_UI_KEYS).toContain(key);
    }
    const payload = partializeUiState(useUiStore.getState());
    expect(payload["vexOpenPages"]).toBe(false);
    expect(payload["showAvatar"]).toBe(true);
  });

  it("seeds a pre-v22 payload from the old slots, leaving every old key alone", () => {
    const before = {
      sidebarOpen: false,
      bookOpen: false,
      bookWidth: 410,
      sidebarWidth: 300,
      bookTab: "board",
      sessionOrdinals: { next: 2, byId: { a: 1 } },
    };
    const after = migrateUiState(before, 21) as Record<string, unknown>;

    expect(after["leftOpen"]).toBe(false);
    expect(after["vexOpenChat"]).toBe(false);
    expect(after["vexOpenPages"]).toBe(false);
    expect(after["showAvatar"]).toBe(true);
    // EXPAND-ONLY: the keys the frame stops reading are still there, unchanged.
    expect(after["sidebarOpen"]).toBe(false);
    expect(after["bookOpen"]).toBe(false);
    expect(after["bookWidth"]).toBe(410);
    expect(after["sidebarWidth"]).toBe(300);
    expect(after["bookTab"]).toBe("board");
    expect(after["sessionOrdinals"]).toEqual({ next: 2, byId: { a: 1 } });
  });

  it("seeds the open defaults when the old slots are missing or off-shape", () => {
    const after = migrateUiState({ sidebarOpen: "yes" }, 21) as Record<string, unknown>;
    expect(after["leftOpen"]).toBe(true);
    expect(after["vexOpenChat"]).toBe(true);
  });

  it("never overwrites a slot a payload already carries", () => {
    const stored = { leftOpen: false, vexOpenChat: false, vexOpenPages: true, showAvatar: false };
    const after = migrateUiState({ ...stored, sidebarOpen: true, bookOpen: true }, 21) as Record<
      string,
      unknown
    >;
    expect(after).toMatchObject(stored);
  });

  it("coerces a hostile slot on every rehydrate to the constructed default", () => {
    const merged = mergeUiState(
      { leftOpen: "no", vexOpenChat: 0, vexOpenPages: "true", showAvatar: null },
      useUiStore.getState(),
    );
    expect(merged.leftOpen).toBe(true);
    expect(merged.vexOpenChat).toBe(true);
    expect(merged.vexOpenPages).toBe(false);
    expect(merged.showAvatar).toBe(true);
  });

  it("restores well-formed slots", () => {
    const merged = mergeUiState(
      { leftOpen: false, vexOpenChat: false, vexOpenPages: true, showAvatar: false },
      useUiStore.getState(),
    );
    expect(merged).toMatchObject({
      leftOpen: false,
      vexOpenChat: false,
      vexOpenPages: true,
      showAvatar: false,
    });
  });
});

describe("where Vex opens", () => {
  it("reads the chat slot in chat and the pages slot on the table pages", () => {
    const state = useUiStore.getState();
    expect(selectVexOpen(state)).toBe(true);
    for (const kind of ["portfolio", "board"] as const) {
      expect(selectVexOpen({ ...state, shellRoute: { kind, origin: null } })).toBe(false);
    }
    expect(
      selectVexOpen({ ...state, shellRoute: { kind: "settings", origin: null, section: null } }),
    ).toBe(false);
    // The desk chat is hidden until the desk opens it.
    expect(selectVexOpen({ ...state, runtimeMode: "lighter" })).toBe(false);
    // Needs you and the reading pages keep the chat's choice.
    expect(selectVexOpen({ ...state, shellRoute: { kind: "needsYou", origin: null } })).toBe(true);
    expect(selectVexOpen({ ...state, shellRoute: { kind: "memory", origin: null } })).toBe(true);
  });

  it("hiding Vex on a table page leaves her open in chat", () => {
    useUiStore.setState({ vexOpenPages: true, shellRoute: { kind: "portfolio", origin: null } });
    useUiStore.getState().setVexOpen(false);
    expect(useUiStore.getState().vexOpenPages).toBe(false);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });

  it("showing Vex clears the narrow override, so the left folds to its rail", () => {
    useUiStore.setState({ vexOpenChat: false, sidebarNarrowExpanded: true });
    useUiStore.getState().setVexOpen(true);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
  });

  it("keeps the legacy writers working through the page class", () => {
    useUiStore.getState().setBookOpen(false);
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    expect(useUiStore.getState().bookOpen).toBe(false);
    useUiStore.getState().toggleBook();
    expect(useUiStore.getState().vexOpenChat).toBe(true);
    expect(useUiStore.getState().bookOpen).toBe(true);
    useUiStore.setState({ runtimeMode: "lighter" });
    useUiStore.getState().setBookOpen(true);
    expect(useUiStore.getState().vexOpenLighter).toBe(true);
    expect(useUiStore.getState().vexOpenPages).toBe(false);
  });

  it("gives the Lighter desk chat its own slot, so a desk visit never opens Vex on the table pages", () => {
    // What entering the desk from a conversation does (`enterLighterMode`
    // with `openChat`): the mode, then the chat.
    useUiStore.getState().setRuntimeMode("lighter");
    useUiStore.getState().setBookOpen(true);
    expect(selectVexOpen(useUiStore.getState())).toBe(true);
    expect(useUiStore.getState().vexOpenLighter).toBe(true);
    // Back on a table page, Vex keeps its hidden default.
    useUiStore.getState().setRuntimeMode("agent");
    useUiStore.setState({ shellRoute: { kind: "portfolio", origin: null } });
    expect(selectVexOpen(useUiStore.getState())).toBe(false);
    expect(useUiStore.getState().vexOpenPages).toBe(false);
    // Hiding the desk chat leaves the chat's choice alone.
    useUiStore.getState().setRuntimeMode("lighter");
    useUiStore.getState().setVexOpen(false);
    expect(useUiStore.getState().vexOpenLighter).toBe(false);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });

  it("never persists the desk chat's slot: the desk is entered, never resumed into", () => {
    expect(PERSISTED_UI_KEYS).not.toContain("vexOpenLighter");
  });

  it("keeps the legacy left writer and the new one in step", () => {
    useUiStore.getState().setSidebarOpen(false);
    expect(useUiStore.getState().leftOpen).toBe(false);
    useUiStore.getState().setLeftOpen(true);
    expect(useUiStore.getState().sidebarOpen).toBe(true);
  });
});
