/**
 * The Studio workspace as a PURE STATE MACHINE.
 *
 * Every function here takes a state and returns a new one. No React, no DOM, no
 * bridge, no time. That is what makes the rules that actually bite - selection
 * after a delete, repair of a stale selection, the keep-alive refusal, the
 * mapping to and from a persisted snapshot - testable as a table rather than
 * through a mounted terminal.
 *
 * ## Selection rules, stated once
 *
 *  - CREATE selects the new tab. A user who opened a terminal wants to be in it.
 *  - CLOSE selects the NEIGHBOUR TO THE LEFT, falling back to the right, and
 *    `null` only when nothing is left. Selecting the right neighbour first
 *    would march the selection toward the end of the strip as a user closes a
 *    run of tabs, which is disorienting; every editor with a tab strip picks
 *    the left one for that reason.
 *  - A selection that names a tab which no longer exists is REPAIRED to the
 *    first tab rather than left dangling. An invalid selection is a state the
 *    UI cannot render, so the model never returns one.
 */

import {
  STUDIO_FILE_TABS_MAX,
  WORKSPACE_TERMINAL_GROUPS_MAX,
  type FileOpenMode,
  type WorkspaceCleanupPlan,
  type WorkspaceFileTab,
  type WorkspaceMutation,
  type WorkspacePane,
  type WorkspaceState,
  type WorkspaceTab,
  type WorkspaceTerminalGroup,
} from "./types.js";
import type {
  TerminalWorkspaceLayout,
  TerminalWorkspaceRestore,
} from "@shared/schemas/terminal.js";
import type { PersistedFileTab } from "../../../../stores/uiStore/studio-file-tabs.js";

export function emptyWorkspace(projectId: string): WorkspaceState {
  return { projectId, tabs: [], activeTabId: null };
}

function isGroup(tab: WorkspaceTab): tab is WorkspaceTerminalGroup {
  return tab.kind === "terminalGroup";
}

export function terminalGroupCount(state: WorkspaceState): number {
  return state.tabs.filter(isGroup).length;
}

/** Open file tabs. The quantity `STUDIO_FILE_TABS_MAX` bounds. */
export function fileTabCount(state: WorkspaceState): number {
  return state.tabs.filter((tab) => tab.kind === "file").length;
}

/**
 * Whether another terminal group may be opened, counting groups NOT YET IN THE
 * STATE.
 *
 * The keep-alive bound is the model's rule, so the question is answered here
 * rather than by a controller comparing counts against the constant itself.
 * `pending` is what makes it answerable BEFORE the pty exists: a controller
 * that created first and asked afterwards had nowhere to put a refused
 * terminal, so a refused fifth group left a running shell attached to no pane
 * and visible in no tab. Asking first, with in-flight opens counted, means a
 * refusal creates nothing at all.
 */
export function canAddTerminalGroup(state: WorkspaceState, pending: number): boolean {
  return terminalGroupCount(state) + Math.max(0, pending) < WORKSPACE_TERMINAL_GROUPS_MAX;
}

/**
 * Force `activeTabId` to name a tab that exists.
 *
 * Applied on the way OUT of every mutation, so no caller can observe an
 * unrenderable selection - including callers that build a state by hand, which
 * is what a restore from a snapshot is.
 */
export function repairSelection(state: WorkspaceState): WorkspaceState {
  if (state.tabs.length === 0) {
    return state.activeTabId === null ? state : { ...state, activeTabId: null };
  }
  const exists = state.tabs.some((tab) => tab.tabId === state.activeTabId);
  if (exists) return state;
  return { ...state, activeTabId: state.tabs[0]?.tabId ?? null };
}

/** Add a terminal group. Refused - never evicting - at the keep-alive bound. */
export function addTerminalGroup(
  state: WorkspaceState,
  group: WorkspaceTerminalGroup,
): WorkspaceMutation {
  if (terminalGroupCount(state) >= WORKSPACE_TERMINAL_GROUPS_MAX) {
    return { ok: false, reason: "keep_alive_limit", state };
  }
  return {
    ok: true,
    state: repairSelection({
      ...state,
      tabs: [...state.tabs, group],
      activeTabId: group.tabId,
    }),
  };
}

/**
 * Is this tab the workspace's PREVIEW slot?
 *
 * The one place "absent means pinned" is decided. A terminal group is never a
 * preview: the concept is about a file the user is browsing past, and a running
 * shell is not something a click may replace.
 */
export function isPreviewFileTab(tab: WorkspaceTab): tab is WorkspaceFileTab {
  return tab.kind === "file" && tab.preview === true;
}

/**
 * THE TERMINAL THE USER IS IN: the active pane of the active tab, or `null`.
 *
 * `null` is an ordinary answer with three causes that are the same answer to
 * every caller - the strip is empty, the active tab is a FILE, or the active
 * group's pane record is gone - so it is deliberately not distinguished here.
 * VS Code holds the same fact as `terminalService.activeInstance` and its
 * `focusActiveInstance` returns silently when there is none
 * (`terminalService.ts:406`).
 *
 * A SELECTOR, not state: nothing may hold a second answer to "which terminal
 * is active", because the strip and the panel already render from this one.
 */
export function activeTerminalIdOf(state: WorkspaceState): string | null {
  const active = state.tabs.find((tab) => tab.tabId === state.activeTabId);
  if (active === undefined || active.kind !== "terminalGroup") return null;
  const pane = active.panes.find((candidate) => candidate.paneId === active.activePaneId);
  return pane?.terminalId ?? null;
}

/**
 * The workspace's preview tab, or `null`.
 *
 * There is AT MOST ONE, and that is an invariant this module maintains rather
 * than a search that happens to find one result: `addFileTab` is the only
 * writer of the flag and it clears the previous holder in the same step.
 * VS Code holds the same fact as a single `preview` field on the group
 * (`editorGroupModel.ts:212`) and derives `isPinned` from it. We keep the flag
 * ON THE TAB instead, because the strip renders from the tab list and a
 * component asking "am I the preview" would otherwise need the whole workspace;
 * the invariant is preserved here in exchange.
 */
export function previewFileTab(state: WorkspaceState): WorkspaceFileTab | null {
  return state.tabs.find(isPreviewFileTab) ?? null;
}

/**
 * Open a file tab.
 *
 * `mode` defaults to `"pinned"`, which is exactly what this function did before
 * previews existed, so no caller changed behaviour by gaining the option.
 *
 * ## What `"preview"` does, and why it is VS Code's rule
 *
 * A preview open REPLACES the workspace's current preview tab IN ITS POSITION.
 * That is `editorGroupModel.openEditor`'s `replaceEditor(this.preview, ...)`
 * path, and the position is the load-bearing half: clicking down a file tree
 * must not walk a tab along the strip, or the thing the user is reading moves
 * under them on every arrow press.
 *
 * The `preview` field on the incoming tab is IGNORED, exactly as `addPane`
 * ignores the share it is handed. The mode is the caller's decision; the flag
 * is this module's, because the "at most one preview" invariant cannot survive
 * a caller that writes it.
 *
 * ## Reopening a file that is already open
 *
 * Still selects rather than opening twice, and now also PROMOTES: opening an
 * already-open preview tab with `"pinned"` pins it, which is how a double click
 * on a file the single click already previewed keeps it. A `"preview"` open of
 * an already-open tab changes nothing about its state - VS Code likewise never
 * demotes a pinned editor on an ordinary open.
 */
export function addFileTab(
  state: WorkspaceState,
  tab: WorkspaceFileTab,
  options?: { readonly mode?: FileOpenMode },
): WorkspaceMutation {
  const mode: FileOpenMode = options?.mode ?? "pinned";
  // A file already open is SELECTED rather than opened twice: two tabs on one
  // path would give the same buffer two dirty flags.
  const existing = state.tabs.find(
    (candidate) => candidate.kind === "file" && candidate.relativePath === tab.relativePath,
  );
  if (existing !== undefined && existing.kind === "file") {
    // The PATH is the identity, the TOKEN is not. A file deleted and recreated,
    // or a project re-subscribed in a new session, is the same tab to the user
    // and a different `nodeId` to main - and the old token no longer verifies,
    // so a tab that kept it could never read its file again. Adopt the incoming
    // one; the tab, its position and its dirty flag stay exactly where they are.
    const adoptsToken = existing.nodeId !== tab.nodeId;
    const promotes = mode === "pinned" && existing.preview === true;
    if (!adoptsToken && !promotes) {
      return { ok: true, state: { ...state, activeTabId: existing.tabId } };
    }
    const updated: WorkspaceFileTab = {
      ...existing,
      ...(adoptsToken ? { nodeId: tab.nodeId } : {}),
      ...(promotes ? { preview: false } : {}),
    };
    return {
      ok: true,
      state: {
        ...state,
        tabs: state.tabs.map((candidate) =>
          candidate.tabId === existing.tabId ? updated : candidate,
        ),
        activeTabId: existing.tabId,
      },
    };
  }

  const opened: WorkspaceFileTab = { ...tab, preview: mode === "preview" };

  // REPLACEMENT, before the bound. A preview open that lands on an existing
  // preview adds no tab, so a workspace at the limit can still browse - and the
  // replaced tab keeps its INDEX, which is what makes the strip stand still.
  const replaced = mode === "preview" ? previewFileTab(state) : null;
  if (replaced !== null) {
    return {
      ok: true,
      state: repairSelection({
        ...state,
        tabs: state.tabs.map((candidate) =>
          candidate.tabId === replaced.tabId ? opened : candidate,
        ),
        activeTabId: opened.tabId,
      }),
    };
  }

  // THE BOUND, and it is checked HERE rather than above the dedupe on purpose:
  // returning to a file that is already open opens nothing, so a full strip
  // must still be able to select the tabs it already holds. Only a genuinely
  // NEW tab is refused, and the refusal is named so the controller can say
  // which bound stopped it instead of appearing to ignore the click.
  if (fileTabCount(state) >= STUDIO_FILE_TABS_MAX) {
    return { ok: false, reason: "file_tab_limit", state };
  }
  return {
    ok: true,
    state: repairSelection({
      ...state,
      tabs: [...state.tabs, opened],
      activeTabId: opened.tabId,
    }),
  };
}

/**
 * PROMOTE the preview tab to a kept one. Idempotent.
 *
 * The single hook every promotion gesture calls: the tab's double click, its
 * "Keep open" action, the keyboard command, and - when the viewer becomes
 * editable - the first edit, which is what VS Code pins on
 * (`editorGroupModel.doPin`). There is deliberately no `unpinTab`: nothing in
 * Studio asks for one, and a function with no caller is dead code.
 *
 * A tab that is already pinned, and a terminal group, are NOT refusals. Both
 * are ordinary states for a gesture that fires on whatever the user
 * double-clicked, and the state comes back IDENTICAL so nothing re-renders.
 * Only a tab that is not there at all is refused, because that names a real
 * disagreement between the caller and the strip.
 */
export function pinTab(state: WorkspaceState, tabId: string): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined) return { ok: false, reason: "unknown_tab", state };
  if (!isPreviewFileTab(target)) return { ok: true, state };
  return { ok: true, state: replaceTab(state, { ...target, preview: false }) };
}

export function selectTab(state: WorkspaceState, tabId: string): WorkspaceMutation {
  if (!state.tabs.some((tab) => tab.tabId === tabId)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  return { ok: true, state: { ...state, activeTabId: tabId } };
}

/**
 * The tab `offset` places from the active one, WRAPPING, or `null`.
 *
 * The rule behind `Ctrl+Tab` / `Ctrl+Shift+Tab`, owned here rather than by the
 * keyboard hook or the controller, because "which tab comes after this one" is
 * a fact about the strip and the strip's order is this module's.
 *
 * WRAPPING is what VS Code's own next/previous pair does over its tab list: a
 * strip that stopped at the last tab would make the shortcut dead exactly where
 * a user reaches for it most, and there is no second gesture meaning "and now
 * go back to the first".
 *
 * `null` when the workspace holds no tabs, or when nothing is selected: both
 * are real states (an empty workspace, a restore that brought nothing back) and
 * neither has a relative neighbour to name.
 */
export function tabIdAtOffset(state: WorkspaceState, offset: number): string | null {
  const count = state.tabs.length;
  if (count === 0 || state.activeTabId === null) return null;
  const index = state.tabs.findIndex((tab) => tab.tabId === state.activeTabId);
  if (index === -1) return null;
  // `% count`, then `+ count`, then `% count` again: a negative offset would
  // otherwise land on a negative index, which is not a tab.
  const next = (((index + offset) % count) + count) % count;
  return state.tabs[next]?.tabId ?? null;
}

/**
 * Close a tab. Selection moves LEFT, then right, then to nothing.
 */
export function closeTab(state: WorkspaceState, tabId: string): WorkspaceMutation {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index === -1) return { ok: false, reason: "unknown_tab", state };

  const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);
  let activeTabId = state.activeTabId;
  if (state.activeTabId === tabId) {
    const left = index - 1 >= 0 ? tabs[index - 1] : undefined;
    const right = tabs[index];
    activeTabId = left?.tabId ?? right?.tabId ?? null;
  }
  return { ok: true, state: repairSelection({ ...state, tabs, activeTabId }) };
}

/**
 * Add a pane to a group (a split).
 *
 * THE NEW PANE TAKES HALF OF THE ACTIVE PANE, and every other pane keeps the
 * share it had. That is VS Code's split semantics, and it is the only rule that
 * makes a split feel like a split: equalizing instead would resize panes the
 * user had deliberately sized, several splits away from where they clicked.
 *
 * The new pane is inserted immediately AFTER the pane it was carved out of, so
 * it appears where the user's gesture pointed rather than at the end of the axis.
 *
 * `pane.relativeSize` is IGNORED. The caller cannot know the group's current
 * shares, so the split - not the caller - decides the size, and the caller is
 * free to pass any placeholder.
 */
export function addPane(
  state: WorkspaceState,
  tabId: string,
  pane: WorkspacePane,
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined || !isGroup(target)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  if (target.panes.length === 0) {
    return {
      ok: true,
      state: replaceTab(state, {
        ...target,
        panes: [{ ...pane, relativeSize: 1 }],
        activePaneId: pane.paneId,
      }),
    };
  }

  const activeIndex = Math.max(
    0,
    target.panes.findIndex((candidate) => candidate.paneId === target.activePaneId),
  );
  const donor = target.panes[activeIndex];
  const half = (donor?.relativeSize ?? 1 / target.panes.length) / 2;

  const panes: WorkspacePane[] = [];
  target.panes.forEach((candidate, index) => {
    if (index === activeIndex) {
      panes.push({ ...candidate, relativeSize: half });
      panes.push({ ...pane, relativeSize: half });
      return;
    }
    panes.push(candidate);
  });

  return {
    ok: true,
    state: replaceTab(state, {
      ...target,
      panes: normalizeToSumOne(panes),
      activePaneId: pane.paneId,
    }),
  };
}

/**
 * Set one pane's share, compensating its NEIGHBOUR so the axis still sums to 1.
 *
 * A splitter sits BETWEEN two panes and moving it is a transfer between exactly
 * those two: growing one by taking from every other pane would move content the
 * user is not dragging. The neighbour is the pane to the RIGHT, except for the
 * end pane, which has none and therefore trades with the pane to its LEFT -
 * the inversion the split-pane primitive applies at the same seam.
 *
 * The transfer is CLAMPED by what the neighbour actually has, so a drag past the
 * neighbour's edge stops at the edge instead of producing a negative share.
 */
export function resizePane(
  state: WorkspaceState,
  tabId: string,
  paneId: string,
  relativeSize: number,
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined || !isGroup(target)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  const index = target.panes.findIndex((pane) => pane.paneId === paneId);
  if (index === -1) return { ok: false, reason: "unknown_pane", state };
  if (target.panes.length === 1) {
    return { ok: true, state };
  }

  const partnerIndex = index === target.panes.length - 1 ? index - 1 : index + 1;
  const current = target.panes[index]?.relativeSize ?? 0;
  const partner = target.panes[partnerIndex]?.relativeSize ?? 0;
  const pooled = current + partner;
  const next = Math.min(Math.max(relativeSize, 0), pooled);

  const panes = target.panes.map((pane, position) => {
    if (position === index) return { ...pane, relativeSize: next };
    if (position === partnerIndex) return { ...pane, relativeSize: pooled - next };
    return pane;
  });
  return { ok: true, state: replaceTab(state, { ...target, panes }) };
}

/**
 * Set every share at once, as a splitter drag that settled does.
 *
 * The array is positional and must match the group's pane count; a mismatch is
 * refused rather than zipped against whichever panes happen to line up, because
 * a stale array from a group that changed under the drag would silently assign
 * one pane's size to another.
 */
export function resizePanes(
  state: WorkspaceState,
  tabId: string,
  relativeSizes: readonly number[],
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined || !isGroup(target)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  if (relativeSizes.length !== target.panes.length) {
    return { ok: false, reason: "unknown_pane", state };
  }
  const panes = target.panes.map((pane, index) => ({
    ...pane,
    relativeSize: Math.max(relativeSizes[index] ?? 0, 0),
  }));
  return {
    ok: true,
    state: replaceTab(state, { ...target, panes: normalizeToSumOne(panes) }),
  };
}

/**
 * Remove a pane.
 *
 * Removing the LAST pane of a group is refused rather than silently closing the
 * group: closing a tab is a different user intention with different cleanup
 * (the pty is killed rather than detached), and collapsing the two here would
 * make one gesture perform the other's effect.
 */
export function closePane(
  state: WorkspaceState,
  tabId: string,
  paneId: string,
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined || !isGroup(target)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  if (!target.panes.some((pane) => pane.paneId === paneId)) {
    return { ok: false, reason: "unknown_pane", state };
  }
  if (target.panes.length === 1) {
    return { ok: false, reason: "last_pane", state };
  }
  const index = target.panes.findIndex((pane) => pane.paneId === paneId);
  const panes = target.panes.filter((pane) => pane.paneId !== paneId);
  const activePaneId =
    target.activePaneId === paneId
      ? (panes[Math.max(0, index - 1)]?.paneId ?? panes[0]?.paneId ?? "")
      : target.activePaneId;
  // The closed pane's share is redistributed to the survivors IN PROPORTION to
  // what they already held, so a wide pane stays wide relative to a narrow one.
  return {
    ok: true,
    state: replaceTab(state, {
      ...target,
      panes: normalizeToSumOne(panes),
      activePaneId,
    }),
  };
}

/**
 * Make a pane the group's active one.
 *
 * The active pane is what a SPLIT carves out of and what a pane close falls back
 * from, so "which pane did the user last touch" is model state, not a component's
 * private memory. A controller that kept it locally would let the two disagree
 * exactly when it matters: after a restore, or after a close moved the selection.
 */
export function setActivePane(
  state: WorkspaceState,
  tabId: string,
  paneId: string,
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined || !isGroup(target)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  if (!target.panes.some((pane) => pane.paneId === paneId)) {
    return { ok: false, reason: "unknown_pane", state };
  }
  if (target.activePaneId === paneId) return { ok: true, state };
  return { ok: true, state: replaceTab(state, { ...target, activePaneId: paneId }) };
}

/**
 * Record where one terminal's shell now is, from its `displayCwd` property.
 *
 * ADDRESSED BY TERMINAL ID, not by tab and pane, because the property event
 * names a terminal and nothing else: a terminal is in exactly one pane of one
 * group, and making the caller re-derive that pair would give the wiring a
 * chance to attribute one shell's directory to another after a split reordered
 * the panes.
 *
 * An unknown terminal is NOT a refusal. Property events race a close: a pane
 * removed between the host emitting and the renderer applying is a normal
 * ordering, not a user-visible failure, and reporting it would put a notice on
 * screen for a directory nobody is looking at. Identity is preserved when the
 * value has not changed, so a shell re-reporting the same directory re-renders
 * nothing.
 */
export function setPaneDisplayCwd(
  state: WorkspaceState,
  terminalId: string,
  displayCwd: string,
): WorkspaceMutation {
  for (const tab of state.tabs) {
    if (!isGroup(tab)) continue;
    const pane = tab.panes.find((candidate) => candidate.terminalId === terminalId);
    if (pane === undefined) continue;
    if (pane.displayCwd === displayCwd) return { ok: true, state };
    return {
      ok: true,
      state: replaceTab(state, {
        ...tab,
        panes: tab.panes.map((candidate) =>
          candidate.terminalId === terminalId ? { ...candidate, displayCwd } : candidate,
        ),
      }),
    };
  }
  return { ok: true, state };
}

/**
 * Set the axis a group's panes are laid out along.
 *
 * Shares are RELATIVE and therefore axis-agnostic, so flipping the orientation
 * re-lays the same proportions along the other axis rather than resetting them.
 * That is what makes "split side by side" and "split top and bottom" one
 * decision the user can revise, instead of a property fixed when the group was
 * created.
 */
export function setGroupOrientation(
  state: WorkspaceState,
  tabId: string,
  orientation: "horizontal" | "vertical",
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined || !isGroup(target)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  if (target.orientation === orientation) return { ok: true, state };
  return { ok: true, state: replaceTab(state, { ...target, orientation }) };
}

/**
 * Rename a tab.
 *
 * The title is DISPLAY state that the pty host owns upstream: it arrives as a
 * `title` property change and is re-read from the snapshot on restore. It lives
 * on the tab anyway because the strip renders from the model, and an empty title
 * is refused so a shell that reports one cannot blank the tab it names.
 */
export function setTabTitle(
  state: WorkspaceState,
  tabId: string,
  title: string,
): WorkspaceMutation {
  const target = state.tabs.find((tab) => tab.tabId === tabId);
  if (target === undefined) return { ok: false, reason: "unknown_tab", state };
  const next = title.trim();
  if (next === "" || next === target.title) return { ok: true, state };
  return { ok: true, state: replaceTab(state, { ...target, title: next }) };
}

/**
 * The three facts a renamed file hands its tab. Main mints all three.
 *
 * A narrow record rather than the wire's `FileNode`, so this module keeps its
 * one dependency (the terminal snapshot schema) and does not gain the files
 * schema for a three-field read.
 */
export interface FileTabTarget {
  /** The entry's own name, which is what the strip shows. */
  readonly title: string;
  /** Project-root-relative, and the tab's DISPLAY and DEDUPE identity. */
  readonly relativePath: string;
  /** The fresh node token. A rename always mints one; see `WorkspaceFileTab`. */
  readonly nodeId: string;
}

/**
 * THE TAB FOLLOWS ITS FILE'S RENAME: same tab, same position, new name.
 *
 * VS Code's behaviour, and it is a behaviour rather than an omission: renaming
 * an open file there leaves the editor open on the renamed resource
 * (`explorerViewer.ts` reopens the moved resources rather than closing them).
 * A strip that kept the old name would leave the user reading a file under a
 * title that names nothing on disk, and a strip that closed the tab would take
 * away what they were looking at as the cost of naming it.
 *
 * MATCHED ON THE OLD PATH, not on a tab id, because the caller is the explorer
 * and the explorer has never heard of a tab. The path is already the file
 * tab's dedupe identity (`addFileTab`), so this reuses that identity rather
 * than inventing a second one.
 *
 * ALL THREE FIELDS MOVE TOGETHER, and they have to: a rename mints a new node
 * token (the id is derived from the path), so a tab that kept the old one
 * could never read its file again, and `FileViewerRegistry.acquire` uses
 * exactly that token change to swap in a session pointed at the new path.
 *
 * `unknown_tab` when no file tab holds that path, which is the ordinary case -
 * most renames are of files nobody has open - and is why the caller must be
 * able to ignore a refusal.
 *
 * A DIRECTORY RENAME reaches this function too, once per tab that was under
 * the directory and with that tab's OWN old path: a tab on `dir/file.ts` needs
 * a token for the new path and only main can mint one, so the paths and the
 * tokens are resolved first by `workspace/renamed-folder-tabs.ts` and arrive
 * here as ordinary retargets. This function has one rule for both, which is why
 * it matches on a path rather than on what kind of entry was renamed.
 */
export function retargetFileTab(
  state: WorkspaceState,
  fromRelativePath: string,
  to: FileTabTarget,
): WorkspaceMutation {
  const target = state.tabs.find(
    (tab): tab is WorkspaceFileTab =>
      tab.kind === "file" && tab.relativePath === fromRelativePath,
  );
  if (target === undefined) return { ok: false, reason: "unknown_tab", state };
  if (
    target.title === to.title &&
    target.relativePath === to.relativePath &&
    target.nodeId === to.nodeId
  ) {
    return { ok: true, state };
  }
  // The PREVIEW flag and the dirty flag ride along untouched: renaming a file
  // is not a decision about whether the user meant to keep its tab.
  return {
    ok: true,
    state: replaceTab(state, {
      ...target,
      title: to.title,
      relativePath: to.relativePath,
      nodeId: to.nodeId,
    }),
  };
}

function replaceTab(state: WorkspaceState, tab: WorkspaceTab): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((candidate) =>
      candidate.tabId === tab.tabId ? tab : candidate,
    ),
  };
}

/**
 * Rescale the split axis so the shares sum to 1, PRESERVING THEIR PROPORTIONS.
 *
 * This is the whole of the stage-B2-round-2 pane-size contract change. The
 * round-1 version of this function assigned every pane `1 / count`, which made
 * the sizes a function of the pane COUNT alone: a restored workspace came back
 * with its panes equalized, and closing one pane resized the survivors the user
 * had deliberately sized. Scaling preserves what the user chose, and the
 * sum-to-1 invariant every consumer relies on still holds.
 *
 * A degenerate axis - no panes with a positive share, which a corrupt or
 * hand-written snapshot can produce - falls back to equal shares, because there
 * are no proportions to preserve and an all-zero axis renders as nothing.
 */
function normalizeToSumOne(panes: readonly WorkspacePane[]): WorkspacePane[] {
  if (panes.length === 0) return [];
  const total = panes.reduce(
    (sum, pane) => sum + (pane.relativeSize > 0 ? pane.relativeSize : 0),
    0,
  );
  if (total <= 0) {
    const share = 1 / panes.length;
    return panes.map((pane) => ({ ...pane, relativeSize: share }));
  }
  return panes.map((pane) => ({
    ...pane,
    relativeSize: (pane.relativeSize > 0 ? pane.relativeSize : 0) / total,
  }));
}

/**
 * What must be released when these tabs go away.
 *
 * `closing` means the user closed the tab, so its ptys are KILLED. Everything
 * else that is merely being unmounted - a project switch, a window close -
 * DETACHES, so the shell survives and its output is replayed on return.
 */
export function collectCleanups(
  tabs: readonly WorkspaceTab[],
  intent: "closing" | "unmounting",
): WorkspaceCleanupPlan {
  const terminalIds = tabs
    .filter(isGroup)
    .flatMap((group) => group.panes.map((pane) => pane.terminalId));
  return intent === "closing"
    ? { detachTerminalIds: [], killTerminalIds: terminalIds }
    : { detachTerminalIds: terminalIds, killTerminalIds: [] };
}

/* ------------------------------------------------------------------ *
 * Persistence mapping
 * ------------------------------------------------------------------ */

/**
 * Project the workspace onto the persisted layout shape.
 *
 * FILE TABS ARE NOT PERSISTED HERE. The terminal snapshot is the pty host's
 * file and its schema describes terminals; a file tab's durable home is the
 * editor's own state, and smuggling it into a terminal snapshot would make
 * "restore my terminals" and "reopen my files" share one corruption blast
 * radius for no benefit.
 *
 * THE PREVIEW FLAG THEREFORE HAS NO DURABLE HOME EITHER, and its migration is
 * the field's absence rather than a version hop: `WorkspaceFileTab.preview` is
 * optional and absent reads as PINNED, so every workspace rebuilt from an older
 * shape - a restore through {@link fromSnapshot}, which carries no file tabs at
 * all, and any future file-tab persistence written before this field existed -
 * comes back with nothing in the throwaway slot. That is the correct reading:
 * a tab someone kept across a restart is a tab they kept. When file tabs do get
 * a persisted home, its writer stores `preview` and its reader keeps treating
 * the missing field as pinned; nothing here has to change.
 */
export function toPersistedLayout(state: WorkspaceState): TerminalWorkspaceLayout {
  const groups = state.tabs.filter(isGroup);
  const activeGroupIndex = Math.max(
    0,
    groups.findIndex((group) => group.tabId === state.activeTabId),
  );
  return {
    projectId: state.projectId,
    groups: groups.map((group) => ({
      groupId: group.tabId,
      orientation: group.orientation,
      panes: group.panes.map((pane) => ({
        terminalId: pane.terminalId,
        relativeSize: pane.relativeSize,
      })),
      activePaneIndex: Math.max(
        0,
        group.panes.findIndex((pane) => pane.paneId === group.activePaneId),
      ),
    })),
    activeGroupIndex,
  };
}

/**
 * Rebuild a workspace from a REVIVED snapshot.
 *
 * The input names LIVE terminals. Main revived the persisted ptys under fresh
 * ids and handed back the layout rewritten onto them, so nothing here maps
 * anything: a pane's `terminalId` is a terminal a running host will answer for,
 * which is exactly what the previous version could not say. It rebuilt the
 * layout from the persisted ids and the panes then attached to a host that had
 * never heard of them.
 *
 * Titles come from the per-terminal entries, so a restored tab is labelled with
 * what was running in it rather than with a generic name. A terminal named in
 * the layout but missing from `terminals` is DROPPED: the two halves
 * disagreeing means the layout references something that did not come back, and
 * rendering an empty pane for it would look like data loss with no explanation.
 */
export function fromSnapshot(snapshot: TerminalWorkspaceRestore): WorkspaceState {
  const titles = new Map(
    snapshot.terminals.map((entry) => [entry.terminalId, entry.title || entry.shellName]),
  );
  // THE REATTACH SEED for the header's directory. Main asked the host for it at
  // the moment it built this answer, so it is where the shell actually is - not
  // where it was spawned. A row whose value is `null` (the host could not
  // describe that terminal) seeds nothing and the header says the directory is
  // not known yet, until the terminal's first property event arrives.
  const directories = new Map(
    snapshot.terminals.map((entry) => [entry.terminalId, entry.displayCwd]),
  );
  const tabs: WorkspaceTab[] = [];
  for (const group of snapshot.layout.groups) {
    const panes = group.panes
      .filter((pane) => titles.has(pane.terminalId))
      .map((pane, index) => ({
        paneId: `${group.groupId}:${String(index)}`,
        terminalId: pane.terminalId,
        relativeSize: pane.relativeSize,
        displayCwd: directories.get(pane.terminalId) ?? null,
      }));
    if (panes.length === 0) continue;
    const activeIndex = Math.min(group.activePaneIndex, panes.length - 1);
    tabs.push({
      kind: "terminalGroup",
      tabId: group.groupId,
      title: titles.get(panes[0]?.terminalId ?? "") ?? "terminal",
      orientation: group.orientation,
      // The PERSISTED shares survive the restore. Normalization here only
      // re-establishes the sum-to-1 invariant, which a dropped pane (a terminal
      // named in the layout whose buffer was not saved) can otherwise break.
      panes: normalizeToSumOne(panes),
      activePaneId: panes[Math.max(0, activeIndex)]?.paneId ?? panes[0]?.paneId ?? "",
    });
  }
  const activeTabId =
    tabs[Math.min(snapshot.layout.activeGroupIndex, Math.max(0, tabs.length - 1))]?.tabId
    ?? null;
  // The layout is the only place the project is named now. The schema pins it
  // to the snapshot's own projectId on the way in, so there is exactly one
  // answer and it cannot disagree with itself.
  return repairSelection({ projectId: snapshot.layout.projectId, tabs, activeTabId });
}

/**
 * A file tab to bring back, with everything the strip needs to place it.
 *
 * Two halves that come from different places, which is the whole reason this
 * shape exists: `title`, `relativePath` and `nodeId` are MAIN'S - the entry the
 * per-segment walk confirmed - while `pinned`, `position` and `active` are the
 * user's, read back from the persisted record. Nothing here is trusted for
 * where the tab GOES, only for where it would LIKE to go: every field is
 * clamped or given up below.
 */
export interface RestoredFileTab extends FileTabTarget {
  readonly tabId: string;
  /** `false` restores the strip's single throwaway preview slot. */
  readonly pinned: boolean;
  /** The saved index in the WHOLE strip. Clamped into the rebuilt one. */
  readonly position: number;
  /** Whether this tab was selected. Honoured only if nothing else claimed it. */
  readonly active: boolean;
}

/**
 * PUT THE PERSISTED FILE TABS BACK, among the terminals that already restored.
 *
 * Called once per mount with the tabs whose paths main RE-RESOLVED; the ones it
 * could not are already gone and are counted by the caller, never silently
 * absorbed here. That is `EditorGroupModel.deserialize`'s shape
 * (`editorGroupModel.ts:1218-1260`): an editor whose serializer cannot restore
 * it is dropped by `coalesce`, the indices around the hole are adjusted, and
 * the group survives with the editors that did come back.
 *
 * ## The rules, and why each is the model's rather than the controller's
 *
 *  - POSITION is a request, clamped to `[0, tabs.length]`. A saved index means
 *    a strip that no longer exists - terminals that did not revive leave holes,
 *    and a project can restore to no terminals at all - so an out-of-range
 *    index places the tab at the end rather than refusing it. Ties keep the
 *    persisted order because the list is applied in ascending `position`.
 *  - A PATH ALREADY OPEN is skipped. `addFileTab` treats the path as the tab's
 *    identity, and the caller cannot know what the terminal restore left in the
 *    strip.
 *  - AT MOST ONE PREVIEW survives, because that is this module's invariant
 *    everywhere else and a restore is not allowed to be the one path that
 *    breaks it. The first `pinned: false` keeps the slot; the rest are pinned.
 *  - THE BOUND is `STUDIO_FILE_TABS_MAX`, checked per tab, so a record written
 *    by a build with a larger bound cannot restore a strip this one refuses to
 *    let the user create.
 *  - ACTIVE WINS ONLY IF NOTHING CLAIMED IT. A restored terminal is what the
 *    user came back for and `fromSnapshot` has already selected one; the
 *    persisted flag decides only the case it is the sole answer to, which is a
 *    workspace whose terminals did not come back.
 *
 * The state is returned through `repairSelection`, like every other mutation,
 * so no caller can observe a selection naming a tab that is not there.
 */
export function restoreFileTabs(
  state: WorkspaceState,
  restored: readonly RestoredFileTab[],
): WorkspaceState {
  const open = new Set(
    state.tabs
      .filter((tab): tab is WorkspaceFileTab => tab.kind === "file")
      .map((tab) => tab.relativePath),
  );
  const tabs = [...state.tabs];
  let fileTabs = open.size;
  let previewTaken = false;
  let activeTabId: string | null = null;

  for (const entry of [...restored].sort((a, b) => a.position - b.position)) {
    if (fileTabs >= STUDIO_FILE_TABS_MAX) break;
    if (open.has(entry.relativePath)) continue;
    open.add(entry.relativePath);
    fileTabs += 1;
    const preview = !entry.pinned && !previewTaken;
    if (preview) previewTaken = true;
    const tab: WorkspaceFileTab = {
      kind: "file",
      tabId: entry.tabId,
      title: entry.title,
      relativePath: entry.relativePath,
      nodeId: entry.nodeId,
      dirty: false,
      preview,
    };
    tabs.splice(Math.min(Math.max(entry.position, 0), tabs.length), 0, tab);
    if (entry.active && activeTabId === null) activeTabId = tab.tabId;
  }

  return repairSelection({
    ...state,
    tabs,
    activeTabId: state.activeTabId ?? activeTabId,
  });
}

/**
 * Project the open file tabs onto the persisted record's shape.
 *
 * `position` is the index in the WHOLE strip, terminals included, because that
 * is what the user sees and what the restore has to reproduce: recording the
 * index among the file tabs alone would put every restored file after every
 * restored terminal, whatever the strip looked like.
 *
 * A PREVIEW TAB IS RECORDED AS PINNED. A tab that survives a restart is a tab
 * the user kept - the throwaway slot is a live browsing state, and there is
 * nothing throwaway about a file you come back to tomorrow - and the promotion
 * belongs at the write, which is the moment that knows the session ended. The
 * reader still honours whatever the record says, because localStorage is
 * user-writable and a payload may claim anything.
 */
export function toPersistedFileTabs(
  state: WorkspaceState,
): readonly PersistedFileTab[] {
  const persisted: PersistedFileTab[] = [];
  state.tabs.forEach((tab, index) => {
    if (tab.kind !== "file") return;
    persisted.push({
      relativePath: tab.relativePath,
      pinned: true,
      position: index,
      active: tab.tabId === state.activeTabId,
    });
  });
  return persisted;
}
