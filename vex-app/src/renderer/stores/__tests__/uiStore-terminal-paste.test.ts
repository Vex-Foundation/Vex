import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore.js";
import { mergeUiState, partializeUiState, PERSISTED_UI_KEYS } from "../uiStore/persistence.js";

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ terminalPasteWarning: true });
});

describe("terminal paste warning preference", () => {
  it("persists the opt-out and restores it without retaining an action", async () => {
    useUiStore.getState().setTerminalPasteWarning(false);
    expect(PERSISTED_UI_KEYS).toContain("terminalPasteWarning");
    expect(partializeUiState(useUiStore.getState())["terminalPasteWarning"]).toBe(false);
    expect(partializeUiState(useUiStore.getState())).not.toHaveProperty("setTerminalPasteWarning");
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().terminalPasteWarning).toBe(false);
  });
  it.each([null, "false", 0, {}, [], undefined])("defaults invalid persisted %j to warning enabled", (value) => {
    const merged = mergeUiState({ terminalPasteWarning: value, setTerminalPasteWarning: "invalid" }, useUiStore.getState());
    expect(merged.terminalPasteWarning).toBe(true);
    expect(merged.setTerminalPasteWarning).toBe(useUiStore.getState().setTerminalPasteWarning);
  });
});
