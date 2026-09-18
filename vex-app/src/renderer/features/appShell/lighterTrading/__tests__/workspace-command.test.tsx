import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../../../stores/uiStore.js";
import { enterLighterMode, isLighterWorkspaceCommand } from "../workspace-command.js";

describe("Light it up conversational activation", () => {
  beforeEach(() => {
    useUiStore.getState().setRuntimeMode("agent");
  });

  it("matches only the exact phrase, allowing case and terminal punctuation", () => {
    expect(isLighterWorkspaceCommand("Light it up")).toBe(true);
    expect(isLighterWorkspaceCommand("  LIGHT IT UP!  ")).toBe(true);
    expect(isLighterWorkspaceCommand("Can you light it up?")).toBe(false);
    expect(isLighterWorkspaceCommand("Light it up now")).toBe(false);
  });

  it("enters the Lighter shell mode and remembers where to return", () => {
    useUiStore.setState({ bookOpen: false, sidebarNarrowExpanded: true });
    enterLighterMode();
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(useUiStore.getState().lighterReturn?.mode).toBe("agent");
    expect(useUiStore.getState().bookOpen).toBe(true);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
  });
});
