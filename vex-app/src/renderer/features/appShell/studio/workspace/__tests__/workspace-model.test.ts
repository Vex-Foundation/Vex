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
  type TerminalWorkspaceRestore,
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
  resizePane,
  resizePanes,
  selectTab,
  setActivePane,
  setGroupOrientation,
  setPaneDisplayCwd,
  setTabTitle,
  terminalGroupCount,
  toPersistedLayout,
} from "../workspace-model.js";
import {
  WORKSPACE_TERMINAL_GROUPS_MAX,
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
      displayCwd: null,
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
    const ids = Array.from({ length: WORKSPACE_TERMINAL_GROUPS_MAX }, (_, index) =>
      `g${String(index)}`,
    );
    const full = withGroups(ids);

    const refused = addTerminalGroup(full, group("one-too-many"));

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.reason).toBe("keep_alive_limit");
    // Nothing was closed to make room. A UI that evicted here would kill a
    // process the user started and cannot recover.
    expect(terminalGroupCount(refused.state)).toBe(WORKSPACE_TERMINAL_GROUPS_MAX);
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

  it("ADOPTS a new node token for a file that is already open", () => {
    // A file deleted and recreated, or a project re-subscribed in a new
    // session, is the same tab to the user and a different token to main. The
    // old token no longer verifies, so a tab that kept it could never read its
    // file again.
    let state = emptyWorkspace("p1");
    state = mutate(addFileTab(state, fileTab("f1", "src/a.ts", "node-epoch-1")));
    state = mutate(addTerminalGroup(state, group("g1")));

    const again = addFileTab(state, fileTab("f2", "src/a.ts", "node-epoch-2"));

    expect(again.ok).toBe(true);
    const files = again.state.tabs.filter((tab) => tab.kind === "file");
    expect(files).toHaveLength(1);
    // Same tab, same position, new token, and it is selected.
    expect(files[0]?.tabId).toBe("f1");
    expect(files[0]?.kind === "file" ? files[0].nodeId : null).toBe("node-epoch-2");
    expect(again.state.tabs.map((tab) => tab.tabId)).toEqual(["f1", "g1"]);
    expect(again.state.activeTabId).toBe("f1");
  });

  it("leaves the tab untouched when the same token is reopened", () => {
    let state = emptyWorkspace("p1");
    state = mutate(addFileTab(state, fileTab("f1", "src/a.ts", "node-1")));
    const before = state.tabs;

    const again = addFileTab(state, fileTab("f2", "src/a.ts", "node-1"));

    expect(again.state.tabs).toBe(before);
    expect(again.state.activeTabId).toBe("f1");
  });

  it("keeps the node token out of the persisted layout", () => {
    let state = withGroups(["a"]);
    state = mutate(addFileTab(state, fileTab("f1", "src/a.ts", "node-secret")));

    // The token binds a project EPOCH under main's own key: it means nothing to
    // a future run, and file tabs are not persisted at all.
    expect(JSON.stringify(toPersistedLayout(state))).not.toContain("node-secret");
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

function sizesOf(state: WorkspaceState, tabId = "a"): number[] {
  const tab = state.tabs.find((candidate) => candidate.tabId === tabId);
  return (tab as WorkspaceTerminalGroup).panes.map((pane) => pane.relativeSize);
}

/**
 * Compare shares elementwise with a tolerance.
 *
 * These are LAYOUT fractions, not money: they are computed by division and
 * subtraction and land on values like 0.09999999999999998, which is the same
 * pane at pixel resolution. Rule 90's no-float law governs token amounts,
 * which never pass through this model.
 */
function expectSizes(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 10);
  });
}

/**
 * STATED CONTRACT CHANGE (stage B2 round 2): pane sizes SURVIVE.
 *
 * Round 1 re-shared the axis equally on every mutation, so `relativeSize` was a
 * function of the pane count alone and the persisted field could not affect
 * anything. These tests replace that contract with VS Code's: a split halves the
 * ACTIVE pane and leaves the others alone, a close redistributes the closed
 * share IN PROPORTION to the survivors, a restore preserves what was persisted,
 * and normalization only re-establishes the sum-to-1 invariant.
 */
describe("panes", () => {
  /** Split `count` times, always off whichever pane the previous split selected. */
  function splitTimes(state: WorkspaceState, count: number): WorkspaceState {
    let next = state;
    for (let index = 1; index <= count; index += 1) {
      next = mutate(
        addPane(next, "a", {
          paneId: `a:${String(index)}`,
          terminalId: `a-t${String(index + 1)}`,
          relativeSize: 0,
          displayCwd: null,
        }),
      );
    }
    return next;
  }

  it("splits the ACTIVE pane in half and leaves every other pane alone", () => {
    // Two splits off the first pane give 0.5 / 0.5, then the active (0.5) pane
    // halves: 0.5 / 0.25 / 0.25. Under the round-1 rule this was 1/3 each, which
    // resized a pane the user never touched.
    const state = splitTimes(withGroups(["a"]), 2);
    expectSizes(sizesOf(state), [0.5, 0.25, 0.25]);
    expect((state.tabs[0] as WorkspaceTerminalGroup).activePaneId).toBe("a:2");
  });

  it("inserts the new pane immediately after the one it was carved out of", () => {
    let state = splitTimes(withGroups(["a"]), 1);
    // Re-select the FIRST pane, then split it: the new pane belongs next to it,
    // not at the end of the axis.
    const group0 = state.tabs[0] as WorkspaceTerminalGroup;
    state = { ...state, tabs: [{ ...group0, activePaneId: "a:0" }] };
    state = mutate(
      addPane(state, "a", { paneId: "a:new", terminalId: "a-t3", relativeSize: 0, displayCwd: null }),
    );
    expect(
      (state.tabs[0] as WorkspaceTerminalGroup).panes.map((pane) => pane.paneId),
    ).toEqual(["a:0", "a:new", "a:1"]);
  });

  it("keeps the axis summing to 1 through a run of splits", () => {
    const state = splitTimes(withGroups(["a"]), 4);
    expect(sizesOf(state).reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
  });

  it("redistributes a closed pane's share IN PROPORTION to the survivors", () => {
    // 0.5 / 0.25 / 0.25. Closing the 0.5 pane leaves two equal survivors; closing
    // a 0.25 pane instead must leave the wide pane twice the narrow one.
    const state = splitTimes(withGroups(["a"]), 2);

    expectSizes(sizesOf(mutate(closePane(state, "a", "a:0"))), [0.5, 0.5]);

    const narrowClosed = sizesOf(mutate(closePane(state, "a", "a:2")));
    expect(narrowClosed[0]).toBeCloseTo(2 / 3, 10);
    expect(narrowClosed[1]).toBeCloseTo(1 / 3, 10);
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
      addPane(state, "a", { paneId: "a:1", terminalId: "a-t2", relativeSize: 0.5, displayCwd: null }),
    );
    const closed = mutate(closePane(state, "a", "a:1"));
    expect((closed.tabs[0] as WorkspaceTerminalGroup).activePaneId).toBe("a:0");
  });

  it("refuses an unknown pane", () => {
    const state = withGroups(["a"]);
    expect(closePane(state, "a", "ghost").ok).toBe(false);
  });

  it("moves a splitter as a transfer between the two panes it sits between", () => {
    // 0.5 / 0.25 / 0.25. Growing the middle pane must take from its RIGHT
    // neighbour only: the left pane is on the other side of a splitter the user
    // is not dragging, so its size may not move.
    const state = splitTimes(withGroups(["a"]), 2);
    const dragged = mutate(resizePane(state, "a", "a:1", 0.4));
    expectSizes(sizesOf(dragged), [0.5, 0.4, 0.1]);
  });

  it("inverts at the END pane, which has no right neighbour to trade with", () => {
    const state = splitTimes(withGroups(["a"]), 2);
    const dragged = mutate(resizePane(state, "a", "a:2", 0.4));
    // The end pane trades with the pane to its LEFT; the first pane is untouched.
    expectSizes(sizesOf(dragged), [0.5, 0.1, 0.4]);
  });

  it("CLAMPS a drag at the neighbour's edge instead of producing a negative share", () => {
    const state = splitTimes(withGroups(["a"]), 2);
    const dragged = mutate(resizePane(state, "a", "a:1", 5));
    // The pooled share of the two panes either side of the splitter is 0.5.
    expectSizes(sizesOf(dragged), [0.5, 0.5, 0]);
    expect(sizesOf(dragged).reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
  });

  it("settles a whole-axis drag and refuses one whose arity does not match", () => {
    const state = splitTimes(withGroups(["a"]), 2);
    expectSizes(sizesOf(mutate(resizePanes(state, "a", [0.2, 0.2, 0.6]))), [0.2, 0.2, 0.6]);
    // A stale array from a group that changed under the drag would otherwise
    // assign one pane's size to another.
    expect(resizePanes(state, "a", [0.5, 0.5])).toEqual({
      ok: false,
      reason: "unknown_pane",
      state,
    });
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

  /**
   * STATED CONTRACT CHANGE. Round 1's `fromSnapshot` equalized every restored
   * pane, so `relativeSize` was persisted and then thrown away on read - the
   * field existed in the wire schema and could not affect anything.
   */
  it("PRESERVES the persisted pane sizes through a save and a restore", () => {
    let state = withGroups(["a"]);
    state = mutate(
      addPane(state, "a", { paneId: "a:1", terminalId: "a-t2", relativeSize: 0, displayCwd: null }),
    );
    state = mutate(resizePane(state, "a", "a:0", 0.8));

    const layout = toPersistedLayout(state);
    expectSizes(layout.groups[0]?.panes.map((pane) => pane.relativeSize) ?? [], [0.8, 0.2]);

    const restored = fromSnapshot(snapshotWith(layout, ["a-t", "a-t2"]));
    expectSizes(
      (restored.tabs[0] as WorkspaceTerminalGroup).panes.map((pane) => pane.relativeSize),
      [0.8, 0.2],
    );
  });

  it("rescales to sum 1 when a restore DROPS a pane, keeping the survivors' proportions", () => {
    let state = withGroups(["a"]);
    state = mutate(
      addPane(state, "a", { paneId: "a:1", terminalId: "a-t2", relativeSize: 0, displayCwd: null }),
    );
    state = mutate(
      addPane(state, "a", { paneId: "a:2", terminalId: "a-t3", relativeSize: 0, displayCwd: null }),
    );
    state = mutate(resizePanes(state, "a", [0.6, 0.3, 0.1]));
    const layout = toPersistedLayout(state);

    // Only two of the three buffers were serialized; the third pane is dropped,
    // and the axis must still sum to 1 without equalizing the two that remain.
    const restored = fromSnapshot(snapshotWith(layout, ["a-t", "a-t2"]));
    const sizes = (restored.tabs[0] as WorkspaceTerminalGroup).panes.map(
      (pane) => pane.relativeSize,
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
    expect((sizes[0] ?? 0) / (sizes[1] ?? 1)).toBeCloseTo(2, 10);
  });

  it("falls back to equal shares for a snapshot whose axis has no positive share", () => {
    const layout = toPersistedLayout(withGroups(["a"]));
    const zeroed = {
      ...layout,
      groups: layout.groups.map((group) => ({
        ...group,
        panes: group.panes.map((pane) => ({ ...pane, relativeSize: 0 })),
      })),
    };
    // A hand-written or corrupt snapshot has no proportions to preserve, and an
    // all-zero axis renders as nothing.
    const restored = fromSnapshot(snapshotWith(zeroed, ["a-t"]));
    expectSizes(
      (restored.tabs[0] as WorkspaceTerminalGroup).panes.map((pane) => pane.relativeSize),
      [1],
    );
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

function fileTab(tabId: string, relativePath: string, nodeId = `node-${relativePath}`) {
  return {
    kind: "file" as const,
    tabId,
    title: relativePath,
    relativePath,
    // The main-minted token the tab reads its file through. Defaulted from the
    // path so a case that does not care about token identity reads unchanged,
    // and overridable by the cases that do.
    nodeId,
    dirty: false,
  };
}

/**
 * A REVIVED workspace, as main hands one to the renderer.
 *
 * `fromSnapshot` no longer reads a persisted file: main revives the terminals
 * first and returns the layout already rewritten onto the live ids, so this
 * helper models that shape. The serialized buffers are deliberately absent -
 * they stay in the pty host and reach the renderer as a replay on attach.
 */
function snapshotWith(
  layout: ReturnType<typeof toPersistedLayout>,
  terminalIds: string[],
): TerminalWorkspaceRestore {
  return {
    layout,
    terminals: terminalIds.map((terminalId) => ({
      terminalId,
      title: "bash",
      shellName: "bash",
      displayCwd: null,
      droppedRows: 0,
      reducedRows: 0,
    })),
    idMap: terminalIds.map((terminalId) => ({
      from: `old-${terminalId}`,
      to: terminalId,
    })),
  };
}

/**
 * The three mutations the React controller needs and must not keep privately.
 *
 * Each of them is state the model already OWNS: the active pane is what a split
 * carves out of, the orientation is what a restore lays panes along, and the
 * title is what the strip renders. A controller holding any of them in its own
 * `useState` would give each one a second source of truth, free to disagree with
 * the model exactly after a restore or a close - which is when it matters.
 */
describe("controller-facing mutations", () => {
  it("makes a pane active, and refuses a pane or tab that does not exist", () => {
    const state = withGroups(["a"]);
    const split = addPane(state, "a", { paneId: "a:1", terminalId: "t2", relativeSize: 0, displayCwd: null });
    if (!split.ok) throw new Error("split refused");

    const selected = setActivePane(split.state, "a", "a:0");
    if (!selected.ok) throw new Error("unexpected refusal");
    const tab = selected.state.tabs[0];
    if (tab?.kind !== "terminalGroup") throw new Error("expected a group");
    expect(tab.activePaneId).toBe("a:0");

    expect(setActivePane(split.state, "a", "nope")).toMatchObject({
      ok: false,
      reason: "unknown_pane",
    });
    expect(setActivePane(split.state, "nope", "a:0")).toMatchObject({
      ok: false,
      reason: "unknown_tab",
    });
  });

  it("makes the ACTIVE pane the one a later split carves out of", () => {
    // The reason `setActivePane` belongs to the model rather than to a
    // component: `addPane` reads `activePaneId` to decide whose share to halve.
    let state = withGroups(["a"]);
    const first = addPane(state, "a", { paneId: "a:1", terminalId: "t2", relativeSize: 0, displayCwd: null });
    if (!first.ok) throw new Error("split refused");
    state = first.state;

    const back = setActivePane(state, "a", "a:0");
    if (!back.ok) throw new Error("unexpected refusal");

    const second = addPane(back.state, "a", {
      paneId: "a:2",
      terminalId: "t3",
      relativeSize: 0,
      displayCwd: null,
    });
    if (!second.ok) throw new Error("split refused");
    const tab = second.state.tabs[0];
    if (tab?.kind !== "terminalGroup") throw new Error("expected a group");
    // The new pane sits immediately after the one it was carved out of.
    expect(tab.panes.map((pane) => pane.paneId)).toEqual(["a:0", "a:2", "a:1"]);
  });

  it("flips the orientation and PRESERVES the shares, which are axis-agnostic", () => {
    let state = withGroups(["a"]);
    const split = addPane(state, "a", { paneId: "a:1", terminalId: "t2", relativeSize: 0, displayCwd: null });
    if (!split.ok) throw new Error("split refused");
    const sized = resizePanes(split.state, "a", [0.8, 0.2]);
    if (!sized.ok) throw new Error("resize refused");
    state = sized.state;

    const flipped = setGroupOrientation(state, "a", "vertical");
    if (!flipped.ok) throw new Error("unexpected refusal");
    const tab = flipped.state.tabs[0];
    if (tab?.kind !== "terminalGroup") throw new Error("expected a group");
    expect(tab.orientation).toBe("vertical");
    expect(tab.panes.map((pane) => pane.relativeSize)).toEqual([0.8, 0.2]);

    // Setting the orientation it already has changes nothing at all.
    const same = setGroupOrientation(flipped.state, "a", "vertical");
    if (!same.ok) throw new Error("unexpected refusal");
    expect(same.state).toBe(flipped.state);
  });

  it("renames a tab but refuses to let a shell BLANK the name it reports", () => {
    const state = withGroups(["a"]);

    const named = setTabTitle(state, "a", "  vim README.md  ");
    if (!named.ok) throw new Error("unexpected refusal");
    expect(named.state.tabs[0]?.title).toBe("vim README.md");

    // An empty or whitespace title leaves the tab labelled as it was: a strip
    // entry with no name is one a user cannot aim at.
    const blanked = setTabTitle(named.state, "a", "   ");
    if (!blanked.ok) throw new Error("unexpected refusal");
    expect(blanked.state.tabs[0]?.title).toBe("vim README.md");

    expect(setTabTitle(state, "nope", "x")).toMatchObject({
      ok: false,
      reason: "unknown_tab",
    });
  });
});

/**
 * WHERE EACH SHELL IS - one field, on the pane, with two writers.
 *
 * The defect this replaced: the panel component kept its own
 * `Map<terminalId, displayCwd>` fed ONLY by the property stream, so a terminal
 * that was reattached rather than freshly created had no entry and the header
 * read "Working directory not known yet" until the user typed `cd`. The seed
 * and the update now write the same field, which is what makes the header
 * right on the first frame after a restore.
 */
describe("the pane's directory", () => {
  it("SEEDS from the restore row main built from the host's answer", () => {
    const layout = toPersistedLayout(withGroups(["a"]));
    const snapshot = snapshotWith(layout, ["a-t"]);
    const seeded: TerminalWorkspaceRestore = {
      ...snapshot,
      terminals: snapshot.terminals.map((entry) => ({
        ...entry,
        displayCwd: "vex-app/src/lib",
      })),
    };

    const state = fromSnapshot(seeded);

    expect((state.tabs[0] as WorkspaceTerminalGroup).panes[0]?.displayCwd).toBe(
      "vex-app/src/lib",
    );
  });

  it("keeps the UNKNOWN unknown when the host could not describe the terminal", () => {
    // `snapshotWith` builds rows with `displayCwd: null`, which is exactly the
    // row main sends for a terminal the host did not answer for.
    const state = fromSnapshot(snapshotWith(toPersistedLayout(withGroups(["a"])), ["a-t"]));

    expect((state.tabs[0] as WorkspaceTerminalGroup).panes[0]?.displayCwd).toBeNull();
  });

  it("is OVERWRITTEN by a property event, addressed by terminal id", () => {
    const seeded = fromSnapshot({
      ...snapshotWith(toPersistedLayout(withGroups(["a"])), ["a-t"]),
      terminals: [
        {
          terminalId: "a-t",
          title: "bash",
          shellName: "bash",
          displayCwd: "vex-app",
          droppedRows: 0,
          reducedRows: 0,
        },
      ],
    });

    const moved = setPaneDisplayCwd(seeded, "a-t", "vex-app/src");
    if (!moved.ok) throw new Error("unexpected refusal");
    expect((moved.state.tabs[0] as WorkspaceTerminalGroup).panes[0]?.displayCwd).toBe(
      "vex-app/src",
    );

    // Identity is preserved when the shell re-reports the same directory, so a
    // repeat costs no render.
    const again = setPaneDisplayCwd(moved.state, "a-t", "vex-app/src");
    if (!again.ok) throw new Error("unexpected refusal");
    expect(again.state).toBe(moved.state);
  });

  it("moves ONLY the reporting terminal's pane, across groups", () => {
    let state = withGroups(["a", "b"]);
    state = mutate(
      addPane(state, "a", {
        paneId: "a:1",
        terminalId: "a-t2",
        relativeSize: 0,
        displayCwd: null,
      }),
    );

    const moved = setPaneDisplayCwd(state, "a-t2", "vex-app/docs");
    if (!moved.ok) throw new Error("unexpected refusal");
    const groupA = moved.state.tabs[0] as WorkspaceTerminalGroup;
    const groupB = moved.state.tabs[1] as WorkspaceTerminalGroup;
    expect(
      groupA.panes.map((pane) => [pane.terminalId, pane.displayCwd]),
    ).toEqual([
      ["a-t", null],
      ["a-t2", "vex-app/docs"],
    ]);
    expect(groupB.panes[0]?.displayCwd).toBeNull();
  });

  it("IGNORES a terminal no pane holds instead of refusing", () => {
    // Property events race a close. A pane removed between the host emitting
    // and the renderer applying is an ordering, not a user-visible failure.
    const state = withGroups(["a"]);
    const stray = setPaneDisplayCwd(state, "not-a-terminal", "vex-app");
    expect(stray).toEqual({ ok: true, state });
  });

  it("is NOT persisted: the layout carries topology, never a directory", () => {
    const seeded = mutate(setPaneDisplayCwd(withGroups(["a"]), "a-t", "vex-app/src"));
    const layout = toPersistedLayout(seeded);
    expect(layout.groups[0]?.panes[0]).toEqual({ terminalId: "a-t", relativeSize: 1 });
  });
});
