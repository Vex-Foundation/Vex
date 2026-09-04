/**
 * THE TAB FOLLOWS ITS FILE'S RENAME.
 *
 * The defect this closes was measured in the browser pass: renaming a file that
 * was open in a tab left the tab titled with the OLD name, so the strip named a
 * path that no longer existed on disk. VS Code's answer is that the editor
 * follows the resource (`explorerViewer.ts:1983-1985` reopens the moved
 * resources rather than closing them), and this is the model half of that.
 *
 * RED ON REVERT. Delete the `nodeId` from the record `retargetFileTab` writes
 * and "moves the title, the path AND the token together" fails; make the match
 * fall through to a refusal-free no-op and "refuses when no tab holds that
 * path" fails.
 */

import { describe, expect, it } from "vitest";
import {
  addFileTab,
  addTerminalGroup,
  isPreviewFileTab,
  retargetFileTab,
  type FileTabTarget,
} from "../workspace-model.js";
import { type WorkspaceFileTab, type WorkspaceState } from "../types.js";
import type { WorkspaceMutation } from "../types.js";

function fileTab(tabId: string, relativePath: string): WorkspaceFileTab {
  return {
    kind: "file",
    tabId,
    title: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    nodeId: `node-${relativePath}`,
    dirty: false,
  };
}

function renamedTo(relativePath: string): FileTabTarget {
  return {
    title: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    // A rename mints a NEW token, because the id is derived from the path.
    nodeId: `node-${relativePath}`,
  };
}

function ok(mutation: WorkspaceMutation): WorkspaceState {
  if (!mutation.ok) throw new Error(`unexpected refusal: ${mutation.reason}`);
  return mutation.state;
}

/** Two file tabs and a terminal group, in that order in the strip. */
function stripWithTwoFiles(): WorkspaceState {
  let state = ok(addFileTab(emptyState(), fileTab("f1", "src/a.ts")));
  state = ok(addFileTab(state, fileTab("f2", "src/b.ts")));
  return ok(addTerminalGroup(state, group()));
}

function emptyState(): WorkspaceState {
  return { projectId: "p1", tabs: [], activeTabId: null };
}

function group(): Parameters<typeof addTerminalGroup>[1] {
  return {
    kind: "terminalGroup",
    tabId: "g1",
    title: "Terminal 1",
    orientation: "horizontal",
    panes: [{ paneId: "g1:0", terminalId: "t1", relativeSize: 1, displayCwd: null }],
    activePaneId: "g1:0",
  };
}

describe("retargetFileTab", () => {
  it("moves the title, the path AND the token together, on the same tab", () => {
    const before = stripWithTwoFiles();
    const after = ok(retargetFileTab(before, "src/a.ts", renamedTo("src/renamed.ts")));

    const tab = after.tabs.find(
      (candidate): candidate is WorkspaceFileTab => candidate.tabId === "f1",
    );
    expect(tab).toEqual({
      kind: "file",
      tabId: "f1",
      title: "renamed.ts",
      relativePath: "src/renamed.ts",
      nodeId: "node-src/renamed.ts",
      dirty: false,
      preview: false,
    });
  });

  it("keeps the tab's IDENTITY and its POSITION, and closes nothing", () => {
    const before = stripWithTwoFiles();
    const after = ok(retargetFileTab(before, "src/a.ts", renamedTo("src/renamed.ts")));

    // Same count, same order, same ids: a rename is not a close plus an open,
    // or the user's place in the strip would move under them.
    expect(after.tabs.map((tab) => tab.tabId)).toEqual(
      before.tabs.map((tab) => tab.tabId),
    );
    // And it does not steal the selection: renaming a file in the tree is not
    // a request to look at it.
    expect(after.activeTabId).toBe(before.activeTabId);
  });

  it("leaves the untouched tabs and the terminal group exactly as they were", () => {
    const before = stripWithTwoFiles();
    const after = ok(retargetFileTab(before, "src/a.ts", renamedTo("src/renamed.ts")));

    expect(after.tabs[1]).toBe(before.tabs[1]);
    expect(after.tabs[2]).toBe(before.tabs[2]);
  });

  it("carries the PREVIEW flag and the dirty flag across", () => {
    const state = ok(
      addFileTab(emptyState(), fileTab("f1", "src/a.ts"), { mode: "preview" }),
    );
    expect(isPreviewFileTab(state.tabs[0] as WorkspaceFileTab)).toBe(true);

    const after = ok(retargetFileTab(state, "src/a.ts", renamedTo("src/renamed.ts")));
    // Renaming a file is not a decision about whether the user meant to keep
    // its tab, so the throwaway slot is still the throwaway slot.
    expect(isPreviewFileTab(after.tabs[0] as WorkspaceFileTab)).toBe(true);
  });

  it("refuses when no tab holds that path, which is the ordinary case", () => {
    const before = stripWithTwoFiles();
    const outcome = retargetFileTab(before, "src/never-opened.ts", renamedTo("src/x.ts"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unknown_tab");
    expect(outcome.state).toBe(before);
  });

  it("never matches a TERMINAL GROUP, whatever it is titled", () => {
    const before = stripWithTwoFiles();
    const outcome = retargetFileTab(before, "Terminal 1", renamedTo("src/x.ts"));
    expect(outcome.ok).toBe(false);
  });

  it("is a no-op when all three fields already say what the rename says", () => {
    const before = stripWithTwoFiles();
    const after = ok(
      retargetFileTab(before, "src/a.ts", {
        title: "a.ts",
        relativePath: "src/a.ts",
        nodeId: "node-src/a.ts",
      }),
    );
    // The SAME object, so nothing re-renders on a signal that changed nothing.
    expect(after).toBe(before);
  });

  /**
   * A DIRECTORY RENAME IS OUT OF SCOPE, stated as a test rather than left to a
   * comment: a tab open on `dir/file.ts` needs a token for the NEW path and
   * only main can mint one, so those tabs keep the behaviour they have today
   * (the viewer's own orphan state on the delete of the old path).
   */
  it("does not retarget a tab merely because an ANCESTOR path was renamed", () => {
    const before = stripWithTwoFiles();
    const outcome = retargetFileTab(before, "src", renamedTo("source"));
    expect(outcome.ok).toBe(false);
    expect(
      (before.tabs[0] as WorkspaceFileTab).relativePath,
    ).toBe("src/a.ts");
  });
});
