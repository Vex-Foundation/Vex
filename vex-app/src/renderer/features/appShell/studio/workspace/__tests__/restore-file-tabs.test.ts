/**
 * FILE TABS ACROSS A RESTART: the model half.
 *
 * The controller re-resolves every persisted path through main and hands the
 * survivors here; these are the rules that place them. VS Code's
 * `EditorGroupModel.deserialize` (`editorGroupModel.ts:1218-1260`) is the
 * shape: what cannot be restored is coalesced away, the indices around the hole
 * are adjusted, and the group survives.
 *
 * RED ON REVERT:
 *  - place restored tabs at the end instead of at `position` and "puts a file
 *    back BETWEEN the terminals it was between" fails;
 *  - let the persisted `active` flag win over a restored terminal and "leaves
 *    the selection with the terminal that claimed it" fails;
 *  - stop honouring `active` when nothing claimed it and "selects the tab the
 *    user left selected when no terminal came back" fails;
 *  - record a preview tab as a preview and "records a PREVIEW tab as kept"
 *    fails;
 *  - record the index among file tabs instead of the whole strip and "records
 *    the index in the WHOLE strip" fails;
 *  - drop the second-preview guard and "keeps at most one preview" fails;
 *  - drop the bound and "stops at STUDIO_FILE_TABS_MAX" fails.
 */

import { describe, expect, it } from "vitest";
import {
  emptyWorkspace,
  isPreviewFileTab,
  restoreFileTabs,
  toPersistedFileTabs,
  type RestoredFileTab,
} from "../workspace-model.js";
import {
  STUDIO_FILE_TABS_MAX,
  type WorkspaceFileTab,
  type WorkspaceState,
  type WorkspaceTab,
} from "../types.js";

function group(tabId: string): WorkspaceTab {
  return {
    kind: "terminalGroup",
    tabId,
    title: tabId,
    orientation: "horizontal",
    panes: [
      { paneId: `${tabId}:0`, terminalId: `term-${tabId}`, relativeSize: 1, displayCwd: null },
    ],
    activePaneId: `${tabId}:0`,
  };
}

function fileTab(relativePath: string, preview = false): WorkspaceFileTab {
  return {
    kind: "file",
    tabId: `tab-${relativePath}`,
    title: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    nodeId: `token:${relativePath}`,
    dirty: false,
    preview,
  };
}

function restored(
  relativePath: string,
  position: number,
  extra: Partial<RestoredFileTab> = {},
): RestoredFileTab {
  return {
    tabId: `restored-${relativePath}`,
    title: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    nodeId: `fresh:${relativePath}`,
    pinned: true,
    position,
    active: false,
    ...extra,
  };
}

/** A workspace as `fromSnapshot` leaves it: two terminals, the first selected. */
function twoTerminals(): WorkspaceState {
  return {
    projectId: "p1",
    tabs: [group("g1"), group("g2")],
    activeTabId: "g1",
  };
}

describe("restoreFileTabs", () => {
  it("puts a file back BETWEEN the terminals it was between", () => {
    const state = restoreFileTabs(twoTerminals(), [restored("src/a.ts", 1)]);

    expect(state.tabs.map((tab) => tab.tabId)).toEqual([
      "g1",
      "restored-src/a.ts",
      "g2",
    ]);
  });

  it("applies several in ascending position, so the strip keeps its order", () => {
    const state = restoreFileTabs(twoTerminals(), [
      restored("src/last.ts", 3),
      restored("src/first.ts", 0),
    ]);

    expect(state.tabs.map((tab) => tab.tabId)).toEqual([
      "restored-src/first.ts",
      "g1",
      "g2",
      "restored-src/last.ts",
    ]);
  });

  it("clamps a position past the end of a strip that came back smaller", () => {
    // The saved strip held four tabs; only one terminal revived.
    const state = restoreFileTabs(
      { projectId: "p1", tabs: [group("g1")], activeTabId: "g1" },
      [restored("src/a.ts", 9)],
    );

    expect(state.tabs.map((tab) => tab.tabId)).toEqual(["g1", "restored-src/a.ts"]);
  });

  it("leaves the selection with the terminal that claimed it", () => {
    const state = restoreFileTabs(twoTerminals(), [
      restored("src/a.ts", 0, { active: true }),
    ]);

    // A restored terminal is what the user came back for. The persisted flag
    // decides only the case nothing else answered.
    expect(state.activeTabId).toBe("g1");
  });

  it("selects the tab the user left selected when no terminal came back", () => {
    const state = restoreFileTabs(emptyWorkspace("p1"), [
      restored("src/a.ts", 0),
      restored("src/b.ts", 1, { active: true }),
    ]);

    expect(state.activeTabId).toBe("restored-src/b.ts");
  });

  it("repairs the selection when nothing claimed it at all", () => {
    const state = restoreFileTabs(emptyWorkspace("p1"), [restored("src/a.ts", 0)]);

    expect(state.activeTabId).toBe("restored-src/a.ts");
  });

  it("skips a path the strip already holds", () => {
    const open: WorkspaceState = {
      projectId: "p1",
      tabs: [fileTab("src/a.ts")],
      activeTabId: "tab-src/a.ts",
    };

    const state = restoreFileTabs(open, [restored("src/a.ts", 0)]);

    expect(state.tabs).toHaveLength(1);
    // The tab that was already there kept its own token, not the restore's.
    expect((state.tabs[0] as WorkspaceFileTab).nodeId).toBe("token:src/a.ts");
  });

  it("keeps at most one preview, whatever the record claims", () => {
    const state = restoreFileTabs(emptyWorkspace("p1"), [
      restored("src/a.ts", 0, { pinned: false }),
      restored("src/b.ts", 1, { pinned: false }),
    ]);

    expect(state.tabs.filter((tab) => isPreviewFileTab(tab))).toHaveLength(1);
    // The FIRST one keeps the slot; the second is pinned.
    expect(isPreviewFileTab(state.tabs[0] as WorkspaceTab)).toBe(true);
    expect(isPreviewFileTab(state.tabs[1] as WorkspaceTab)).toBe(false);
  });

  it("stops at STUDIO_FILE_TABS_MAX", () => {
    const many = Array.from({ length: STUDIO_FILE_TABS_MAX + 4 }, (_value, index) =>
      restored(`src/f${String(index)}.ts`, index),
    );

    const state = restoreFileTabs(emptyWorkspace("p1"), many);

    expect(state.tabs).toHaveLength(STUDIO_FILE_TABS_MAX);
  });

  it("returns the state untouched when nothing resolved", () => {
    const before = twoTerminals();
    expect(restoreFileTabs(before, []).tabs).toEqual(before.tabs);
  });
});

describe("toPersistedFileTabs", () => {
  it("records the index in the WHOLE strip, terminals included", () => {
    const state: WorkspaceState = {
      projectId: "p1",
      tabs: [group("g1"), fileTab("src/a.ts"), group("g2"), fileTab("src/b.ts")],
      activeTabId: "g1",
    };

    expect(toPersistedFileTabs(state)).toEqual([
      { relativePath: "src/a.ts", pinned: true, position: 1, active: false },
      { relativePath: "src/b.ts", pinned: true, position: 3, active: false },
    ]);
  });

  it("records a PREVIEW tab as kept: a tab that survives a restart was kept", () => {
    const state: WorkspaceState = {
      projectId: "p1",
      tabs: [fileTab("src/browsed.ts", true)],
      activeTabId: "tab-src/browsed.ts",
    };

    expect(toPersistedFileTabs(state)).toEqual([
      { relativePath: "src/browsed.ts", pinned: true, position: 0, active: true },
    ]);
  });

  it("records which tab was selected, and only that one", () => {
    const state: WorkspaceState = {
      projectId: "p1",
      tabs: [fileTab("src/a.ts"), fileTab("src/b.ts")],
      activeTabId: "tab-src/b.ts",
    };

    expect(toPersistedFileTabs(state).map((tab) => tab.active)).toEqual([false, true]);
  });

  it("records nothing for a strip that holds only terminals", () => {
    expect(toPersistedFileTabs(twoTerminals())).toEqual([]);
  });

  /**
   * THE ROUND TRIP, which is what the whole home is for: a strip written out
   * and read back is the same strip - same files, same order, same selection.
   */
  it("round-trips a strip through the record and back", () => {
    const before: WorkspaceState = {
      projectId: "p1",
      tabs: [group("g1"), fileTab("src/a.ts"), group("g2"), fileTab("src/b.ts")],
      activeTabId: "tab-src/b.ts",
    };

    const record = toPersistedFileTabs(before);
    const after = restoreFileTabs(twoTerminals(), record.map((entry) =>
      restored(entry.relativePath, entry.position, {
        pinned: entry.pinned,
        active: entry.active,
      }),
    ));

    expect(after.tabs.map((tab) =>
      tab.kind === "file" ? tab.relativePath : tab.tabId,
    )).toEqual(["g1", "src/a.ts", "g2", "src/b.ts"]);
  });
});
