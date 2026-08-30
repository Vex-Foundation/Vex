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
  WORKSPACE_KEEP_ALIVE_MAX,
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
  TerminalWorkspaceSnapshot,
} from "@shared/schemas/terminal.js";

export function emptyWorkspace(projectId: string): WorkspaceState {
  return { projectId, tabs: [], activeTabId: null };
}

function isGroup(tab: WorkspaceTab): tab is WorkspaceTerminalGroup {
  return tab.kind === "terminalGroup";
}

export function terminalGroupCount(state: WorkspaceState): number {
  return state.tabs.filter(isGroup).length;
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
  if (terminalGroupCount(state) >= WORKSPACE_KEEP_ALIVE_MAX) {
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

export function addFileTab(
  state: WorkspaceState,
  tab: WorkspaceFileTab,
): WorkspaceMutation {
  // A file already open is SELECTED rather than opened twice: two tabs on one
  // path would give the same buffer two dirty flags.
  const existing = state.tabs.find(
    (candidate) => candidate.kind === "file" && candidate.relativePath === tab.relativePath,
  );
  if (existing !== undefined) {
    return { ok: true, state: { ...state, activeTabId: existing.tabId } };
  }
  return {
    ok: true,
    state: repairSelection({
      ...state,
      tabs: [...state.tabs, tab],
      activeTabId: tab.tabId,
    }),
  };
}

export function selectTab(state: WorkspaceState, tabId: string): WorkspaceMutation {
  if (!state.tabs.some((tab) => tab.tabId === tabId)) {
    return { ok: false, reason: "unknown_tab", state };
  }
  return { ok: true, state: { ...state, activeTabId: tabId } };
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
 * Rebuild a workspace from a host snapshot.
 *
 * Titles come from the snapshot's per-terminal entries, so a restored tab is
 * labelled with what was running in it rather than with a generic name. A
 * terminal named in the layout but missing from `terminals` is DROPPED: the
 * snapshot's two halves disagreeing means the layout references a buffer that
 * was not saved, and rendering an empty pane for it would look like data loss
 * with no explanation.
 */
export function fromSnapshot(snapshot: TerminalWorkspaceSnapshot): WorkspaceState {
  const titles = new Map(
    snapshot.terminals.map((entry) => [entry.terminalId, entry.title || entry.shellName]),
  );
  const tabs: WorkspaceTab[] = [];
  for (const group of snapshot.layout.groups) {
    const panes = group.panes
      .filter((pane) => titles.has(pane.terminalId))
      .map((pane, index) => ({
        paneId: `${group.groupId}:${String(index)}`,
        terminalId: pane.terminalId,
        relativeSize: pane.relativeSize,
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
  return repairSelection({ projectId: snapshot.projectId, tabs, activeTabId });
}
