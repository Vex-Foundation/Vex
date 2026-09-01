/**
 * THE KEEP-ALIVE SET - which project workspaces stay mounted, as a pure model.
 *
 * The Studio centre keeps a bounded number of project workspaces MOUNTED and
 * CSS-hidden rather than unmounting the inactive ones, because unmounting a
 * workspace throws away a running shell's screen and an explorer's expanded
 * tree. The rules for that set - what selecting an already-open project does,
 * what happens at the bound, what happens when a project vanishes from the list
 * under a live selection - are decisions, not effects, so they live here with a
 * table test and the component that owns the effects calls in.
 *
 * ## The bound REFUSES, it never evicts
 *
 * Selecting a fifth project returns a refusal naming the bound. It does not
 * close one of the four to make room: a kept-alive workspace can hold a running
 * shell, and closing it would destroy work the user never asked to lose. The UI
 * turns the refusal into an explicit close prompt. This is the same doctrine
 * `workspace-model.ts` applies to terminal groups inside ONE project, and the
 * same one main applies to the pty count itself.
 *
 * ## This bound is not the terminal-group bound
 *
 * `WORKSPACE_TERMINAL_GROUPS_MAX` (workspace/types.ts) bounds the live terminal
 * GROUPS inside one project. {@link STUDIO_WORKSPACE_KEEP_ALIVE_MAX} bounds the
 * PROJECT WORKSPACES the centre keeps mounted. They are both 4 and they are
 * different quantities; the names say which.
 *
 * ## Order is insertion order, and it is the dialog's order
 *
 * The set is an ordered list because the close prompt lists it: a set that
 * reshuffled itself would move the row under the user's pointer between two
 * renders of the same dialog. Nothing here re-sorts.
 */

/** Project workspaces the centre keeps mounted. Refused, never evicted. */
export const STUDIO_WORKSPACE_KEEP_ALIVE_MAX = 4;

export interface KeepAliveState {
  /** Mounted project ids, insertion-ordered. At most the bound, no duplicates. */
  readonly projectIds: readonly string[];
  /** The visible workspace. `null` means the Studio welcome screen. */
  readonly activeProjectId: string | null;
}

/**
 * What a selection did.
 *
 * A refusal is a first-class outcome rather than an unchanged state, for the
 * reason `WorkspaceMutation` states: the UI has to say WHY nothing happened,
 * and an identical state is not something a component can tell apart from a
 * no-op.
 */
export type KeepAliveOutcome =
  | { readonly ok: true; readonly state: KeepAliveState }
  | {
      readonly ok: false;
      readonly reason: "keep_alive_limit";
      /** The project that could not be opened. */
      readonly requestedProjectId: string;
      /** The mounted workspaces, so the prompt can list them. */
      readonly openProjectIds: readonly string[];
      readonly state: KeepAliveState;
    };

export function emptyKeepAlive(): KeepAliveState {
  return { projectIds: [], activeProjectId: null };
}

/**
 * Show the Studio welcome screen.
 *
 * The kept-alive set is UNTOUCHED: welcome is a view, not a close. A user who
 * clicks WELCOME and then returns to their project finds the terminal where
 * they left it, which is the whole point of keeping the workspace mounted.
 */
export function selectWelcome(state: KeepAliveState): KeepAliveState {
  if (state.activeProjectId === null) return state;
  return { ...state, activeProjectId: null };
}

/**
 * Select a project, mounting its workspace if it is not mounted already.
 *
 * Selecting a mounted project only moves the active pointer - it does not
 * reorder the set, so the close prompt's rows do not move under the user.
 */
export function selectProject(
  state: KeepAliveState,
  projectId: string,
): KeepAliveOutcome {
  if (state.projectIds.includes(projectId)) {
    return {
      ok: true,
      state:
        state.activeProjectId === projectId
          ? state
          : { ...state, activeProjectId: projectId },
    };
  }
  if (state.projectIds.length >= STUDIO_WORKSPACE_KEEP_ALIVE_MAX) {
    return {
      ok: false,
      reason: "keep_alive_limit",
      requestedProjectId: projectId,
      openProjectIds: state.projectIds,
      state,
    };
  }
  return {
    ok: true,
    state: {
      projectIds: [...state.projectIds, projectId],
      activeProjectId: projectId,
    },
  };
}

/**
 * Close one mounted workspace - the user's explicit choice, and the only way a
 * project ever leaves the set while it still exists.
 *
 * Closing the ACTIVE workspace falls back to the Studio welcome screen rather
 * than to a neighbouring project: picking a neighbour would open a workspace
 * the user did not ask for, and the welcome screen is the honest empty state.
 */
export function closeProject(
  state: KeepAliveState,
  projectId: string,
): KeepAliveState {
  if (!state.projectIds.includes(projectId)) return state;
  return {
    projectIds: state.projectIds.filter((id) => id !== projectId),
    activeProjectId:
      state.activeProjectId === projectId ? null : state.activeProjectId,
  };
}

/**
 * STALE-SELECTION REPAIR: reconcile the set against the projects that exist.
 *
 * A project can vanish while its workspace is mounted (deleted from another
 * window, or its row simply gone on the next list refetch). Every id the list
 * no longer carries leaves the set, and an active id among them falls back to
 * the welcome screen. Order among the survivors is preserved.
 *
 * Called only with a SETTLED list. Reconciling against a loading or failed read
 * would close every workspace the moment a query blipped, which is exactly the
 * silent eviction the bound exists to prevent.
 */
export function repairAgainstProjects(
  state: KeepAliveState,
  existingProjectIds: readonly string[],
): KeepAliveState {
  const existing = new Set(existingProjectIds);
  const projectIds = state.projectIds.filter((id) => existing.has(id));
  const activeStillExists =
    state.activeProjectId !== null && existing.has(state.activeProjectId);
  if (
    projectIds.length === state.projectIds.length &&
    (state.activeProjectId === null || activeStillExists)
  ) {
    return state;
  }
  return {
    projectIds,
    activeProjectId: activeStillExists ? state.activeProjectId : null,
  };
}

/** Project ids that were mounted before and are not mounted now. */
export function removedProjectIds(
  before: KeepAliveState,
  after: KeepAliveState,
): readonly string[] {
  const kept = new Set(after.projectIds);
  return before.projectIds.filter((id) => !kept.has(id));
}
