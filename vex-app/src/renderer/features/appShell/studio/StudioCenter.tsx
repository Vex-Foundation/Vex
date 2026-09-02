/**
 * THE STUDIO CENTRE - column 2 while `runtimeMode === "studio"`.
 *
 * It shows the welcome screen when nothing is selected and, otherwise, ONE
 * `StudioWorkspaceController` per kept-alive project, with the inactive ones
 * CSS-hidden rather than unmounted. That is the `BookPanel` precedent applied to
 * a much more expensive subtree: unmounting a workspace would unmount its
 * `XtermHost`es, detach every terminal, drop the restored layout and throw away
 * the screen the user is reading. Hidden costs a DOM subtree; unmounted costs
 * their work.
 *
 * ## What this component owns, and what it does not
 *
 * It owns EFFECTS and the store: the keep-alive set, the explorer session
 * references, the close prompt, the terminal disposal on an explicit close. It
 * owns no RULES - every transition of the set is a call into
 * `workspace/keep-alive.ts`, which is pure and table-tested, exactly as
 * `StudioWorkspaceController` stands to `workspace/workspace-model.ts`.
 *
 * ## The active project is uiStore state; the SET is component state
 *
 * `activeProjectId` lives in the uiStore because the sidebar writes it and the
 * shell frame reads it for its welcome-stage solve. The kept-alive set lives
 * here because nothing outside this column can act on it, and putting it in the
 * store would invite a second writer for a bound only this component enforces.
 * The two are reconciled in one effect, and the effect is the only place the
 * refusal can happen.
 *
 * ## Explorer references
 *
 * Every kept-alive project holds ONE explorer reference for as long as it is in
 * the set (`StudioProjectWorkspace` below), so a hidden project keeps its
 * expanded tree. The ACTIVE project holds a SECOND one, moved by
 * `explorerRegistry.switchTo(next, previous)` - the registry's own method,
 * because the order it enforces (activate the new watcher BEFORE releasing the
 * old) is a rule with a stated reason and must not be hand-rolled here. The
 * arithmetic is: membership +1 on entering the set, switchTo +1 on becoming
 * active and -1 on ceasing to be, membership -1 on leaving. A project in the set
 * therefore never reaches zero, and one that leaves does.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { cn } from "../../../lib/utils.js";
import {
  ErrorBoundary,
  type ErrorBoundaryAction,
} from "../../../components/ui/error-boundary.js";
import { useProjects } from "../../../lib/api/projects.js";
import { useUiStore } from "../../../stores/uiStore.js";
import {
  explorerRegistry as windowExplorerRegistry,
  type ExplorerRegistry,
} from "./explorer/index.js";
import {
  StudioWorkspaceController,
  terminalRegistry as windowTerminalRegistry,
  type TerminalRegistry,
} from "./terminal/index.js";
import { StudioWelcome } from "./welcome/StudioWelcome.js";
import { StudioBridgeReadinessPanel } from "./welcome/StudioBridgeReadinessPanel.js";
import { StudioKeepAliveDialog } from "./StudioKeepAliveDialog.js";
import { useStudioKeybindings } from "./useStudioKeybindings.js";
import { openProjectCreator, StudioProjectDialogs } from "./projects/index.js";
import {
  peekProjectWorkspaceLifecycle,
  takeProjectTerminals,
} from "./workspace/project-terminals.js";
import {
  closeProject,
  emptyKeepAlive,
  repairAgainstProjects,
  removedProjectIds,
  selectProject,
  selectWelcome,
  type KeepAliveState,
} from "./workspace/keep-alive.js";

export interface StudioCenterProps {
  /**
   * Open the project creator.
   *
   * Defaults to the intent publisher, which is what the dialogs mounted below
   * consume. The prop stays a seam for tests; production has no second answer.
   */
  readonly onCreateProject?: () => void;
  /** Test seams; production uses the window's registries. */
  readonly explorerRegistry?: ExplorerRegistry;
  readonly terminalRegistry?: TerminalRegistry;
}

export function StudioCenter({
  onCreateProject = openProjectCreator,
  explorerRegistry,
  terminalRegistry,
}: StudioCenterProps): JSX.Element {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const query = useProjects();

  const explorers = explorerRegistry ?? windowExplorerRegistry;
  const terminals = terminalRegistry ?? windowTerminalRegistry;

  // THE STUDIO KEYBOARD TABLE, mounted exactly once. This component is the only
  // one that exists for the whole of Studio and for none of agent mode, which
  // is the lifetime the shortcuts have. The hook owns the listener and every
  // dispatch; see `useStudioKeybindings.ts`.
  useStudioKeybindings();

  const [keepAlive, setKeepAlive] = useState<KeepAliveState>(emptyKeepAlive);
  /** The project a refusal parked for the close prompt. */
  const [refusedProjectId, setRefusedProjectId] = useState<string | null>(null);

  /**
   * The live selection, for the async close continuation.
   *
   * A close resolves after an await, and the callback's captured
   * `activeProjectId` is whatever it was when the callback was made. The
   * selection repair below acts on the selection AS IT IS WHEN THE CLOSE
   * FINISHES, so it reads the ref.
   */
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  const projects: readonly ProjectDto[] = useMemo(
    () => (query.data !== undefined && query.data.ok ? query.data.data : []),
    [query.data],
  );
  const projectById = useMemo(() => {
    const map = new Map<string, ProjectDto>();
    for (const project of projects) map.set(project.id, project);
    return map;
  }, [projects]);

  /**
   * Dispose one project's terminals. The ONLY caller is an explicit close.
   *
   * The controller's own unmount deliberately disposes nothing (its teardown
   * comment says why: each `XtermHost` owns its attachment and detaching twice
   * gives one handle two owners). That is right for a mode switch, where the
   * workspace comes back. It is wrong for a close, after which no component
   * will ever name these xterm instances again, so they would be retained -
   * buffers, theme observers and WebGL contexts - for the life of the window.
   *
   * The PTYS are not this function's business either. An explicit close kills
   * them, but only after the buffer-bearing snapshot has been committed, and
   * that ordering belongs to the controller that holds the layout - see
   * `handleCloseWorkspace` and the controller's `closeWorkspace`. This one runs
   * for every departure from the set, including a deleted project's, where the
   * lifecycle gate is already killing the shells.
   */
  const disposeProjectTerminals = useCallback(
    (projectId: string): void => {
      for (const terminalId of takeProjectTerminals(projectId)) {
        terminals.dispose(terminalId);
      }
    },
    [terminals],
  );

  /**
   * Apply a keep-alive transition, disposing whatever left the set.
   *
   * The transition is computed against a REF rather than inside a setState
   * updater, because the disposal is an effect and React may invoke an updater
   * twice (StrictMode) - which would dispose a project's terminals twice for one
   * close. The ref is written alongside every set, so a second call in the same
   * tick still sees the current set.
   */
  const keepAliveRef = useRef(keepAlive);
  keepAliveRef.current = keepAlive;
  const applyKeepAlive = useCallback(
    (next: (current: KeepAliveState) => KeepAliveState): void => {
      const current = keepAliveRef.current;
      const updated = next(current);
      if (updated === current) return;
      keepAliveRef.current = updated;
      for (const removed of removedProjectIds(current, updated)) {
        disposeProjectTerminals(removed);
      }
      setKeepAlive(updated);
    },
    [disposeProjectTerminals],
  );

  /**
   * Reconcile the uiStore's selection into the kept-alive set.
   *
   * This is where the bound is enforced, because this is the one place a new
   * project can enter the set. A refusal parks the request for the prompt and
   * RETURNS THE SELECTION to where it was, so the shell is never left pointing
   * at a workspace that does not exist.
   */
  useEffect(() => {
    if (activeProjectId === null) {
      applyKeepAlive(selectWelcome);
      return;
    }
    if (keepAlive.activeProjectId === activeProjectId) return;
    const outcome = selectProject(keepAlive, activeProjectId);
    if (outcome.ok) {
      applyKeepAlive(() => outcome.state);
      return;
    }
    setRefusedProjectId(outcome.requestedProjectId);
    setActiveProjectId(keepAlive.activeProjectId);
  }, [activeProjectId, applyKeepAlive, keepAlive, setActiveProjectId]);

  /**
   * STALE-SELECTION REPAIR against a SETTLED list.
   *
   * `query.isSuccess` plus an `ok` envelope: reconciling against a loading or
   * failed read would close every workspace the moment a refetch blipped, which
   * is the silent eviction the bound exists to prevent.
   */
  const listSettled = query.isSuccess && query.data.ok;
  const existingIds = useMemo(() => projects.map((p) => p.id), [projects]);
  useEffect(() => {
    if (!listSettled) return;
    applyKeepAlive((current) => repairAgainstProjects(current, existingIds));
    if (activeProjectId !== null && !existingIds.includes(activeProjectId)) {
      setActiveProjectId(null);
    }
  }, [
    activeProjectId,
    applyKeepAlive,
    existingIds,
    listSettled,
    setActiveProjectId,
  ]);

  /**
   * THE ACTIVE EXPLORER REFERENCE, moved by the registry's own `switchTo`.
   *
   * The guard is what makes it StrictMode-safe: the second setup pass sees the
   * same value in the ref and does nothing, so the double-invoked effect cannot
   * take a second reference that no cleanup gives back.
   */
  const activeExplorerRef = useRef<string | null>(null);
  const shownProjectId = keepAlive.activeProjectId;
  useEffect(() => {
    const previous = activeExplorerRef.current;
    if (previous === shownProjectId) return;
    activeExplorerRef.current = shownProjectId;
    if (shownProjectId === null) {
      if (previous !== null) {
        void explorers.deactivate(previous);
        explorers.release(previous);
      }
      return;
    }
    void explorers.switchTo(shownProjectId, previous);
  }, [explorers, shownProjectId]);

  // Window/mode teardown: give back the active reference the effect above took.
  // The MEMBERSHIP references are given back by each workspace's own unmount.
  useEffect(() => {
    return () => {
      const held = activeExplorerRef.current;
      activeExplorerRef.current = null;
      if (held !== null) explorers.release(held);
    };
  }, [explorers]);

  /**
   * A project workspace LEAVES the kept-alive set, selection included.
   *
   * The second half is not a nicety, it is what makes a close a close. The set
   * transition alone drops the workspace and falls the CENTRE back to welcome,
   * but `uiStore.activeProjectId` still names the project - and the
   * reconciliation effect above exists precisely to mount a workspace for the
   * selection, so on its very next run it re-added the project the user had
   * just closed. Closing the active workspace was a no-op with an extra
   * remount. Giving up the selection at the same moment is what makes the two
   * owners agree.
   *
   * A project that was not active keeps whatever selection there is: closing a
   * hidden workspace must not move the user off the one they are looking at.
   */
  const leaveKeepAlive = useCallback(
    (projectId: string): void => {
      applyKeepAlive((current) => closeProject(current, projectId));
      if (activeProjectIdRef.current === projectId) setActiveProjectId(null);
    },
    [applyKeepAlive, setActiveProjectId],
  );

  /**
   * THE EXPLICIT CLOSE, and it is ordered.
   *
   * Closing a kept-alive workspace follows VS Code's CLOSE semantics rather
   * than its reload: the project's shells are ENDED, and reopening the project
   * revives fresh ones with the restored screens through the snapshot machinery
   * that already exists. Nothing here builds a second revive; the reopen is the
   * ordinary mount, which reads the workspace main answers from the snapshot
   * once no terminal of the project is live.
   *
   * The AWAIT is the contract. `close` commits the snapshot with every pty
   * still running and only then kills them, so the set transition - which
   * unmounts the controller and disposes its xterms - must not happen until it
   * has finished. Removing the workspace first would tear down the only owner
   * of the layout mid-commit.
   *
   * A close for a project with no mounted workspace (nothing published) still
   * leaves the set: the transition is the centre's own decision and does not
   * depend on a controller being there to answer.
   */
  const handleCloseWorkspace = useCallback(
    (projectId: string): void => {
      setRefusedProjectId(null);
      const lifecycle = peekProjectWorkspaceLifecycle(projectId);
      if (lifecycle === null) {
        leaveKeepAlive(projectId);
        return;
      }
      void (async () => {
        const outcome = await lifecycle.close();
        // A FAILED CLOSE KEEPS THE WORKSPACE. The snapshot was not committed
        // or the shells were not ended, so the workspace stays mounted and
        // fully usable. Removing it from the set would unmount the only owner
        // of a layout that may still be only in memory, which is exactly the
        // loss the outcome check exists to prevent.
        //
        // IT ALSO HAS TO BE SEEN. The controller renders the failure as an
        // alert inside its own subtree, and every workspace but the active one
        // is CSS-hidden here - so a failed close of a hidden workspace put an
        // error, and its retry, somewhere nobody was looking, while the prompt
        // that started the gesture had already closed. Making the failed
        // workspace active is what puts the alert in front of the person who
        // asked for the close. It cannot be refused: `selectProject` always
        // admits a project already in the set.
        //
        // The alternative was to hold the keep-alive prompt open with per-row
        // pending and error state, which preserves the user's original intent
        // (they were opening a fifth project). Rejected: it gives one close
        // outcome a second observer with its own copy of the failure, in a
        // modal that would then be showing the same error the workspace's own
        // alert shows, and it leaves the retry in a dialog rather than beside
        // the shells it is about. The intent is cheap to repeat; the error is
        // not cheap to miss.
        if (!outcome.ok) {
          if (activeProjectIdRef.current !== projectId) {
            setActiveProjectId(projectId);
          }
          return;
        }
        leaveKeepAlive(projectId);
      })();
    },
    [leaveKeepAlive, setActiveProjectId],
  );

  /**
   * A project was deleted: close its workspace NOW and give up the selection.
   *
   * The stale-selection effect above would reach the same state on the next
   * settled list, and it stays as the general repair (a project deleted in
   * another window still has to be handled). This is the immediate half, and it
   * exists because the two are not the same moment: without it the workspace of
   * a project the user just deleted stays mounted, and its terminals stay
   * attached, for as long as the refetch takes.
   *
   * The two cannot disagree: both go through `applyKeepAlive`, which disposes
   * whatever left the set, and `closeProject` on an id that has already left is
   * a no-op by identity.
   */
  const handleProjectDeleted = useCallback(
    (deletedProjectId: string): void => {
      // BEFORE THE UNMOUNT, and synchronously. The delete has already removed
      // this project's terminal snapshot in main; the controller's teardown
      // flush would write a persist for the deleted project and RECREATE that
      // file, which holds the user's terminal scrollback. Latching the
      // workspace first is what stops it at the source. Main refuses such a
      // persist as well - see `TerminalDomain.persistWorkspace` - because a
      // renderer latch is a courtesy and not authority.
      peekProjectWorkspaceLifecycle(deletedProjectId)?.discard();
      applyKeepAlive((current) => closeProject(current, deletedProjectId));
      setRefusedProjectId((current) =>
        current === deletedProjectId ? null : current,
      );
      if (activeProjectId === deletedProjectId) setActiveProjectId(null);
    },
    [activeProjectId, applyKeepAlive, setActiveProjectId],
  );

  const refusedProject =
    refusedProjectId === null ? null : (projectById.get(refusedProjectId) ?? null);
  const openProjects = keepAlive.projectIds
    .map((id) => projectById.get(id))
    .filter((project): project is ProjectDto => project !== undefined);

  return (
    <div
      data-vex-area="studio-center"
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col"
    >
      {keepAlive.activeProjectId === null ? (
        <StudioWelcome
          onCreateProject={onCreateProject}
          onSelectProject={setActiveProjectId}
        />
      ) : null}

      {/* THE BRIDGE DIAGNOSTIC, in the OPEN-PROJECT view.
        *
        * WHY IT IS ALSO HERE. `StudioWelcome` shows it above the create-project
        * button, which is right for the user who has not opened anything yet.
        * But a user who already has projects goes straight into a workspace and
        * never sees the welcome screen again - and a missing bridge means
        * Studio writes no coding-agent config files for the project they are
        * standing in. They were told once, at a moment they may not have been
        * present for, and never again.
        *
        * ONE MOUNT POINT, not two live at once: welcome renders only while
        * `activeProjectId` is null and this renders only while it is not, so
        * the panel exists exactly once in the tree at any time and there is one
        * `useStudioBridgeReadiness` subscription behind it. It renders nothing
        * while the first check is in flight and nothing when the bridge is
        * there, so a healthy installation pays no space for it.
        *
        * OUTSIDE the per-workspace error boundaries, deliberately. Those
        * contain one project's subtree so a bad snapshot cannot take the others
        * down; a diagnostic that says "Studio has no bridge" is about the
        * INSTALLATION, not about any project, and putting it inside one
        * workspace's boundary would make it disappear exactly when that
        * workspace fell over. It is `shrink-0` so the workspace column below it
        * keeps its own scrolling. */}
      {keepAlive.activeProjectId === null ? null : (
        <div className="shrink-0 px-6 py-3">
          <StudioBridgeReadinessPanel />
        </div>
      )}

      {keepAlive.projectIds.map((projectId) => (
        <StudioProjectWorkspace
          key={projectId}
          projectId={projectId}
          active={projectId === keepAlive.activeProjectId}
          explorers={explorers}
          terminals={terminalRegistry}
          onRetryClose={handleCloseWorkspace}
        />
      ))}

      {/* THE PROJECT DIALOGS, mounted here because this component exists exactly
        * as long as Studio is the active shell and because the sidebar - in
        * another grid column - must be able to raise them without either column
        * owning the other's state. They consume the intent channel; see
        * `projects/project-dialog-intent.ts`. */}
      <StudioProjectDialogs
        onProjectCreated={(project) => setActiveProjectId(project.id)}
        onProjectDeleted={handleProjectDeleted}
      />

      <StudioKeepAliveDialog
        requestedProject={refusedProject}
        openProjects={openProjects}
        onCancel={() => setRefusedProjectId(null)}
        onCloseWorkspace={handleCloseWorkspace}
      />
    </div>
  );
}

/**
 * One kept-alive project workspace: the controller plus the explorer reference
 * that keeps this project's tree alive while it is hidden.
 *
 * A component per project rather than a loop of effects, because a membership
 * reference is a per-project lifetime and React gives a per-key component
 * exactly that. The registry's deferred teardown absorbs the StrictMode
 * setup/cleanup/setup pass; see `explorer-registry.ts`.
 */
function StudioProjectWorkspace({
  projectId,
  active,
  explorers,
  terminals,
  onRetryClose,
}: {
  readonly projectId: string;
  readonly active: boolean;
  readonly explorers: ExplorerRegistry;
  readonly terminals?: TerminalRegistry;
  /**
   * The controller's failure notice asks for the close again THROUGH THE
   * CENTRE, so a retry that succeeds also leaves the kept-alive set. The
   * controller cannot do that half itself; the set is this component's.
   */
  readonly onRetryClose: (projectId: string) => void;
}): JSX.Element {
  useEffect(() => {
    explorers.acquire(projectId);
    return () => {
      explorers.release(projectId);
    };
  }, [explorers, projectId]);

  const retryClose = useCallback((): void => {
    onRetryClose(projectId);
  }, [onRetryClose, projectId]);

  return (
    // `hidden`, never unmounted, for as long as this project is kept alive.
    // `min-h-0` on the shown branch so the controller's own flex column can
    // scroll rather than push the frame.
    //
    // THE WORKSPACE SWITCH IS AN UN-HIDE, not a mount, so the entrance is a
    // CSS animation rather than anything React drives: a keyframe restarts
    // when its element leaves `display: none`, which means `vex-surface-enter`
    // plays on every switch TO this project and stays inert across the renders
    // in between. Nothing here may animate a size - the controller below owns
    // terminal geometry and reads it on resize - so the primitive is opacity
    // plus three pixels of rise and nothing else. For the 150ms it runs, the
    // transform makes this element the containing block of any `position:
    // fixed` descendant; the app's fixed chrome (dialogs on the native top
    // layer, the notification stack) is mounted outside this subtree, so
    // nothing inside a workspace depends on that.
    <div
      hidden={!active}
      data-vex-studio-workspace={projectId}
      className={cn("min-h-0 flex-1", active ? "vex-surface-enter" : "hidden")}
    >
      {/* PER-WORKSPACE CONTAINMENT.
        *
        * A workspace is the most expensive and most stateful subtree in the
        * app, and it is also the one that reads persisted layout on mount -
        * which is exactly the class of input that throws. Without a boundary
        * HERE, one project's bad snapshot took down the root and with it every
        * OTHER project's workspace; with it, the failure is a card inside that
        * one project's column while the rest of Studio keeps running.
        *
        * What survives a fallback and a retry is the point: the terminal
        * instances live in `terminalRegistry` and the ptys live in the pty
        * host, both OUTSIDE React. Unmounting the controller disposes neither
        * (only an explicit close does), so retrying re-renders a controller
        * that reattaches to the same live shells. */}
      <ErrorBoundary
        surface="studio.workspace"
        resetKey={projectId}
        title="This project's workspace stopped rendering"
        actions={RETURN_TO_WELCOME}
      >
        <StudioWorkspaceController
          projectId={projectId}
          registry={terminals}
          onRetryClose={retryClose}
        />
      </ErrorBoundary>
    </div>
  );
}

/**
 * The workspace boundary's SECOND way out, and it is deliberately not a reload.
 *
 * A reload replays the persisted layout that may be exactly what made the
 * workspace throw, so the boundary's own "Try again" (re-render the same
 * subtree) is paired with a route to a screen that is known good instead.
 * Returning to welcome only moves the SELECTION: the project stays in the
 * kept-alive set, its terminals stay in the registry and its shells keep
 * running, which is the whole reason this centre hides workspaces rather than
 * unmounting them.
 *
 * Module-level, so the array identity is stable across renders.
 */
const RETURN_TO_WELCOME: readonly ErrorBoundaryAction[] = [
  {
    label: "Return to Studio welcome",
    onSelect: () => {
      useUiStore.getState().setActiveProjectId(null);
    },
  },
];
