/**
 * The welcome notice's dismissal, `vexInferenceNoticeDismissed`: a UI
 * preference ("Not now" on the "AI is now paid in VEX" card), persisted on
 * the whitelist and coerced on every rehydrate like every other key. Added
 * without a version hop: a payload that does not carry it hydrates to the
 * default, the notice shown. It never writes the welcome's Vex key or the
 * avatar switch.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mergeUiState, partializeUiState, PERSISTED_UI_KEYS } from "../uiStore/persistence.js";
import { useUiStore } from "../uiStore.js";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ vexInferenceNoticeDismissed: false, welcomeVexShown: true, showAvatar: true });
});

describe("uiStore - the welcome's Vex Inference notice", () => {
  it("defaults to shown and persists its dismissal on the whitelist", () => {
    expect(PERSISTED_UI_KEYS).toContain("vexInferenceNoticeDismissed");
    expect(partializeUiState(useUiStore.getState())["vexInferenceNoticeDismissed"]).toBe(false);
    useUiStore.getState().setVexInferenceNoticeDismissed(true);
    expect(partializeUiState(useUiStore.getState())["vexInferenceNoticeDismissed"]).toBe(true);
    expect(useUiStore.getState().welcomeVexShown).toBe(true);
    expect(useUiStore.getState().showAvatar).toBe(true);
  });

  it("a dismissal survives a relaunch", () => {
    const restored = mergeUiState({ vexInferenceNoticeDismissed: true }, useUiStore.getState());
    expect(restored.vexInferenceNoticeDismissed).toBe(true);
  });

  it("a payload without the key, or with a hostile value, shows the notice", () => {
    expect(mergeUiState({ showAvatar: false }, useUiStore.getState()).vexInferenceNoticeDismissed).toBe(false);
    expect(mergeUiState({ vexInferenceNoticeDismissed: "yes" }, useUiStore.getState()).vexInferenceNoticeDismissed).toBe(false);
    expect(mergeUiState({ vexInferenceNoticeDismissed: 1 }, useUiStore.getState()).vexInferenceNoticeDismissed).toBe(false);
  });
});
