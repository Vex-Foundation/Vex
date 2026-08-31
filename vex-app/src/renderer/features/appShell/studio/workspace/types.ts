/**
 * THE STUDIO WORKSPACE CONTRACT (stage B2 round 1).
 *
 * Round 2 builds the React surface - the tab strip, the splits, `XtermHost`.
 * This file and `workspace-model.ts` are what it builds AGAINST: the vocabulary
 * and a pure, synchronous state machine with no React, no DOM and no bridge.
 *
 * Separating them is not ceremony. The rules that are genuinely hard here -
 * what becomes active after a delete, how a stale selection is repaired, what
 * happens when a keep-alive bound is reached - are pure functions of a data
 * structure, and testing them through a rendered component would mean mounting
 * xterm to assert an index. So the decisions live in a model with table tests,
 * and round 2's components stay thin enough to be reviewed by reading them.
 *
 * ## One ORDERED tab list, terminals and files together
 *
 * A workspace tab is either a terminal GROUP (which may hold several panes) or
 * a FILE. They share one ordered list because the user perceives one tab strip:
 * two lists would immediately need a third structure to describe their
 * interleaving, and that structure would be the source of truth this one
 * already is.
 *
 * ## Keep-alive REFUSES, it does not evict
 *
 * At most `WORKSPACE_KEEP_ALIVE_MAX` terminal groups stay live per project.
 * Reaching it refuses the new group and names the bound; it never closes a
 * user's running shell to make room, which is the same doctrine main applies to
 * the terminal count itself. The two bounds are different (this one is about
 * rendered, attached terminals; main's is about live ptys), and a UI that
 * silently evicted at either would destroy work the user did not ask to lose.
 */

/** Live, attached terminal groups per project. Refused, never evicted. */
export const WORKSPACE_KEEP_ALIVE_MAX = 4;

/** One terminal inside a group. */
export interface WorkspacePane {
  readonly paneId: string;
  readonly terminalId: string;
  /** Share of the group's split axis, 0..1. Relative so a restore fits any size. */
  readonly relativeSize: number;
}

/** A terminal tab: an ordered set of panes split along one axis. */
export interface WorkspaceTerminalGroup {
  readonly kind: "terminalGroup";
  readonly tabId: string;
  readonly title: string;
  readonly orientation: "horizontal" | "vertical";
  readonly panes: readonly WorkspacePane[];
  readonly activePaneId: string;
}

/** A file tab. Round 2 owns the editor; the workspace owns its place in the strip. */
export interface WorkspaceFileTab {
  readonly kind: "file";
  readonly tabId: string;
  readonly title: string;
  /** Project-root-relative. The renderer never holds an absolute path. */
  readonly relativePath: string;
  readonly dirty: boolean;
}

export type WorkspaceTab = WorkspaceTerminalGroup | WorkspaceFileTab;

export interface WorkspaceState {
  readonly projectId: string;
  /** THE ordered tab strip. Terminals and files in one list, as the user sees it. */
  readonly tabs: readonly WorkspaceTab[];
  /** `null` only when `tabs` is empty. Every mutation repairs this. */
  readonly activeTabId: string | null;
}

/**
 * What a mutation did.
 *
 * A refusal is a first-class outcome rather than a thrown error or a silently
 * unchanged state: the UI has to say WHY nothing happened, and "the state came
 * back identical" is not something a component can distinguish from a no-op.
 */
export type WorkspaceMutation =
  | { readonly ok: true; readonly state: WorkspaceState }
  | {
      readonly ok: false;
      readonly reason: "keep_alive_limit" | "unknown_tab" | "unknown_pane" | "last_pane";
      readonly state: WorkspaceState;
    };

/**
 * Cleanup a tab owns, registered by round 2's components.
 *
 * The model records WHAT must be released when a tab closes; it never performs
 * the release, because detaching a terminal is an effect and this module is
 * pure. `collectClosedTabCleanups` returns the ids whose owners must run their
 * cleanup, and the caller runs them.
 */
export interface WorkspaceCleanupPlan {
  /** Terminal ids whose consumer should detach (the pty keeps running). */
  readonly detachTerminalIds: readonly string[];
  /** Terminal ids whose pty should be killed (the user closed the tab). */
  readonly killTerminalIds: readonly string[];
}
