/**
 * The welcome token's own key, `welcomeVexShown` (the coordinator,
 * 2026-10-17): hiding Vex on the welcome is a "make room on this screen"
 * choice, persisted on its own, and it no longer doubles as the global
 * avatar switch (`showAvatar`, Settings "Show avatar" and the Vex sidebar).
 * The two keys never write each other. Added without a version hop: a
 * payload that does not carry it hydrates to the default, Vex shown.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mergeUiState, partializeUiState, PERSISTED_UI_KEYS } from "../uiStore/persistence.js";
import { useUiStore } from "../uiStore.js";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ showAvatar: true, welcomeVexShown: true });
});

describe("uiStore - the welcome's own Vex key", () => {
  it("defaults to Vex shown and persists on the whitelist", () => {
    expect(PERSISTED_UI_KEYS).toContain("welcomeVexShown");
    expect(partializeUiState(useUiStore.getState())["welcomeVexShown"]).toBe(true);
    useUiStore.getState().setWelcomeVexShown(false);
    expect(partializeUiState(useUiStore.getState())["welcomeVexShown"]).toBe(false);
  });

  it("the welcome key and the avatar switch never write each other", () => {
    useUiStore.getState().setWelcomeVexShown(false);
    expect(useUiStore.getState().showAvatar).toBe(true);
    useUiStore.getState().setShowAvatar(false);
    expect(useUiStore.getState().welcomeVexShown).toBe(false);
    useUiStore.getState().setWelcomeVexShown(true);
    expect(useUiStore.getState().showAvatar).toBe(false);
  });

  it("a payload without the key hydrates to Vex shown; a hostile value degrades to the default", () => {
    expect(mergeUiState({ showAvatar: false }, useUiStore.getState()).welcomeVexShown).toBe(true);
    expect(mergeUiState({ welcomeVexShown: "no" }, useUiStore.getState()).welcomeVexShown).toBe(
      true,
    );
    const restored = mergeUiState(
      { welcomeVexShown: false, showAvatar: true },
      useUiStore.getState(),
    );
    expect(restored.welcomeVexShown).toBe(false);
    expect(restored.showAvatar).toBe(true);
  });
});
