/**
 * Kimm's open or closed choice replaces "Show avatar" (docs/design/H3-DESKTOP.md
 * section 3.5; plan row S4-14; `uiStore/persistence.ts`, v24). What is pinned:
 *
 *  - the store is at v24, and her choice is the one persisted `vexOpenChat`,
 *    open by default (first launch opens her);
 *  - the hop folds a stored `showAvatar: false` into her choice (closed),
 *    keeps a closed choice closed, and pins `showAvatar` true;
 *  - a missing or off-shape slot counts as its default, so the hop never
 *    closes her on a guess;
 *  - a payload already at v24 is not folded again;
 *  - nothing in the store writes the retired slot any more: the setter is
 *    gone, and showing or hiding her writes her choice alone.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { migrateUiState, partializeUiState, PERSISTED_UI_KEYS } from "../uiStore/persistence.js";
import { useUiStore } from "../uiStore.js";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    runtimeMode: "agent",
    shellRoute: { kind: "none" },
    vexOpenChat: true,
    showAvatar: true,
  });
});

function v23(payload: Record<string, unknown>): Record<string, unknown> {
  return migrateUiState(payload, 23) as Record<string, unknown>;
}

describe("uiStore v24: her choice replaces Show avatar", () => {
  it("is at v24, persists her choice, and opens her on a fresh install", () => {
    expect(useUiStore.persist.getOptions().version).toBe(24);
    expect(PERSISTED_UI_KEYS).toContain("vexOpenChat");
    expect(useUiStore.getInitialState().vexOpenChat).toBe(true);
    expect(partializeUiState(useUiStore.getState())["vexOpenChat"]).toBe(true);
  });

  it("folds a hidden avatar into her choice: closed, and the retired slot pinned true", () => {
    expect(v23({ vexOpenChat: true, showAvatar: false })).toMatchObject({
      vexOpenChat: false,
      showAvatar: true,
    });
  });

  it("keeps a closed choice closed and an open one open when the avatar was shown", () => {
    expect(v23({ vexOpenChat: false, showAvatar: true })).toMatchObject({
      vexOpenChat: false,
      showAvatar: true,
    });
    expect(v23({ vexOpenChat: true, showAvatar: true })).toMatchObject({
      vexOpenChat: true,
      showAvatar: true,
    });
  });

  it("never closes her on a guess: missing or off-shape slots count as their defaults", () => {
    expect(v23({})).toMatchObject({ vexOpenChat: true, showAvatar: true });
    expect(v23({ vexOpenChat: "yes", showAvatar: null })).toMatchObject({
      vexOpenChat: true,
      showAvatar: true,
    });
  });

  it("leaves every other slot as it was", () => {
    const after = v23({ vexOpenChat: true, showAvatar: false, vexOpenPages: true, leftOpen: false });
    expect(after["vexOpenPages"]).toBe(true);
    expect(after["leftOpen"]).toBe(false);
  });

  it("does not fold a payload already at v24 again", () => {
    const stored = { vexOpenChat: true, showAvatar: false };
    expect(migrateUiState(stored, 24)).toEqual(stored);
  });

  it("has no writer for the retired slot: showing and hiding her writes her choice alone", () => {
    expect("setShowAvatar" in useUiStore.getState()).toBe(false);
    useUiStore.getState().setVexOpen(false);
    expect(useUiStore.getState().vexOpenChat).toBe(false);
    expect(useUiStore.getState().showAvatar).toBe(true);
    useUiStore.getState().setVexOpen(true);
    expect(useUiStore.getState().vexOpenChat).toBe(true);
  });
});
