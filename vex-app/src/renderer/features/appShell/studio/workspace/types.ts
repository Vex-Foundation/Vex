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
 * At most `WORKSPACE_TERMINAL_GROUPS_MAX` terminal groups stay live per project.
 * (The number of PROJECT workspaces the Studio centre keeps mounted is a
 * different bound with a different owner: `workspace/keep-alive.ts`.)
 * Reaching it refuses the new group and names the bound; it never closes a
 * user's running shell to make room, which is the same doctrine main applies to
 * the terminal count itself. The two bounds are different (this one is about
 * rendered, attached terminals; main's is about live ptys), and a UI that
 * silently evicted at either would destroy work the user did not ask to lose.
 */

/**
 * Live, attached terminal groups per project. Refused, never evicted.
 *
 * Renamed from `WORKSPACE_KEEP_ALIVE_MAX` in B4a: the plan's "keep-alive" bound
 * is the number of kept-alive PROJECT WORKSPACES, and two different quantities
 * cannot share one name. See `workspace/keep-alive.ts` for that one.
 */
export const WORKSPACE_TERMINAL_GROUPS_MAX = 4;

/**
 * FILE TABS one project workspace may hold open. Refused, never evicted.
 *
 * The third bound in this family, and the one with the largest number because
 * a file tab is the cheapest of the three: it holds no pty and no xterm
 * instance, only a `FileViewerSession`. Sixteen is where the strip itself
 * stops being readable, not where the memory stops being affordable - the
 * memory half is bounded separately and independently by
 * `VIEWER_WARM_TABS_MAX` in `viewer/file-viewer-registry.ts`, where beyond
 * four HIDDEN tabs the least recently shown release their text and tokens and
 * re-read when the user returns to them. Sixteen open tabs therefore cost at
 * most five files' worth of held content, not sixteen.
 *
 * AT THE BOUND the open is REFUSED with `file_tab_limit` and
 * `StudioWorkspaceController` renders that refusal by name. Refused rather
 * than evicting the oldest tab, for the same reason as the two bounds beside
 * it: closing a tab is the user's decision, and a strip that silently dropped
 * the file someone was about to return to would spend their attention to save
 * our memory. Re-opening a file that is ALREADY open is unaffected -
 * `addFileTab` selects the existing tab and opens nothing - so the bound is
 * never reached by returning to a file.
 */
export const STUDIO_FILE_TABS_MAX = 16;

/** One terminal inside a group. */
export interface WorkspacePane {
  readonly paneId: string;
  readonly terminalId: string;
  /** Share of the group's split axis, 0..1. Relative so a restore fits any size. */
  readonly relativeSize: number;
  /**
   * WHERE THIS SHELL IS, as the panel header says it. `null` means not known
   * yet, which `terminalLocationLabel` renders by name.
   *
   * THE ONE OWNER of that fact in the renderer, and it lives on the PANE
   * because the fact is per terminal: a group of four split shells is four
   * directories, and a field on the tab could only hold one of them. Seeded at
   * restore from `TerminalWorkspaceRestore` (main asked the host for it) and
   * when a terminal is created, then superseded by every `displayCwd` property
   * event through `setPaneDisplayCwd`. VS Code's `TerminalInstance` holds the
   * same single `_cwd` per instance, seeded from `attachPersistentProcess.cwd`
   * on reconnect and overwritten by `ProcessPropertyType.Cwd`.
   *
   * It is NOT persisted: `toPersistedLayout` writes topology, and a directory
   * saved from a previous session would be restored onto a shell that has since
   * been spawned somewhere else.
   */
  readonly displayCwd: string | null;
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
  /**
   * The main-minted node token this tab reads its file through.
   *
   * PROCESS-LOCAL and NEVER PERSISTED. The token binds a project, a path and
   * the project's node EPOCH under main's own key, so it stops verifying when
   * the project is deleted and it means nothing to a future run. That is why
   * both fields exist: `relativePath` is the DISPLAY and DEDUPE identity, and a
   * file deleted and recreated is the same tab to the user while being a
   * different token to main.
   *
   * File tabs are already excluded from the persisted layout (see
   * `toPersistedLayout`), so there is no path by which this value reaches disk.
   */
  readonly nodeId: string;
  readonly dirty: boolean;
  /**
   * PREVIEW, VS Code's model: this tab is the workspace's single throwaway
   * slot, and the next preview open REPLACES it in place.
   *
   * `true` means preview. ABSENT MEANS PINNED, and the absence is the
   * migration: every file tab that existed before this field - one restored
   * from an older layout, one built by a caller that has not chosen a mode -
   * reads as pinned, which is the state those tabs actually had. Expand-only,
   * like every uiStore hop: a reader gains a field, nothing is rewritten.
   *
   * Read it through {@link isPreviewFileTab} rather than by testing the field,
   * so "absent is pinned" is decided in one place.
   *
   * NEVER SET BY A CALLER. `addFileTab` assigns it from the open's
   * {@link FileOpenMode}, the same way `addPane` owns a pane's share rather
   * than trusting the one it was handed: a caller that could write this field
   * could put two previews in one workspace, which is the one invariant the
   * whole preview model rests on.
   */
  readonly preview?: boolean;
}

/**
 * HOW a file is opened.
 *
 * `"pinned"` is the DEFAULT everywhere - a caller that does not choose gets the
 * behaviour Studio had before previews existed, so adding the mode changed no
 * existing gesture. `"preview"` is the explorer's single click: it opens a tab
 * that the next single click replaces, so browsing a tree does not leave a
 * strip full of files nobody asked to keep.
 */
export type FileOpenMode = "preview" | "pinned";

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
/**
 * Why a mutation was refused. CLOSED, and named as its own type so the
 * controller's copy table can be exhaustive over it: a new reason added here
 * without a sentence beside it is a type error rather than a reason code
 * printed at the user.
 */
export type WorkspaceRefusalReason =
  /** The project already holds `WORKSPACE_TERMINAL_GROUPS_MAX` terminal groups. */
  | "keep_alive_limit"
  /** The project already holds `STUDIO_FILE_TABS_MAX` file tabs. */
  | "file_tab_limit"
  | "unknown_tab"
  | "unknown_pane"
  | "last_pane";

export type WorkspaceMutation =
  | { readonly ok: true; readonly state: WorkspaceState }
  | {
      readonly ok: false;
      readonly reason: WorkspaceRefusalReason;
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
