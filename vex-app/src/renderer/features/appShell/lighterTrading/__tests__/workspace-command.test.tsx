import { beforeEach, describe, expect, it } from "vitest";
import { selectVexOpen, useUiStore } from "../../../../stores/uiStore.js";
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

  it("enters the Lighter shell mode and remembers where to return, the desk chat hidden by default", () => {
    useUiStore.setState({ bookOpen: false, sidebarNarrowExpanded: true, vexOpenLighter: false });
    enterLighterMode();
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(useUiStore.getState().lighterReturn?.mode).toBe("agent");
    // Nav entry: the desk opens with its chat column closed.
    expect(useUiStore.getState().vexOpenLighter).toBe(false);
    expect(selectVexOpen(useUiStore.getState())).toBe(false);
    expect(useUiStore.getState().sidebarNarrowExpanded).toBe(false);
  });

  it("an entry typed in a conversation opens the desk with its chat showing", () => {
    useUiStore.setState({ bookOpen: false, vexOpenLighter: false });
    enterLighterMode({ openChat: true });
    expect(useUiStore.getState().runtimeMode).toBe("lighter");
    expect(useUiStore.getState().vexOpenLighter).toBe(true);
    expect(useUiStore.getState().bookOpen).toBe(true);
  });
});
