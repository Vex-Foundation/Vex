/**
 * PREVIEW TABS: one throwaway slot per workspace, and how a tab leaves it.
 *
 * The characterization is VS Code's own, read out of the checkout before this
 * was written (`workbench/test/browser/parts/editor/editorGroupModel.test.ts`,
 * "Multiple Editors - real user example"): a preview open REPLACES the current
 * preview, replacement keeps the tab's POSITION, pinning promotes without
 * moving anything, and a strip that has never seen a preview open behaves
 * exactly as it did before the concept existed.
 *
 * RED ON REVERT. Delete the replacement branch in `addFileTab` and "replaces
 * the preview tab IN ITS POSITION" fails with two tabs; delete the mode default
 * and "opens PINNED when no mode is asked for" fails.
 */

import { describe, expect, it } from "vitest";
import {
  addFileTab,
  addTerminalGroup,
  closeTab,
  emptyWorkspace,
  fileTabCount,
  fromSnapshot,
  isPreviewFileTab,
  pinTab,
  previewFileTab,
  toPersistedLayout,
} from "../workspace-model.js";
import {
  STUDIO_FILE_TABS_MAX,
  type WorkspaceFileTab,
  type WorkspaceState,
  type WorkspaceTerminalGroup,
} from "../types.js";
import type { TerminalWorkspaceRestore } from "@shared/schemas/terminal.js";

function fileTab(tabId: string, relativePath: string): WorkspaceFileTab {
  return {
    kind: "file",
    tabId,
    title: relativePath,
    relativePath,
    nodeId: `node-${relativePath}`,
    dirty: false,
  };
}

function group(id: string): WorkspaceTerminalGroup {
  return {
    kind: "terminalGroup",
    tabId: id,
    title: id,
    orientation: "horizontal",
    panes: [{ paneId: `${id}:0`, terminalId: `${id}-t`, relativeSize: 1, displayCwd: null }],
    activePaneId: `${id}:0`,
  };
}

function mutate(mutation: ReturnType<typeof addFileTab>): WorkspaceState {
  if (!mutation.ok) throw new Error(`unexpected refusal: ${mutation.reason}`);
  return mutation.state;
}

const PREVIEW = { mode: "preview" } as const;
const PINNED = { mode: "pinned" } as const;

describe("the open mode", () => {
  it("opens PINNED when no mode is asked for, as every caller before previews did", () => {
    let state = emptyWorkspace("p1");
    state = mutate(addFileTab(state, fileTab("f1", "a.ts")));
    state = mutate(addFileTab(state, fileTab("f2", "b.ts")));

    // Two files, two tabs: the default did not quietly turn browsing into
    // replacement for callers that never asked for it.
    expect(state.tabs.map((tab) => tab.tabId)).toEqual(["f1", "f2"]);
    expect(previewFileTab(state)).toBeNull();
    expect(state.tabs.every((tab) => !isPreviewFileTab(tab))).toBe(true);
  });

  it("IGNORES a preview flag written by the caller", () => {
    // The invariant is the model's. A caller that could set the flag could put
    // two previews in one workspace, and every rule below rests on there being
    // at most one.
    const state = mutate(
      addFileTab(emptyWorkspace("p1"), { ...fileTab("f1", "a.ts"), preview: true }, PINNED),
    );

    expect(previewFileTab(state)).toBeNull();
  });
});

describe("one preview per workspace", () => {
  it("replaces the preview tab IN ITS POSITION", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "kept.ts"), PINNED));
    state = mutate(addFileTab(state, fileTab("f2", "browsed-1.ts"), PREVIEW));
    state = mutate(addTerminalGroup(state, group("g1")));

    const after = mutate(addFileTab(state, fileTab("f3", "browsed-2.ts"), PREVIEW));

    // ONE preview tab, and it sits where the one it replaced sat. A tab that
    // moved to the end would walk under the pointer of a user clicking down a
    // file tree, which is the whole gesture this exists for.
    expect(after.tabs.map((tab) => tab.tabId)).toEqual(["f1", "f3", "g1"]);
    expect(previewFileTab(after)?.tabId).toBe("f3");
    expect(fileTabCount(after)).toBe(2);
    expect(after.activeTabId).toBe("f3");
  });

  it("appends the first preview instead of replacing a pinned tab", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "kept.ts"), PINNED));
    state = mutate(addFileTab(state, fileTab("f2", "browsed.ts"), PREVIEW));

    expect(state.tabs.map((tab) => tab.tabId)).toEqual(["f1", "f2"]);
    expect(isPreviewFileTab(state.tabs[0] ?? fileTab("x", "x"))).toBe(false);
  });

  it("leaves the preview alone when the next open is PINNED", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "browsed.ts"), PREVIEW));
    state = mutate(addFileTab(state, fileTab("f2", "kept.ts"), PINNED));

    // A pinned open is an addition, never a replacement: the user asked to keep
    // the new file, not to throw the old one away.
    expect(state.tabs.map((tab) => tab.tabId)).toEqual(["f1", "f2"]);
    expect(previewFileTab(state)?.tabId).toBe("f1");
  });

  it("browses without ever reaching the file-tab bound", () => {
    let state = emptyWorkspace("p1");
    for (let index = 0; index < STUDIO_FILE_TABS_MAX; index += 1) {
      state = mutate(addFileTab(state, fileTab(`f${String(index)}`, `k${String(index)}.ts`), PINNED));
    }
    expect(fileTabCount(state)).toBe(STUDIO_FILE_TABS_MAX);

    // At the bound a NEW tab is still refused...
    const refused = addFileTab(state, fileTab("over", "over.ts"), PREVIEW);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.reason).toBe("file_tab_limit");
  });

  it("replaces rather than refusing when the full strip already holds a preview", () => {
    let state = emptyWorkspace("p1");
    for (let index = 0; index < STUDIO_FILE_TABS_MAX - 1; index += 1) {
      state = mutate(addFileTab(state, fileTab(`f${String(index)}`, `k${String(index)}.ts`), PINNED));
    }
    state = mutate(addFileTab(state, fileTab("prev", "browsed.ts"), PREVIEW));
    expect(fileTabCount(state)).toBe(STUDIO_FILE_TABS_MAX);

    // Replacement adds no tab, so browsing keeps working at the bound.
    const after = mutate(addFileTab(state, fileTab("next", "browsed-2.ts"), PREVIEW));
    expect(fileTabCount(after)).toBe(STUDIO_FILE_TABS_MAX);
    expect(previewFileTab(after)?.tabId).toBe("next");
  });
});

describe("promotion", () => {
  it("pins the preview tab in place and clears the slot", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "kept.ts"), PINNED));
    state = mutate(addFileTab(state, fileTab("f2", "browsed.ts"), PREVIEW));

    const pinned = pinTab(state, "f2");

    expect(pinned.ok).toBe(true);
    expect(pinned.state.tabs.map((tab) => tab.tabId)).toEqual(["f1", "f2"]);
    expect(previewFileTab(pinned.state)).toBeNull();

    // And the next preview open now APPENDS, because nothing is throwaway.
    const after = mutate(addFileTab(pinned.state, fileTab("f3", "browsed-2.ts"), PREVIEW));
    expect(after.tabs.map((tab) => tab.tabId)).toEqual(["f1", "f2", "f3"]);
  });

  it("promotes an already-open preview when it is reopened PINNED", () => {
    // The double click that follows a single click on the same row: the file is
    // already the preview, and the second gesture is what keeps it.
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "a.ts"), PREVIEW));
    state = mutate(addFileTab(state, fileTab("f2", "a.ts"), PINNED));

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.tabId).toBe("f1");
    expect(previewFileTab(state)).toBeNull();
  });

  it("does not demote a pinned tab that is reopened as a preview", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "a.ts"), PINNED));
    const before = state.tabs;
    state = mutate(addFileTab(state, fileTab("f2", "a.ts"), PREVIEW));

    expect(state.tabs).toBe(before);
    expect(previewFileTab(state)).toBeNull();
    expect(state.activeTabId).toBe("f1");
  });

  it("is a no-op on a pinned tab and on a terminal group, and refuses a ghost", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "a.ts"), PINNED));
    state = mutate(addTerminalGroup(state, group("g1")));

    // Identity preserved, so a double click on either re-renders nothing.
    expect(pinTab(state, "f1").state).toBe(state);
    expect(pinTab(state, "g1").state).toBe(state);

    const ghost = pinTab(state, "nope");
    expect(ghost.ok).toBe(false);
    if (ghost.ok) throw new Error("unreachable");
    expect(ghost.reason).toBe("unknown_tab");
  });
});

describe("close and restore", () => {
  it("frees the slot when the preview tab is closed", () => {
    let state = mutate(addFileTab(emptyWorkspace("p1"), fileTab("f1", "kept.ts"), PINNED));
    state = mutate(addFileTab(state, fileTab("f2", "browsed.ts"), PREVIEW));

    const closed = closeTab(state, "f2");

    expect(closed.ok).toBe(true);
    expect(previewFileTab(closed.state)).toBeNull();
    // Selection follows the ordinary close rule: the neighbour to the LEFT.
    expect(closed.state.activeTabId).toBe("f1");
  });

  it("restores an older layout with nothing in the throwaway slot", () => {
    // THE MIGRATION, and it is the field's absence. A restore carries no file
    // tabs at all, and any file tab rebuilt without the flag reads as PINNED -
    // which is what a tab someone kept across a restart actually was.
    const restore: TerminalWorkspaceRestore = {
      layout: toPersistedLayout(mutate(addTerminalGroup(emptyWorkspace("p1"), group("g1")))),
      terminals: [
        {
          terminalId: "g1-t",
          title: "bash",
          shellName: "bash",
          displayCwd: null,
          droppedRows: 0,
          reducedRows: 0,
        },
      ],
      idMap: [{ from: "old-g1-t", to: "g1-t" }],
    };

    const state = fromSnapshot(restore);

    expect(previewFileTab(state)).toBeNull();
    expect(state.tabs.every((tab) => !isPreviewFileTab(tab))).toBe(true);

    // A file tab built the old way - no mode, no flag - is pinned, so the
    // first preview open after a restore appends rather than replacing it.
    const withOldTab = mutate(addFileTab(state, fileTab("f1", "a.ts")));
    const browsed = mutate(addFileTab(withOldTab, fileTab("f2", "b.ts"), PREVIEW));
    expect(browsed.tabs.map((tab) => tab.tabId)).toEqual(["g1", "f1", "f2"]);
  });
});
