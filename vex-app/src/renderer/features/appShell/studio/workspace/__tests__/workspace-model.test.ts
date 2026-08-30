/**
 * THE WORKSPACE MODEL, tested as the pure state machine it is.
 *
 * These are the rules round 2's components will depend on and would otherwise
 * have to be re-derived by reading JSX: what becomes active after a close, how
 * a stale selection is repaired, that the keep-alive bound REFUSES instead of
 * evicting, and that a snapshot whose two halves disagree does not restore a
 * pane with nothing in it.
 */

import { describe, expect, it } from "vitest";
import {
  TERMINAL_SNAPSHOT_VERSION,
  type TerminalWorkspaceSnapshot,
} from "@shared/schemas/terminal.js";
import {
  addFileTab,
  addPane,
  addTerminalGroup,
  closePane,
  closeTab,
  collectCleanups,
  emptyWorkspace,
  fromSnapshot,
  repairSelection,
  selectTab,
  terminalGroupCount,
  toPersistedLayout,
} from "../workspace-model.js";
import {
  WORKSPACE_KEEP_ALIVE_MAX,
  type WorkspaceState,
  type WorkspaceTerminalGroup,
} from "../types.js";

function group(id: string, terminalIds: string[] = [`${id}-t`]): WorkspaceTerminalGroup {
  return {
    kind: "terminalGroup",
    tabId: id,
    title: id,
    orientation: "horizontal",
    panes: terminalIds.map((terminalId, index) => ({
      paneId: `${id}:${String(index)}`,
      terminalId,
      relativeSize: 1 / terminalIds.length,
    })),
    activePaneId: `${id}:0`,
  };
}

function withGroups(ids: string[]): WorkspaceState {
  let state = emptyWorkspace("p1");
  for (const id of ids) {
    const mutation = addTerminalGroup(state, group(id));
    if (!mutation.ok) throw new Error(`unexpected refusal: ${mutation.reason}`);
    state = mutation.state;
  }
  return state;
}

describe("creation and selection", () => {
  it("selects the tab it just created", () => {
    const state = withGroups(["a", "b"]);
    expect(state.activeTabId).toBe("b");
  });

  it("REFUSES past the keep-alive bound instead of evicting a running terminal", () => {
    const ids = Array.from({ length: WORKSPACE_KEEP_ALIVE_MAX }, (_, index) =>
      `g${String(index)}`,
    );
    const full = withGroups(ids);

    const refused = addTerminalGroup(full, group("one-too-many"));

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.reason).toBe("keep_alive_limit");
    // Nothing was closed to make room. A UI that evicted here would kill a
    // process the user started and cannot recover.
    expect(terminalGroupCount(refused.state)).toBe(WORKSPACE_KEEP_ALIVE_MAX);
    expect(refused.state.tabs.map((tab) => tab.tabId)).toEqual(ids);
  });

  it("SELECTS an already-open file rather than opening it twice", () => {
    let state = emptyWorkspace("p1");
    state = mutate(addFileTab(state, fileTab("f1", "src/a.ts")));
    state = mutate(addTerminalGroup(state, group("g1")));

    const again = addFileTab(state, fileTab("f2", "src/a.ts"));

    expect(again.ok).toBe(true);
    // Two tabs on one path would give the same buffer two dirty flags.
    expect(again.state.tabs.filter((tab) => tab.kind === "file")).toHaveLength(1);
    expect(again.state.activeTabId).toBe("f1");
  });

  it("refuses selecting a tab that does not exist, and changes nothing", () => {
    const state = withGroups(["a"]);
    const outcome = selectTab(state, "ghost");
    expect(outcome).toEqual({ ok: false, reason: "unknown_tab", state });
  });
});

describe("closing", () => {
  it("moves selection to the LEFT neighbour", () => {
    const state = withGroups(["a", "b", "c"]);
    const selected = mutate(selectTab(state, "b"));

    const closed = mutate(closeTab(selected, "b"));

    // Selecting the right neighbour would march the selection toward the end
    // of the strip as a user closes a run of tabs.
    expect(closed.activeTabId).toBe("a");
    expect(closed.tabs.map((tab) => tab.tabId)).toEqual(["a", "c"]);
  });

  it("falls back to the RIGHT neighbour when there is nothing to the left", () => {
    const state = mutate(selectTab(withGroups(["a", "b"]), "a"));
    expect(mutate(closeTab(state, "a")).activeTabId).toBe("b");
  });

  it("selects nothing once the last tab is gone", () => {
    const closed = mutate(closeTab(withGroups(["a"]), "a"));
    expect(closed.tabs).toEqual([]);
    expect(closed.activeTabId).toBeNull();
  });

  it("leaves the selection alone when a DIFFERENT tab is closed", () => {
    const state = mutate(selectTab(withGroups(["a", "b", "c"]), "c"));
    expect(mutate(closeTab(state, "a")).activeTabId).toBe("c");
  });

  it("refuses to close an unknown tab", () => {
    const state = withGroups(["a"]);
    expect(closeTab(state, "ghost")).toEqual({
      ok: false,
      reason: "unknown_tab",
      state,
    });
  });
});

describe("panes", () => {
  it("normalizes sizes on a split so they always sum to 1", () => {
    const state = withGroups(["a"]);
    const split = mutate(
      addPane(state, "a", { paneId: "a:1", terminalId: "a-t2", relativeSize: 0.5 }),
    );
    const panes = (split.tabs[0] as WorkspaceTerminalGroup).panes;
    expect(panes.map((pane) => pane.relativeSize)).toEqual([0.5, 0.5]);
    expect((split.tabs[0] as WorkspaceTerminalGroup).activePaneId).toBe("a:1");
  });

  it("REFUSES to remove the last pane, because that is a different gesture", () => {
    const state = withGroups(["a"]);
    const refused = closePane(state, "a", "a:0");
    // Closing a tab kills the pty; closing a pane detaches. Collapsing the two
    // here would make one gesture perform the other's effect.
    expect(refused).toEqual({ ok: false, reason: "last_pane", state });
  });

  it("moves the active pane left when the active one is removed", () => {
    let state = withGroups(["a"]);
    state = mutate(
      addPane(state, "a", { paneId: "a:1", terminalId: "a-t2", relativeSize: 0.5 }),
    );
    const closed = mutate(closePane(state, "a", "a:1"));
    expect((closed.tabs[0] as WorkspaceTerminalGroup).activePaneId).toBe("a:0");
  });

  it("refuses an unknown pane", () => {
    const state = withGroups(["a"]);
    expect(closePane(state, "a", "ghost").ok).toBe(false);
  });
});

describe("stale selection repair", () => {
  it("repairs a selection naming a tab that does not exist", () => {
    const broken: WorkspaceState = {
      projectId: "p1",
      tabs: [group("a")],
      activeTabId: "gone",
    };
    // The model never returns a state the UI cannot render.
    expect(repairSelection(broken).activeTabId).toBe("a");
  });

  it("clears the selection when there are no tabs", () => {
    const broken: WorkspaceState = { projectId: "p1", tabs: [], activeTabId: "gone" };
    expect(repairSelection(broken).activeTabId).toBeNull();
  });
});

describe("cleanup plans", () => {
  it("KILLS on close and DETACHES on unmount", () => {
    const tabs = [group("a", ["t1", "t2"]), fileTab("f1", "src/a.ts")];

    expect(collectCleanups(tabs, "closing")).toEqual({
      detachTerminalIds: [],
      killTerminalIds: ["t1", "t2"],
    });
    // A project switch must not kill a running build.
    expect(collectCleanups(tabs, "unmounting")).toEqual({
      detachTerminalIds: ["t1", "t2"],
      killTerminalIds: [],
    });
  });
});

describe("persistence mapping", () => {
  it("projects only TERMINAL groups onto the persisted layout", () => {
    let state = withGroups(["a"]);
    state = mutate(addFileTab(state, fileTab("f1", "src/a.ts")));

    const layout = toPersistedLayout(state);

    // A file tab's durable home is the editor's own state; smuggling it into a
    // terminal snapshot would give both one corruption blast radius.
    expect(layout.groups.map((item) => item.groupId)).toEqual(["a"]);
    expect(layout.projectId).toBe("p1");
  });

  it("round-trips a workspace through the snapshot shape", () => {
    const state = withGroups(["a", "b"]);
    const layout = toPersistedLayout(state);
    const restored = fromSnapshot(snapshotWith(layout, ["a-t", "b-t"]));

    expect(restored.tabs.map((tab) => tab.tabId)).toEqual(["a", "b"]);
    expect(restored.activeTabId).toBe("b");
    expect((restored.tabs[0] as WorkspaceTerminalGroup).panes[0]?.terminalId).toBe(
      "a-t",
    );
  });

  it("DROPS a pane whose terminal the snapshot never saved", () => {
    const layout = toPersistedLayout(withGroups(["a", "b"]));
    // The layout names two terminals; only one was serialized.
    const restored = fromSnapshot(snapshotWith(layout, ["a-t"]));

    // Rendering an empty pane for the missing one would look like data loss
    // with no explanation.
    expect(restored.tabs.map((tab) => tab.tabId)).toEqual(["a"]);
    expect(restored.activeTabId).toBe("a");
  });

  it("titles a restored tab from what was running in it", () => {
    const layout = toPersistedLayout(withGroups(["a"]));
    const snapshot = snapshotWith(layout, ["a-t"]);
    const entry = snapshot.terminals[0];
    if (entry === undefined) throw new Error("fixture must have one terminal");
    const restored = fromSnapshot({
      ...snapshot,
      terminals: [{ ...entry, title: "npm run dev" }],
    });
    expect(restored.tabs[0]?.title).toBe("npm run dev");
  });
});

/* ------------------------------------------------------------------ */

function mutate(mutation: ReturnType<typeof addTerminalGroup>): WorkspaceState {
  if (!mutation.ok) throw new Error(`unexpected refusal: ${mutation.reason}`);
  return mutation.state;
}

function fileTab(tabId: string, relativePath: string) {
  return {
    kind: "file" as const,
    tabId,
    title: relativePath,
    relativePath,
    dirty: false,
  };
}

function snapshotWith(
  layout: ReturnType<typeof toPersistedLayout>,
  terminalIds: string[],
): TerminalWorkspaceSnapshot {
  return {
    version: TERMINAL_SNAPSHOT_VERSION,
    projectId: layout.projectId,
    savedAt: 0,
    layout,
    terminals: terminalIds.map((terminalId) => ({
      terminalId,
      title: "bash",
      shellName: "bash",
      cwdAtSpawn: "/projects/p1",
      cols: 80,
      rows: 24,
      serialized: "",
      droppedRows: 0,
    })),
  };
}
