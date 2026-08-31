/**
 * THE FILE-TAB BOUND: `addFileTab` refuses at `STUDIO_FILE_TABS_MAX`.
 *
 * A table test over the pure model, which is where the rule lives. The
 * component half - that the controller turns the refusal into copy - is
 * asserted by `terminal/__tests__/StudioWorkspaceController.test.tsx`; this
 * file owns the decision.
 *
 * RED ON REVERT. Delete the bound check in `addFileTab` and "refuses a new file
 * tab at the bound" fails on `result.ok`, because the model would admit a
 * seventeenth tab.
 */

import { describe, expect, it } from "vitest";
import { addFileTab, emptyWorkspace, fileTabCount } from "../workspace-model.js";
import { STUDIO_FILE_TABS_MAX, type WorkspaceState } from "../types.js";

function fileTab(index: number) {
  return {
    kind: "file" as const,
    tabId: `tab-${String(index)}`,
    title: `file-${String(index)}.ts`,
    relativePath: `src/file-${String(index)}.ts`,
    nodeId: `node-${String(index)}`,
    dirty: false,
  };
}

/** A workspace holding exactly `count` file tabs, built through the model. */
function withFileTabs(count: number): WorkspaceState {
  let state = emptyWorkspace("project-1");
  for (let index = 0; index < count; index += 1) {
    const result = addFileTab(state, fileTab(index));
    if (!result.ok) throw new Error(`seeding failed at ${String(index)}`);
    state = result.state;
  }
  return state;
}

describe("addFileTab and STUDIO_FILE_TABS_MAX", () => {
  it("admits tabs up to the bound", () => {
    const state = withFileTabs(STUDIO_FILE_TABS_MAX);
    expect(fileTabCount(state)).toBe(STUDIO_FILE_TABS_MAX);
  });

  it("refuses a new file tab at the bound, by name, and changes nothing", () => {
    const full = withFileTabs(STUDIO_FILE_TABS_MAX);
    const result = addFileTab(full, fileTab(STUDIO_FILE_TABS_MAX));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("file_tab_limit");
    // The refusal creates NOTHING: no tab, and no change of selection.
    expect(result.state).toBe(full);
    expect(fileTabCount(result.state)).toBe(STUDIO_FILE_TABS_MAX);
  });

  it("still SELECTS a file that is already open when the strip is full", () => {
    // The bound must not make an open file unreachable. This is why the check
    // sits below the dedupe rather than above it.
    const full = withFileTabs(STUDIO_FILE_TABS_MAX);
    const result = addFileTab(full, fileTab(3));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the existing tab to be selected");
    expect(result.state.activeTabId).toBe("tab-3");
    expect(fileTabCount(result.state)).toBe(STUDIO_FILE_TABS_MAX);
  });

  it("adopts a fresh token for an open file even at the bound", () => {
    // The epoch-recovery path: a file deleted and recreated is the same tab
    // with a new node token, and a full strip must not block the adoption or
    // the tab could never read its file again.
    const full = withFileTabs(STUDIO_FILE_TABS_MAX);
    const result = addFileTab(full, { ...fileTab(0), nodeId: "node-fresh" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the token to be adopted");
    const adopted = result.state.tabs.find((tab) => tab.tabId === "tab-0");
    expect(adopted?.kind).toBe("file");
    if (adopted?.kind !== "file") throw new Error("expected a file tab");
    expect(adopted.nodeId).toBe("node-fresh");
  });

  it("does not count terminal groups against the file bound", () => {
    // Two bounds, two quantities. A project at the terminal-group bound may
    // still open files.
    const state = withFileTabs(STUDIO_FILE_TABS_MAX - 1);
    const result = addFileTab(state, fileTab(STUDIO_FILE_TABS_MAX - 1));
    expect(result.ok).toBe(true);
  });
});
