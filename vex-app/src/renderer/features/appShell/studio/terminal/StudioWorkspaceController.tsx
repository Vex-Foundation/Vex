/**
 * StudioWorkspaceController - the React owner of one project's workspace.
 *
 * The division of labour here is the whole design, so it is worth stating
 * plainly. This component owns EFFECTS: the bridge calls, the debounce timer,
 * the restore on mount, the cleanup on unmount. It owns no RULES. Every
 * transition - what becomes active after a close, whether a new group is allowed,
 * how a split redistributes shares, how a stale selection is repaired - is a
 * call into `workspace/workspace-model.ts`, which is pure and table-tested.
 *
 * When a mutation is refused, the refusal is rendered BY NAME. `keep_alive_limit`
 * in particular is a refusal, never an eviction: Vex does not close a running
 * shell to make room for a new one, and a UI that silently did would destroy work
 * the user never asked to lose. Same doctrine as the host's own per-project and
 * global terminal bounds, applied one layer up.
 *
 * ## Restore, and why persistence is latched behind it
 *
 * On mount the controller reads the project's snapshot and rebuilds the state
 * through `fromSnapshot`, which preserves the persisted pane SHARES. Persistence
 * is debounced and does not start until that read has settled: an empty
 * workspace persisted in the frame before the restore landed would overwrite the
 * snapshot it was about to restore from.
 *
 * The reattach itself needs no code here. Each `XtermHost` attaches its own
 * terminal on mount and the host answers with a resync plus a replay, so a
 * reload restores the layout (this component) and the buffers (the hosts)
 * through two independent paths that cannot half-succeed into a broken screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { FileNode } from "@shared/schemas/files.js";
import type {
  TerminalErrorCode,
  TerminalShellId,
  TerminalShellOption,
} from "@shared/schemas/terminal.js";
import { cn } from "../../../../lib/utils.js";
import { reportRendererFailure } from "../../../../lib/renderer-error-report.js";
import { notify } from "../../../../lib/notifications/index.js";
import type { NotificationHandle } from "../../../../lib/notifications/types.js";
import { listProjectChildren } from "../../../../lib/api/files.js";
import {
  createTerminal,
  killTerminal,
  onTerminalsLost,
  persistTerminalWorkspace,
  readShellCatalogue,
  readTerminalWorkspace,
} from "../../../../lib/api/terminal.js";
import {
  activeTerminalIdOf,
  addFileTab,
  addPane,
  addTerminalGroup,
  canAddTerminalGroup,
  closePane,
  closeTab,
  collectCleanups,
  emptyWorkspace,
  fromSnapshot,
  isPreviewFileTab,
  pinTab,
  resizePanes,
  selectTab,
  setActivePane,
  setGroupOrientation,
  setPaneDisplayCwd,
  retargetFileTab,
  restoreFileTabs,
  setTabTitle,
  type FileTabTarget,
  type RestoredFileTab,
  tabIdAtOffset,
  toPersistedFileTabs,
  toPersistedLayout,
} from "../workspace/workspace-model.js";
import { createPathTokenWalk } from "../workspace/resolve-path-token.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  nextTerminalTitle,
  renumberTerminalTabs,
  shellLabelsOf,
  type TerminalExit,
  type TerminalRunFacts,
} from "./terminal-tab-model.js";
import { useFileOpenIntentStore } from "../workspace/file-open-intent.js";
import {
  focusActiveTerminal,
  focusWorkspaceStrip,
  studioFocusPermission,
} from "../workspace/workspace-focus.js";
import { useFileRenameSignalStore } from "../workspace/file-rename-signal.js";
import {
  fileTabsUnderFolder,
  resolveRenamedFolderTabs,
} from "../workspace/renamed-folder-tabs.js";
import {
  publishProjectTerminals,
  publishProjectWorkspaceCommands,
  publishProjectWorkspaceLifecycle,
} from "../workspace/workspace-handles.js";
import {
  admitsPersist,
  admitsTerminalCreate,
  beginClose,
  closeCommitted,
  closeFailed,
  closeInFlight,
  closeIsFailed,
  discardWorkspace,
  killProvedGone,
  openWorkspaceClose,
  type WorkspaceCloseFailureReport,
  type WorkspaceCloseOutcome,
  type WorkspaceCloseState,
  type WorkspaceCloseWork,
} from "../workspace/close-lifecycle.js";
import type {
  FileOpenMode,
  WorkspaceMutation,
  WorkspaceState,
} from "../workspace/types.js";
import { TerminalTabs, type WatermarkRow } from "./TerminalTabs.js";
import { FileViewer } from "../viewer/index.js";
import { terminalRegistry, type TerminalRegistry } from "./terminal-registry.js";
import {
  CLOSE_FAILURE_COPY,
  CLOSING_CREATE_COPY,
  fileTabsNotRestoredCopy,
  KEEP_ALIVE_COPY,
  MUTATION_REFUSAL_COPY,
  REFUSAL_COPY,
  RESTORE_FAILED_COPY,
  shellProcessName,
} from "./terminal-copy.js";

/**
 * How long a burst of layout changes coalesces before it is written.
 *
 * A splitter drag emits a mutation per pointer move; writing each one would put
 * a file write on the pointer path. Long enough to swallow a drag, short enough
 * that a crash loses at most this much layout - and the visibility handler below
 * flushes anyway, which is the case that actually matters.
 */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * The geometry a terminal is CREATED with, before anything has been measured.
 *
 * 80x24 is the universal terminal default, and it is correct here for a reason
 * beyond convention: the pane's real size is unknown until it has layout, and
 * `XtermHost` refits and re-sends the true size on its first frame. Guessing a
 * larger size would make the shell paint one frame at a geometry that never
 * existed.
 */
const CREATE_COLS = 80;
const CREATE_ROWS = 24;

export interface StudioWorkspaceControllerProps {
  readonly projectId: string;
  readonly registry?: TerminalRegistry;
  readonly className?: string;
  /**
   * Ask this workspace's HOST to run the close again, after one failed.
   *
   * The retry cannot simply call `closeWorkspace` here, and the difference is
   * the whole reason this prop exists: a close that succeeds must also remove
   * the project from the kept-alive set, and that transition belongs to
   * `StudioCenter` alone. A retry answered inside this component would commit
   * the snapshot, end the shells and then leave a `closed` workspace mounted
   * and shown - a surface that can no longer persist, open a terminal or be
   * closed again.
   *
   * Absent only where no such host exists (a controller mounted on its own),
   * where the local close is the honest fallback: there is no set to leave.
   */
  readonly onRetryClose?: () => void;
  /**
   * What the EMPTY workspace advertises: the shortcuts a user can reach from
   * here, spelled for this platform.
   *
   * Threaded from the caller rather than computed here, because the honest
   * answer depends on which intents the mounted keyboard table can actually
   * dispatch, and that is `StudioCenter`'s fact - it is the component that
   * mounts the hook. Omitted, the strip shows the surface's own keyless
   * default, which is the right answer for a controller mounted on its own
   * (a test) where no keyboard table exists.
   */
  readonly watermarkRows?: readonly WatermarkRow[];
  /**
   * Whether this workspace is the one the user is LOOKING AT.
   *
   * `StudioCenter` keeps every project in the kept-alive set mounted and hides
   * the inactive ones with `hidden`, so "mounted" and "shown" are different
   * facts and only the centre holds the second one. It is threaded in for
   * exactly one purpose - the open-time focus below, which must not fire for a
   * workspace nobody can see - and it is the CENTRE's decision, not this
   * component's, for the same reason `watermarkRows` is.
   *
   * Defaults to `true`: a controller mounted on its own (a test, a future
   * single-workspace host) is by definition the one on screen.
   */
  readonly active?: boolean;
}

export function StudioWorkspaceController({
  projectId,
  registry,
  className,
  onRetryClose,
  watermarkRows,
  active = true,
}: StudioWorkspaceControllerProps): JSX.Element {
  const [state, setState] = useState<WorkspaceState>(() => emptyWorkspace(projectId));
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * WHAT THE RESTORE COULD NOT BRING BACK, held apart from `notice`.
   *
   * `notice` is the TRANSIENT slot: a refusal, a failed close, a status line,
   * and every successful open clears it because a refusal that has been
   * answered must not linger. A restore outcome is a different kind of fact -
   * it is the answer to "is this the workspace I left" - and it was measurably
   * erased by the auto-open that fires a moment later, so the user who lost a
   * file tab was told and then untold within one frame.
   *
   * It renders in THE SAME ROW, above the transient sentence. One row, two
   * owners, neither able to overwrite the other; a second badge would be a
   * second place to look for the same class of news.
   */
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  /**
   * Terminals that died with an unexpectedly terminated pty host.
   *
   * Their panes are marked dead rather than removed: the snapshot on disk still
   * holds their scrollback, so the honest offer is a revive, and silently
   * emptying the workspace would take a recoverable state away from the user
   * before they were told it existed.
   */
  const [lostTerminalIds, setLostTerminalIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [restoring, setRestoring] = useState(false);
  /**
   * WHAT EACH TERMINAL'S TAB SHOWS FOR STATE, and what is running in it.
   *
   * Two small renderer-owned maps rather than fields on the workspace model,
   * because neither is workspace state: an exit is a fact about a pty the model
   * deliberately does not act on (an exited pane keeps its scrollback and its
   * place in the strip), and the shell's own title is display copy the host
   * streams. The model stays the owner of the strip; these say how a row draws.
   *
   * Both are BOUNDED by what is on screen: the effect below drops every entry
   * whose terminal has left the workspace, so a long session of opening and
   * closing terminals cannot grow them.
   */
  const [exits, setExits] = useState<ReadonlyMap<string, TerminalExit>>(() => new Map());
  const [shellLabelById, setShellLabelById] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  /**
   * WHICH SHELL the next terminal opens with, and the rows the picker shows.
   *
   * SESSION STATE, held here because this is the component that calls
   * `createTerminal` and therefore the one place the choice is acted on. It is
   * deliberately not persisted: there is no UI-preference store in this
   * feature to persist it into, and inventing one for a single field would put
   * a new durable format under a component. Main's `defaultShellId` is the
   * starting value, so the default has exactly one owner and it is not here.
   *
   * The catalogue starts EMPTY rather than with a guessed row: an empty picker
   * for the width of one IPC round trip is honest, and a guess would show a
   * shell that may not be installed.
   */
  const [shells, setShells] = useState<readonly TerminalShellOption[]>([]);
  const [shellId, setShellId] = useState<TerminalShellId>("system_default");
  /**
   * THE TERMINAL A GESTURE ASKED TO LAND IN, or `null`.
   *
   * Distinct from the open-time landing below it, and the difference is the
   * permission. The open landing may only take focus that NOBODY holds
   * (`studioFocusPermission`), because it fires on a restore the user did not
   * ask for at that instant. This one is the answer to an explicit request -
   * the `+` button, the new-terminal chord - so it moves the caret even when
   * the caret is somewhere else in this workspace, which is what "open me a
   * shell" means and what VS Code's own create does.
   *
   * A REF AND NOT STATE: nothing renders from it, and a state write here would
   * commit a render whose only purpose was to run an effect.
   */
  const landingTerminalRef = useRef<string | null>(null);

  // The registry a closed tab's terminals are DISPOSED through. The prop exists
  // so a test can supply its own; the shared one is the window's.
  const activeRegistry = registry ?? terminalRegistry;

  // The latest state, for handlers that must run at teardown - where the state
  // captured by a closure is whatever it was when the effect was created.
  const stateRef = useRef(state);
  stateRef.current = state;
  const hydratedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * THE FILE TABS' OWN HYDRATION LATCH, and it is a second one on purpose.
   *
   * `hydratedRef` closes when the TERMINAL snapshot has settled; the file tabs
   * are restored after that, through a per-segment walk that is several IPC
   * round trips long. Writing the file-tab record while that walk is in flight
   * would persist an empty strip over the very record it is restoring from -
   * the same defect the terminal latch exists to prevent, one home along.
   */
  const fileTabsHydratedRef = useRef(false);
  const fileTabsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * THE CLOSE PHASE. One owner, and this is it.
   *
   * `workspace/close-lifecycle.ts` holds the rules; this ref holds the current
   * value and `closePhase` renders it. The ref is what every effect reads,
   * because the phase changes across awaits and inside teardowns where a
   * closure's captured value is whatever it was when the closure was made.
   *
   * It replaced a `closedRef` boolean, which could not tell "this workspace was
   * saved and its shells ended" from "the commit was REFUSED and everything is
   * still running" - and, unable to tell them apart, killed the shells either
   * way.
   */
  const closeStateRef = useRef<WorkspaceCloseState>(openWorkspaceClose());
  const [closePhase, setClosePhase] = useState<WorkspaceCloseState>(
    closeStateRef.current,
  );
  const publishCloseState = useCallback((next: WorkspaceCloseState): void => {
    closeStateRef.current = next;
    setClosePhase(next);
  }, []);

  /**
   * The close that is RUNNING, or `null`.
   *
   * The mechanism behind the model's `join` admission: a second close gesture
   * awaits this exact promise instead of starting a second commit. Held in a
   * ref rather than in state because a caller arriving in the same tick must
   * see it, and a render has not happened yet.
   */
  const closeRunRef = useRef<Promise<WorkspaceCloseOutcome> | null>(null);


  /**
   * THE WORKSPACE GENERATION. Bumped whenever the workspace this controller is
   * showing is replaced - a project switch, a remount, a StrictMode
   * double-effect.
   *
   * Every async open and every restore captures it and rechecks it at
   * publication. Without it a create issued for project A could land after the
   * user moved to project B and insert A's terminal into B's layout, and a slow
   * restore could overwrite terminals opened after it started.
   */
  const generationRef = useRef(0);

  /**
   * The project this controller is CURRENTLY showing.
   *
   * Read by the stale-restore compensation, which needs to distinguish two very
   * different reasons a restore can be stale. See the restore effect.
   */
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  /**
   * Opens that have been admitted but whose pty does not exist yet.
   *
   * A SET OF PROMISES rather than a counter, and it does two jobs.
   *
   * The keep-alive bound is decided against the world INCLUDING them: four
   * groups plus two in-flight opens is six, and the model must refuse the
   * second of those two rather than admit both against a count of four. `size`
   * is what the counter used to answer.
   *
   * The close JOINS them. A create issued before `closing` began resolves after
   * it, and until it has resolved the close cannot know whether a pty exists.
   * Awaiting the whole set is what makes the late-create fence total: every
   * such create has either published into the layout the close is about to
   * commit, or - having found the workspace closing at its own publication
   * fence - killed the pty it alone holds. Neither outcome can leave an orphan
   * behind the close.
   */
  const pendingOpensRef = useRef<Set<PendingOpen>>(new Set());

  /**
   * How many opens are in flight FOR THE WORKSPACE ON SCREEN.
   *
   * The generation is what makes the question answerable at all across a
   * project switch. The set spans generations by design - the close must join
   * every create that could still produce a pty, including one issued for the
   * project the user just left - but the two questions asked of it in the
   * moment are about THIS workspace: may another group be added to it, and has
   * the user already asked for its first terminal. A create belonging to the
   * previous project answers neither. Counting it refused a legitimate fifth
   * group in the new project and, once the auto-open existed, silently
   * cancelled the new project's first terminal.
   */
  const countPendingOpens = (generation: number): number => {
    let pending = 0;
    for (const open of pendingOpensRef.current) {
      if (open.generation === generation) pending += 1;
    }
    return pending;
  };

  /**
   * Ptys that landed DURING a close, with no pane to belong to.
   *
   * A create issued before the close resolves after it, into a workspace that
   * is no longer accepting terminals. The pty exists; nothing references it;
   * nobody else has ever seen its id. Rather than have that call kill it
   * blindly, it is handed HERE and the close adds it to the same kill sweep it
   * runs for the layout - so it gets an outcome-checked kill and a shell that
   * could not be ended fails the close instead of vanishing from the report.
   *
   * The close is what drains this: it joins the creates first, so every id that
   * can arrive has arrived before the sweep is built.
   */
  const strandedTerminalsRef = useRef<Set<string>>(new Set());

  /**
   * THE FIRST-TERMINAL LATCH. At most ONE auto-open per opened project.
   *
   * Opening a project auto-creates its first terminal (owner decision,
   * 2026-09-01), and the whole difficulty of that sentence is the word "one".
   * The restore effect runs twice under StrictMode and again on every remount,
   * so "the workspace is empty, open a terminal" evaluated without a latch
   * spawns a shell per pass - and each extra shell is a real pty holding a slot
   * against the host's per-project bound.
   *
   * VS Code's `TerminalViewPane._initializeTerminal` is the same decision under
   * the same pressure, and it carries the same two flags: `_isInitialized`
   * (this ref) so the bootstrap happens once per view, and
   * `_isTerminalBeingCreated` so a create already in flight is not raced by a
   * second entry. Our in-flight half is `pendingOpensRef`, which already exists
   * and already counts exactly the opens whose pty does not yet exist - so the
   * question "is one being created right now" is asked of the same set the
   * keep-alive bound is asked of, rather than of a second flag that could
   * disagree with it.
   *
   * Re-armed by the restore effect, so a project switch bootstraps the project
   * the user moved to.
   */
  const autoOpenedRef = useRef(false);

  /**
   * The bootstrap itself, held in a ref because the RESTORE decides when it
   * runs and the restore effect is declared above the action it calls.
   *
   * A direct dependency would work today - `openTerminal` is stable per project
   * - but it would put the entire restore, the revive and the stale-kill
   * compensation behind the stability of an unrelated callback: one dependency
   * added to `openTerminal` later and every mount would re-read and re-revive.
   * The indirection buys the restore effect a dependency list of exactly
   * `[projectId]`, which is what it means.
   */
  const bootstrapFirstTerminalRef = useRef<() => void>(() => undefined);

  /**
   * Apply a model mutation. The ONE place a refusal becomes visible, so no
   * caller can drop one on the floor by forgetting to check `ok`.
   */
  const apply = useCallback((mutate: (current: WorkspaceState) => WorkspaceMutation): void => {
    // Applied against the REF, not through a functional updater: the updater
    // would have to raise the refusal notice, and a state updater that fires a
    // side effect runs twice under StrictMode. Writing the ref forward also lets
    // two `apply` calls in one tick compose, which a split (orientation, then
    // pane) relies on.
    const result = mutate(stateRef.current);
    if (!result.ok) {
      setNotice(MUTATION_REFUSAL_COPY[result.reason]);
      return;
    }
    stateRef.current = result.state;
    setState(result.state);
  }, []);

  /**
   * Write this project's FILE TABS now, cancelling any pending debounce.
   *
   * A separate write from the terminal layout's because it has a separate home
   * (`uiStore.studioFileTabs`) and a separate latch, and the same shape as it
   * for exactly the reasons the terminal one has: a timer that is cleared here
   * so a flush and its debounce cannot both fire, and a latch so nothing is
   * written before the restore that would be overwritten has landed.
   *
   * `admitsPersist` is NOT consulted, and the difference is the point: the
   * terminal layout is refused during a close because the close commits its own
   * snapshot and a late write would race it. The file-tab record has no such
   * commit - a closing workspace's last file strip is exactly what should come
   * back when the project is opened again.
   */
  const flushFileTabs = useCallback((): void => {
    if (fileTabsTimerRef.current !== null) {
      clearTimeout(fileTabsTimerRef.current);
      fileTabsTimerRef.current = null;
    }
    if (!fileTabsHydratedRef.current) return;
    useUiStore
      .getState()
      .setProjectFileTabs(projectId, toPersistedFileTabs(stateRef.current));
  }, [projectId]);

  const flushPersist = useCallback((): void => {
    // The file tabs go with it: every caller of this function is a "the
    // renderer may not get another moment" caller (the visibility change, the
    // unmount), and both homes need the same last write.
    flushFileTabs();
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!hydratedRef.current) return;
    if (!admitsPersist(closeStateRef.current)) return;
    void persistTerminalWorkspace(toPersistedLayout(stateRef.current));
  }, [flushFileTabs]);

  /* ---------------- restore ---------------- */

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    hydratedRef.current = false;
    fileTabsHydratedRef.current = false;
    // Re-armed with the hydration latch: this is a different project's
    // workspace, or the same one being opened again, and either way it has not
    // been bootstrapped yet.
    autoOpenedRef.current = false;
    // The ref is written alongside every setState so a teardown or a mutation
    // that lands before the next render still sees the current workspace.
    stateRef.current = emptyWorkspace(projectId);
    setState(stateRef.current);

    const opened = projectId;
    setLostTerminalIds(new Set());
    // A restore outcome describes ONE mount. The next one answers for itself.
    setRestoreNotice(null);

    /**
     * BRING THE PERSISTED FILE TABS BACK, re-resolving every path first.
     *
     * The record is user-writable localStorage, so a path in it is a CLAIM and
     * nothing more. Each one is walked segment by segment from the project root
     * through `files.listChildren` - main's own listing, under main's own
     * validation - and only the entry main describes, token included, becomes a
     * tab. An injected path can therefore name only a file main confirms inside
     * this project, and a path that names anything else resolves to nothing.
     *
     * A path that does not resolve is DROPPED AND COUNTED, and the count is
     * said out loud through the strip's existing notice row. That is
     * `EditorGroupModel.deserialize` (`editorGroupModel.ts:1218-1260`): what
     * cannot be restored is coalesced away and the group survives - with the
     * one difference that a user who left five files open and gets four back is
     * told so, rather than being left to notice.
     *
     * Fenced on the generation like every other publication in this effect, and
     * again at each await inside the walk, so a project switch mid-walk
     * publishes nothing.
     */
    const bringBackFileTabs = async (): Promise<void> => {
      const record = useUiStore.getState().studioFileTabs[opened];
      if (record === undefined || record.tabs.length === 0) {
        fileTabsHydratedRef.current = true;
        return;
      }
      const isStale = (): boolean =>
        generation !== generationRef.current || opened !== projectIdRef.current;
      const walk = createPathTokenWalk({
        projectId: opened,
        list: listProjectChildren,
        isStale,
      });
      const resolved: RestoredFileTab[] = [];
      let dropped = 0;
      for (const entry of record.tabs) {
        const node = await walk.resolve(null, entry.relativePath.split("/"));
        if (isStale()) return;
        // A DIRECTORY at that path is not a file tab either. The path resolved,
        // so it is not "gone"; it is not what it was, which the user's count
        // says just as honestly as a deletion does.
        if (node === null || node.kind !== "file") {
          dropped += 1;
          continue;
        }
        resolved.push({
          tabId: newId("file"),
          title: node.name,
          relativePath: node.path,
          nodeId: node.nodeId,
          pinned: entry.pinned,
          position: entry.position,
          active: entry.active,
        });
      }
      if (isStale()) return;
      if (resolved.length > 0) {
        stateRef.current = restoreFileTabs(stateRef.current, resolved);
        setState(stateRef.current);
      }
      // The latch closes BEFORE the notice, so the write path is armed for
      // whatever the user does next even if nothing came back.
      fileTabsHydratedRef.current = true;
      if (dropped > 0) setRestoreNotice(fileTabsNotRestoredCopy(dropped));
    };

    void (async () => {
      const result = await readTerminalWorkspace(opened);
      // A restore that landed after the workspace was replaced describes one
      // nobody is looking at any more. Applying it would show the previous
      // project's terminals under the new project's name - and, because the
      // open REVIVES rather than only reads, would also overwrite whatever the
      // user has opened since with a layout built before any of it existed.
      //
      // ## Discarding it is not enough, and the two stale cases differ
      //
      // The claim that used to stand here - that the discarded terminals were
      // "reachable through the project's next open" - was false: the next open
      // revived ANOTHER set from the same snapshot, so every discard leaked a
      // full workspace of running shells no pane referenced.
      //
      // Main now owns that: an open is single-flight and idempotent per window
      // and project, so a StrictMode double restore JOINS one revive and both
      // continuations name the SAME live terminals. That is precisely why this
      // compensation must ask WHICH KIND of stale it is:
      //
      //  - SAME PROJECT (a remount, StrictMode, a double effect): the newer
      //    mount holds these exact ids. Killing them here would kill the live
      //    workspace the user is looking at.
      //  - DIFFERENT PROJECT (the user switched while this was in flight):
      //    nothing in this window will ever reference them. They are ours to
      //    end, and leaving them is what "an invisible running shell" means.
      if (generation !== generationRef.current) {
        // THE THIRD KIND OF STALE, beside the two named above: this workspace
        // is CLOSING, CLOSED or DISCARDED. Like a project switch and unlike a
        // remount, nothing in this window will ever reference these ids - the
        // close captured its kill set before this revive existed - so they are
        // ours to end, and leaving them is what "an invisible running shell"
        // means.
        if (
          (opened !== projectIdRef.current
            || !admitsTerminalCreate(closeStateRef.current))
          && result.ok
          && result.data.ok
          && result.data.value !== null
        ) {
          for (const entry of result.data.value.terminals) {
            void killTerminal(entry.terminalId);
          }
        }
        return;
      }
      // A READ THAT FAILED IS NOT AN EMPTY PROJECT, and the two must not be
      // rendered the same way. Vex does not know what this project holds: the
      // snapshot may be perfectly good and unreachable. So the failure is said
      // out loud - it was silent before, an empty strip indistinguishable from
      // a fresh project - and, critically, NO TERMINAL IS OPENED. A shell
      // spawned here would be persisted a moment later, as the only group in a
      // layout that overwrote the one the read could not deliver.
      //
      // The hydration latch still closes, exactly as before: an unchanged empty
      // state arms no persist by itself, and a terminal the user opens
      // deliberately from here is theirs to keep.
      if (!result.ok || !result.data.ok) {
        hydratedRef.current = true;
        setNotice(RESTORE_FAILED_COPY);
        // THE FILE TABS STILL COME BACK. Their home is not the terminal
        // snapshot - that is the whole reason they have one - so a terminal
        // read Vex could not perform says nothing about the files the user left
        // open, and returning here would make one failure cost both.
        await bringBackFileTabs();
        return;
      }
      if (result.data.value !== null) {
        // RENUMBERED on adoption: the snapshot names each group after the shell
        // that was in it, which is exactly the naming this surface replaced.
        stateRef.current = renumberTerminalTabs(fromSnapshot(result.data.value));
        setState(stateRef.current);
        setShellLabelById(shellLabelsOf(result.data.value));
      }
      hydratedRef.current = true;
      // THE FILE TABS, AFTER the terminals and BEFORE the auto-open.
      //
      // After, because their positions are indices into a strip the terminal
      // restore has to have built first. Before, because the auto-open's whole
      // question is "did this project come back with nothing", and a workspace
      // that came back with three files is not empty - opening a shell into it
      // would be a terminal nobody asked for on every relaunch.
      await bringBackFileTabs();
      // THE AUTO-OPEN, and it is deliberately asked of the RESULTING STATE
      // rather than of `value === null`. A snapshot can restore to nothing -
      // `fromSnapshot` drops every group whose terminals have no saved buffer,
      // and a project whose last tab was closed persists an empty layout - and
      // a workspace that came back with no tabs is one the user is looking at
      // an empty strip in, whichever of those produced it.
      bootstrapFirstTerminalRef.current();
    })().catch((error: unknown) => {
      // THE RESTORE'S ONLY EXIT FOR A REJECTION, and it had none.
      //
      // Everything above assumes `readTerminalWorkspace` resolves a Result and
      // that `fromSnapshot` returns. A rejection or a throw from either left
      // this IIFE as an unhandled rejection: the workspace stayed empty, the
      // hydration latch stayed closed (so persistence never armed), and the
      // only trace was a console line nobody collects. It reports through the
      // same renderer evidence path as a boundary catch.
      //
      // It deliberately changes NOTHING else: the latch stays closed, because
      // arming persistence over a restore that failed is how an empty layout
      // overwrites a good snapshot - and, for the same reason, the first
      // terminal is NOT auto-opened here. `bootstrapFirstTerminalRef` is
      // reached only from the resolved path above.
      reportRendererFailure({
        surface: "studio.workspace.restore",
        kind: "caught",
        error,
      });
      // The evidence report is for us; this sentence is for the user, who would
      // otherwise be looking at an empty workspace with no terminal in it and
      // nothing said about why. Generation-fenced like every other publication
      // in this effect: a controller that has moved on says nothing.
      if (generation === generationRef.current) setNotice(RESTORE_FAILED_COPY);
    });

    return () => {
      // Invalidate on the way out as well as on the way in, so an unmount -
      // including StrictMode's - cancels the restore rather than letting it
      // publish into a controller that is gone.
      generationRef.current += 1;
    };
  }, [projectId]);

  /* ---------------- persistence ---------------- */

  useEffect(() => {
    if (!hydratedRef.current) return undefined;
    if (!admitsPersist(closeStateRef.current)) return undefined;
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      // Re-checked at the timer, not only when it was armed: the phase moves
      // between the two, and the check that matters is the one at the write.
      if (!admitsPersist(closeStateRef.current)) return;
      void persistTerminalWorkspace(toPersistedLayout(stateRef.current));
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [state]);

  /**
   * THE FILE TABS' DEBOUNCED WRITE, on the terminal layout's own timer length.
   *
   * Keyed on the FILE PROJECTION of the strip rather than on `state`, because
   * that is what this record holds: a splitter drag, a pane exit, a shell title
   * and a terminal open all change `state` and none of them changes a file tab.
   * A dependency on `state` would rewrite the record - and re-stamp the LRU's
   * clock, moving other projects toward eviction - on every pointer move of a
   * split.
   *
   * The debounce is the same instrument for the same reason as the layout's:
   * clicking down a file tree emits a mutation per click, and coalescing them
   * costs at most this much of a strip if the window dies mid-burst. The
   * visibility flush and the unmount flush both call `flushFileTabs`, which is
   * the case that actually matters.
   */
  const fileTabsSignature = useMemo(
    () => JSON.stringify(toPersistedFileTabs(state)),
    [state],
  );
  useEffect(() => {
    if (!fileTabsHydratedRef.current) return undefined;
    if (fileTabsTimerRef.current !== null) clearTimeout(fileTabsTimerRef.current);
    fileTabsTimerRef.current = setTimeout(() => {
      fileTabsTimerRef.current = null;
      // Re-checked at the timer, not only when it was armed: a project switch
      // between the two would write THIS project's strip under the id the
      // callback captured, which is still correct, but a discarded workspace
      // must not resurrect the record its delete just removed.
      if (!fileTabsHydratedRef.current) return;
      useUiStore
        .getState()
        .setProjectFileTabs(projectId, toPersistedFileTabs(stateRef.current));
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (fileTabsTimerRef.current !== null) {
        clearTimeout(fileTabsTimerRef.current);
        fileTabsTimerRef.current = null;
      }
    };
  }, [fileTabsSignature, projectId]);

  useEffect(() => {
    const onVisibility = (): void => {
      // HIDDEN is the last moment the renderer is reliably alive: a window close
      // or a machine sleep may not give us another one, and the debounce window
      // is exactly the layout a user would lose.
      if (document.visibilityState === "hidden") flushPersist();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushPersist]);

  /**
   * Mirror this project's terminal ids into the project index.
   *
   * The Studio centre needs them at exactly one moment: the user closing this
   * kept-alive workspace, which happens WHILE this component is still mounted
   * and which the teardown below deliberately does not handle. See
   * `workspace/workspace-handles.ts` for why the index exists at all.
   */
  useEffect(() => {
    const terminalIds: string[] = [];
    for (const tab of state.tabs) {
      if (tab.kind !== "terminalGroup") continue;
      for (const pane of tab.panes) terminalIds.push(pane.terminalId);
    }
    publishProjectTerminals(projectId, terminalIds);
  }, [projectId, state]);

  /**
   * CLOSING this workspace: commit the buffers, THEN kill the shells - and
   * CHECK EVERY OUTCOME on the way.
   *
   * VS Code's own semantics, and the reason the order is the whole of this
   * function. Closing a window disposes its terminals rather than detaching
   * them (`terminalService.ts` detaches only on `ShutdownReason.RELOAD`), and
   * `persistentSessionReviveProcess` defaults to `onExit`: the BUFFERS come
   * back, the PROCESSES do not. Reopening the project therefore has to find a
   * snapshot carrying every screen, and there is exactly one moment at which
   * such a snapshot can be written - while the ptys are still running. VS Code
   * awaits its own persist inside `_onWillShutdown` and lets the shutdown
   * proceed on its result rather than in parallel with it; the same discipline
   * is what the outcome checks below implement.
   *
   * ## What it is asked to do comes from the model
   *
   * `work` is the model's answer, not this function's: a first attempt commits
   * and then kills, while a retry of an attempt that ALREADY committed finishes
   * the outstanding kills and persists nothing at all. Deciding that here as
   * well as in `beginClose` is how the two would drift, and the drift is a
   * data-loss one - see `close-lifecycle.ts` on why the failure is two phases.
   *
   * ## Why each step is where it is
   *
   *  1. SHUT ADMISSION, before any await. `closing` stops every background
   *     persist (the debounce, the visibility flush, the unmount flush) and
   *     refuses every new terminal. A snapshot written after this point would
   *     describe shells that are about to stop existing; the host reconciles a
   *     persisted layout against what is live, so such a write lands as an
   *     EMPTY snapshot over the one this function is about to save.
   *  2. CANCEL THE RESTORE, then JOIN THE IN-FLIGHT CREATES. Both are opens
   *     that can still put a pty into this project after the close has captured
   *     the layout it commits, and a pty that arrives then is in no snapshot
   *     and in no kill set.
   *
   *     The restore is CANCELLED rather than awaited, and the difference
   *     matters: a `readWorkspace` that never answers - a wedged host, a
   *     dropped reply - would make an awaited close hang forever with the
   *     user's gesture unanswered. Cancellation is free and total because the
   *     restore ALREADY has a generation fence for exactly this: bumping the
   *     generation makes it publish nothing, and its own stale compensation
   *     kills whatever ptys the revive produced (see the restore effect, which
   *     treats a workspace that no longer admits terminals the same way it
   *     treats a project switch). The layout on disk is untouched either way,
   *     because an unhydrated workspace never commits.
   *
   *     The creates are JOINED rather than cancelled, because a create that has
   *     already been issued may already own a pty, and the close cannot know
   *     whether one exists until that call has answered.
   *  3. SWEEP THE STRANDED PTYS, on EVERY path and BEFORE the commit is
   *     attempted. A create that landed during the close published nothing:
   *     no pane names its terminal, no snapshot can carry it, and this attempt
   *     is the only thing that knows it exists. Sweeping it after the commit
   *     block - which is where this used to live - leaked it on every failed
   *     commit, because a refused persist returns first and takes the only
   *     reference to that pty with it. Killing it before the commit costs the
   *     snapshot nothing: it was never in the layout being written.
   *
   *     A stranded kill that is not proven gone goes BACK into the set, so the
   *     next attempt sweeps it again rather than dropping it silently.
   *  4. PERSIST AND AWAIT IT, THEN CHECK IT. `persistTerminalWorkspace` does
   *     not resolve on delivery: main records the topology and the host's
   *     commit owner serializes every live mirror into the project's snapshot
   *     file before the reply comes back. A REFUSED or UNREACHABLE commit means
   *     the buffers are NOT on disk, and killing after one is the data loss
   *     this whole ordering exists to prevent - so the close stops, the phase
   *     becomes `failed_before_commit`, no shell of the layout is touched, and
   *     the workspace stays exactly as the user left it.
   *  5. KILL, through the model's own `closing` intent, so "a close kills"
   *     stays one decision in `workspace-model.ts` rather than two. Refusals
   *     are read, not discarded: `unknown_terminal` PROVES the shell is gone
   *     (`killProvedGone`) and settles it, `foreign_terminal` says the host
   *     holds it for another window and fails the close as `kill_not_owned`,
   *     and anything else leaves a possibly running shell. Whatever is left
   *     unended travels into the failed phase, so the retry knows which shells
   *     it still owes.
   *
   * ## Before the restore has landed, nothing is persisted
   *
   * An unhydrated workspace's state is EMPTY, and persisting it would overwrite
   * the very snapshot the mount was about to restore from - the same reason the
   * debounce is latched behind hydration. Step 2 settles the restore first, so
   * this is now only reached when the read genuinely produced nothing; the file
   * on disk stays the last good one and any terminals a revive had already
   * produced are found by the next open, which main answers from live state.
   */
  const runClose = useCallback(
    async (work: WorkspaceCloseWork): Promise<WorkspaceCloseOutcome> => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }

      // ---- stop everything that could still change the layout ----
      // Cancels the mount's restore and any create issued before this line;
      // both recheck the generation at publication and clean up what they own.
      generationRef.current += 1;
      // Snapshotted before the await: a create admitted after `closing` is
      // refused, so the set cannot grow past this point, and iterating the live
      // set while entries remove themselves is a mutation during traversal.
      // EVERY generation's opens, not only the current one: a create issued for
      // the project the user just left can still be holding a pty this close is
      // the last owner of.
      await Promise.all([...pendingOpensRef.current].map((open) => open.settled));

      // ---- the stranded sweep, on EVERY path ----
      const stranded = [...strandedTerminalsRef.current];
      strandedTerminalsRef.current = new Set();
      const strandedUnended = await endTerminals(stranded);
      for (const entry of strandedUnended) {
        strandedTerminalsRef.current.add(entry.terminalId);
      }

      if (work.kind === "finish_kills") {
        return settle(await endTerminals(work.terminalIds));
      }

      const closing = stateRef.current;

      // ---- the commit, CHECKED, and FINAL ----
      //
      // `final` is what makes this commit survive the quit that follows it. The
      // host retains the layout of every project it is fed and commits every
      // retained layout on its own shutdown, reconciled against what is still
      // live - and the kills below leave nothing live, so that autonomous
      // commit overwrote this snapshot with an empty one and the workspace this
      // close promised to revive came back empty. The flag tells the host this
      // layout has no successor: commit it, then stop holding it. The
      // debounced background saves above never set it.
      if (hydratedRef.current) {
        const persisted = await persistTerminalWorkspace(toPersistedLayout(closing), {
          final: true,
        });
        if (!persisted.ok) return fail({ failure: "persist_unreachable" });
        if (!persisted.data.ok) return fail({ failure: "persist_refused" });
      }

      // ---- the kills, CHECKED ----
      const plan = collectCleanups(closing.tabs, "closing");
      return settle(await endTerminals(plan.killTerminalIds));

      /**
       * Turn what survived the sweep into the attempt's outcome.
       *
       * The stranded leftovers COUNT towards failure - a shell nothing can name
       * is the worst kind to leave running - but they are not `outstanding`,
       * because their retry path is `strandedTerminalsRef`, which every attempt
       * drains first. Only shells of the committed layout belong in the phase.
       */
      function settle(unended: readonly UnendedTerminal[]): WorkspaceCloseOutcome {
        const all = [...unended, ...strandedUnended];
        if (all.length === 0) {
          publishCloseState(closeCommitted(closeStateRef.current));
          return { ok: true };
        }
        return fail({
          failure: all.some((entry) => entry.code === "foreign_terminal")
            ? "kill_not_owned"
            : "kill_incomplete",
          outstandingKillIds: unended.map((entry) => entry.terminalId),
        });
      }

      function fail(report: WorkspaceCloseFailureReport): WorkspaceCloseOutcome {
        publishCloseState(closeFailed(closeStateRef.current, report));
        setNotice(CLOSE_FAILURE_COPY[report.failure]);
        return { ok: false, failure: report.failure };
      }
    },
    [publishCloseState],
  );

  /**
   * The close as its callers see it: SINGLE-FLIGHT, and answered.
   *
   * A second gesture arriving while the first is committing awaits the SAME
   * completion and gets the SAME outcome. It used to find nothing - the handler
   * was taken once from the registry - and the centre, reading that as "no
   * workspace is mounted", unmounted the controller mid-commit and destroyed
   * the only owner of the layout being written.
   */
  const closeWorkspace = useCallback(async (): Promise<WorkspaceCloseOutcome> => {
    const admission = beginClose(closeStateRef.current);
    if (admission.admitted === "settled") return admission.outcome;
    if (admission.admitted === "join") {
      const running = closeRunRef.current;
      // `closing` with no run in flight is not reachable - the phase is
      // published inside the same synchronous block that stores the run - and
      // reporting success for a close that never happened would unmount a live
      // workspace, so the honest answer is the retryable one.
      if (running === null) return { ok: false, failure: "persist_unreachable" };
      return await running;
    }
    publishCloseState(admission.state);
    setNotice(null);
    const run = runClose(admission.work);
    closeRunRef.current = run;
    try {
      return await run;
    } finally {
      closeRunRef.current = null;
    }
  }, [publishCloseState, runClose]);

  /**
   * THE DELETION LATCH. Synchronous, and it must run BEFORE the unmount.
   *
   * The chain it breaks: a delete's cleanup removes this project's snapshot
   * file, the centre drops the project from the kept-alive set, this controller
   * unmounts, and its teardown flush writes a persist for a project that no
   * longer exists - RECREATING a file that holds the user's terminal
   * scrollback, for a project Vex has just told them was deleted.
   *
   * It is deliberately not a close: there is nothing to commit and nothing to
   * kill, because main's delete already ended the shells through its own close
   * hook, under authority this renderer does not have.
   */
  const discardWorkspaceLayout = useCallback((): void => {
    publishCloseState(discardWorkspace());
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    // AND THE FILE TABS GO WITH IT, for exactly the reason the layout write is
    // cancelled: the project is deleted, its paths name nothing, and a record
    // left behind would hold an LRU slot for a project the user has been told
    // is gone. The latch is dropped first so neither the debounce nor the
    // unmount flush can write it back.
    fileTabsHydratedRef.current = false;
    if (fileTabsTimerRef.current !== null) {
      clearTimeout(fileTabsTimerRef.current);
      fileTabsTimerRef.current = null;
    }
    useUiStore.getState().forgetProjectFileTabs(projectId);
  }, [projectId, publishCloseState]);

  useEffect(
    () =>
      publishProjectWorkspaceLifecycle(projectId, {
        close: closeWorkspace,
        discard: discardWorkspaceLayout,
      }),
    [closeWorkspace, discardWorkspaceLayout, projectId],
  );

  /* ---------------- teardown ---------------- */

  useEffect(() => {
    return () => {
      // The LAYOUT is this component's to save; the ATTACHMENTS are not.
      //
      // The obvious teardown - walk `collectCleanups(tabs, "unmounting")` and
      // detach each terminal - is wrong here, and the suite caught it doing
      // exactly one detach too many per terminal. When this controller unmounts,
      // React unmounts every `XtermHost` with it, and each host detaches the one
      // attachment it owns. Detaching again from here would give a single handle
      // two owners, which is how a cleanup ends up racing itself the moment the
      // two paths stop agreeing. The intent the model names as "unmounting" is
      // still what happens - the shells survive their grace period and replay on
      // return - it is just performed by the owner of each attachment.
      flushPersist();
    };
  }, [flushPersist]);

  /* ---------------- host loss ---------------- */

  /**
   * The pty host died and took every shell with it.
   *
   * Nothing consumed this signal before, and the result was a workspace that
   * went on drawing live tabs over dead processes and accepting keystrokes into
   * them - permanently, because the per-terminal `exit` that would have said
   * otherwise died with the port that carried it.
   *
   * Only the ids this workspace actually shows are recorded, so a crash that
   * cost another project's terminals does not put a banner over this one.
   */
  useEffect(() => {
    return onTerminalsLost((terminalIds) => {
      const mine = new Set<string>();
      for (const tab of stateRef.current.tabs) {
        if (tab.kind !== "terminalGroup") continue;
        for (const pane of tab.panes) {
          if (terminalIds.includes(pane.terminalId)) mine.add(pane.terminalId);
        }
      }
      if (mine.size === 0) return;
      setLostTerminalIds((current) => new Set([...current, ...mine]));
    });
  }, []);

  /**
   * Revive the workspace from the last snapshot, after a host loss.
   *
   * Goes through the SAME open every mount uses, so it inherits main's
   * single-flight and its host-generation fence: the remembered open from
   * before the crash is invalid by construction, and this produces exactly one
   * fresh set of ptys rather than racing the mount effect into two.
   */
  const handleRestoreLost = useCallback((): void => {
    if (restoring) return;
    setRestoring(true);
    const generation = generationRef.current;
    const opened = projectIdRef.current;
    void (async () => {
      try {
        const result = await readTerminalWorkspace(opened);
        if (generation !== generationRef.current) return;
        if (!result.ok || !result.data.ok) {
          setNotice("Vex could not restore this project's terminals. Try again.");
          return;
        }
        if (result.data.value === null) {
          setNotice("There is no saved terminal workspace left to restore.");
          stateRef.current = emptyWorkspace(opened);
          setState(stateRef.current);
          setLostTerminalIds(new Set());
          return;
        }
        stateRef.current = renumberTerminalTabs(fromSnapshot(result.data.value));
        setState(stateRef.current);
        setShellLabelById(shellLabelsOf(result.data.value));
        // THE EXITS GO WITH THEM. These terminals are new ptys with new ids;
        // keeping the old rows would leave a restored tab wearing the state of
        // the shell it replaced.
        setExits(new Map());
        setLostTerminalIds(new Set());
        setNotice(null);
      } finally {
        setRestoring(false);
      }
    })();
  }, [restoring]);

  /**
   * TELL THE USER THE SHELLS DIED, even when they are not looking at this
   * project.
   *
   * The inline bar below is the CONTEXTUAL surface and stays: it is where the
   * loss is read in place, beside the dead panes it is about. But a workspace
   * whose tab is not on screen paints nothing, and the pty host dying is
   * exactly the kind of failure a user finds out about by typing into a shell
   * that is no longer there. So the transition also raises an app-wide
   * notification, which announces once and is re-readable in the center.
   *
   * ONE notification per LOSS, not per render and not per terminal:
   *  - it is raised on the transition into a loss and closed on the transition
   *    out of one, so a re-render with the same dead set does nothing, and a
   *    second batch of dead terminals moves the count rather than raising a
   *    duplicate;
   *  - the id is per PROJECT, so a crash that costs two projects their shells
   *    is two notifications and not one overwriting the other;
   *  - the action is the same `handleRestoreLost` the inline bar calls, read
   *    through a ref, so the two controls can never mean different things.
   *
   * The action is DETACHED on unmount rather than left live: the notification
   * outlives this component (that is the point of raising it), and its closure
   * holds this workspace's state - including the project's file tokens - alive
   * for as long as the center keeps the row. The center then renders the
   * control inert with the reason instead of silently doing nothing.
   */
  const restoreLostRef = useRef(handleRestoreLost);
  restoreLostRef.current = handleRestoreLost;
  const lostNotificationRef = useRef<NotificationHandle | null>(null);
  const lostCount = lostTerminalIds.size;
  useEffect(() => {
    if (lostCount === 0) {
      lostNotificationRef.current?.close();
      lostNotificationRef.current = null;
      return undefined;
    }
    const lostSentence =
      `${String(lostCount)} ${lostCount === 1 ? "shell" : "shells"} ended with it. `
      + "Their saved output can be restored.";
    if (lostNotificationRef.current !== null) {
      // A SECOND batch of dead terminals is the same loss, still unresolved:
      // the count moves, the notification does not re-announce itself and the
      // user is not told twice. A no-op on a handle the user already dismissed.
      lostNotificationRef.current.updateMessage(lostSentence);
      return undefined;
    }
    lostNotificationRef.current = notify({
      id: `studio.terminals-lost:${projectIdRef.current}`,
      severity: "error",
      scope: { kind: "project", projectId: projectIdRef.current },
      source: "studio.terminal",
      title: "The terminal service stopped",
      message: lostSentence,
      actions: [
        {
          id: "restore",
          label: "Restore terminals",
          rank: "primary",
          run: () => {
            restoreLostRef.current();
          },
        },
      ],
    });
    return undefined;
  }, [lostCount]);

  useEffect(() => {
    return () => {
      lostNotificationRef.current?.disposeActions(
        "the project workspace is no longer open",
      );
    };
  }, []);

  /* ---------------- actions ---------------- */

  /**
   * Open a terminal. ADMISSIBILITY FIRST, THEN THE PTY.
   *
   * ## The order is the fix
   *
   * This used to create the pty and then ask the model whether it could be
   * placed. Every way that question could be answered "no" produced an
   * INVISIBLE RUNNING SHELL: a refused fifth group, a split into a tab the user
   * closed while the create was in flight, a create that landed after the user
   * switched projects. The terminal existed, held a slot against the host's
   * bounds and a lease against its project, and no pane referenced it - so
   * nothing could ever close it.
   *
   * So the model decides first. A refusal now costs a notice and nothing else.
   *
   * ## The publication fence
   *
   * Admissibility is decided before an await and acted on after one, so it must
   * be RECHECKED at publication - and the recheck has to cover more than the
   * count. The generation covers "is this still the same workspace" (a project
   * switch, a remount); the tab lookup covers "does the destination still
   * exist" (the user closed it mid-split).
   *
   * A stale completion KILLS ITS OWN PTY. It is the only holder of that id -
   * nothing else ever saw it - so discarding without killing is precisely how
   * the invisible shell was created.
   *
   * ## The CLOSE is a third staleness, and it needs both halves of the fence
   *
   * A close shuts admission, so a gesture arriving after it is REFUSED here by
   * name rather than silently ignored. A create already IN FLIGHT when the
   * close began cannot be refused - it may already have a pty - so it is caught
   * at the publication fence instead and kills its own terminal, and the close
   * awaits this call's promise (`pendingOpensRef`) before it captures the
   * layout it commits. Without both halves a terminal created during the close
   * publishes after the snapshot was captured and is in no kill set: an orphan
   * shell holding a lease and a host slot for a workspace that is gone.
   */
  const openTerminal = useCallback(
    async (
      into: { readonly kind: "tab" } | { readonly kind: "pane"; readonly tabId: string },
      /**
       * Whether the caret lands in the shell this call opens.
       *
       * A GESTURE'S PROPERTY, not a mode's: the `+` button and the new-terminal
       * chord are a user asking for a shell to type in, while the bootstrap
       * create on restore is the workspace producing one for the open-focus
       * landing to find. The bootstrap therefore passes nothing and the armed
       * landing decides, under its "only when nobody holds focus" permission.
       */
      landFocus = false,
    ): Promise<void> => {
      const generation = generationRef.current;

      // ---- admissibility, before anything exists ----
      if (!admitsTerminalCreate(closeStateRef.current)) {
        setNotice(CLOSING_CREATE_COPY);
        return;
      }
      if (into.kind === "tab") {
        if (!canAddTerminalGroup(stateRef.current, countPendingOpens(generation))) {
          setNotice(KEEP_ALIVE_COPY);
          return;
        }
      } else if (
        stateRef.current.tabs.find((tab) => tab.tabId === into.tabId) === undefined
      ) {
        // Splitting a tab that is not there is not a refusal to report; it is a
        // gesture whose target has gone.
        return;
      }

      // Registered BEFORE the await and removed in a `finally`, so a close
      // starting at any point during the create finds this call in the set and
      // waits for it. The promise resolves on every path, including a rejected
      // bridge call, so a failing create cannot park a close forever.
      let settleOpen = (): void => undefined;
      const open: PendingOpen = {
        generation,
        settled: new Promise<void>((resolve) => {
          settleOpen = resolve;
        }),
      };
      pendingOpensRef.current.add(open);
      let result;
      try {
        result = await createTerminal({
          projectId,
          // The renderer names a shell by ID and never by path. Main re-resolves
          // it against the filesystem and refuses `launch_shell_unavailable`
          // rather than substituting another shell.
          shellId,
          cols: CREATE_COLS,
          rows: CREATE_ROWS,
        });
      } finally {
        pendingOpensRef.current.delete(open);
        settleOpen();
      }

      if (!result.ok) {
        if (generation === generationRef.current) {
          setNotice("Vex could not reach the terminal service.");
        }
        return;
      }
      if (!result.data.ok) {
        if (generation === generationRef.current) {
          setNotice(
            REFUSAL_COPY[result.data.code] ??
              `The terminal service refused: ${result.data.code}.`,
          );
        }
        return;
      }
      // `displayCwd` is the host's label for where the shell was STARTED, taken
      // from the create result rather than waited for as a property event: the
      // pane is mounted in this same tick, and a header that said "not known
      // yet" until the first property arrived would blink on every new terminal.
      const { terminalId, shellName, displayCwd } = result.data.value;

      // ---- the fence ----
      const stale =
        generation !== generationRef.current
        || !admitsTerminalCreate(closeStateRef.current)
        || (into.kind === "pane"
          && stateRef.current.tabs.find((tab) => tab.tabId === into.tabId) === undefined);
      if (stale) {
        // Nothing references this terminal and nothing ever will. It is ours to
        // end, and leaving it is what "an invisible running shell" means.
        //
        // WHO ends it depends on why it is stale. A close that is RUNNING is
        // already awaiting this call, so the pty is handed to its checked kill
        // sweep; killing here instead would be an unread `void` on the one path
        // where the close is about to report whether every shell ended. Every
        // other staleness has no such owner, so this call ends it itself - and
        // the question is `closeInFlight`, not "does this phase admit a
        // create", because `failed_after_commit` refuses creates while no close
        // is running to sweep what it was handed.
        if (closeInFlight(closeStateRef.current)) {
          strandedTerminalsRef.current.add(terminalId);
          return;
        }
        void killTerminal(terminalId);
        return;
      }

      setNotice(null);
      // WHAT IS RUNNING, remembered for the tooltip and the panel header. It is
      // no longer the tab's NAME: a strip of three tabs all called `bash` told
      // the user nothing about which terminal they were switching to.
      setShellLabelById((current) => new Map(current).set(terminalId, shellName));
      // ARMED FOR THE PANE THAT DOES NOT EXIST YET. The tab is added by the
      // `apply` below and its `XtermHost` acquires the instance and parents
      // xterm's textarea on a LATER commit, so there is nothing to focus on
      // this turn; the landing effect asks again after each commit until there
      // is. Set after the staleness fence, so a create that is about to kill
      // its own pty never arms a landing on it.
      if (landFocus) landingTerminalRef.current = terminalId;
      const paneId = newId("pane");
      if (into.kind === "tab") {
        apply((current) =>
          addTerminalGroup(current, {
            kind: "terminalGroup",
            tabId: newId("group"),
            // `Terminal n`, numbered against the tabs OPEN RIGHT NOW - inside
            // the updater, so two creates racing each other cannot both read
            // the same pre-mutation state and claim the same number.
            title: nextTerminalTitle(current.tabs),
            orientation: "horizontal",
            panes: [{ paneId, terminalId, relativeSize: 1, displayCwd }],
            activePaneId: paneId,
          }),
        );
        return;
      }

      apply((current) =>
        addPane(current, into.tabId, {
          paneId,
          terminalId,
          // IGNORED by the model, which decides the share itself: the caller
          // cannot know the group's current proportions.
          relativeSize: 0,
          displayCwd,
        }),
      );
    },
    [apply, projectId, shellId],
  );

  const handleNewTerminal = useCallback((): void => {
    // THE USER ASKED FOR A SHELL, so the caret ends up in it. Both routes to
    // this handler - the strip's `+` and the new-terminal chord - are that
    // request, and before this the chord created `Terminal 2` and `Terminal 3`
    // with focus left on `document.body` each time (measured on the built app),
    // so the next chord resolved against no surface at all.
    void openTerminal({ kind: "tab" }, true);
  }, [openTerminal]);

  /**
   * READ THE SHELL CATALOGUE ONCE, when the workspace mounts.
   *
   * Not a query with an invalidation policy and not a poll: the answer changes
   * only when the user installs or removes a shell, which no event in this
   * process observes, and a stale row costs nothing because it authorizes
   * nothing - main re-resolves the chosen id on every create and refuses by
   * name if it is gone.
   *
   * FENCED with a cancellation flag so a workspace unmounted mid-read does not
   * set state on a dead component, and `defaultShellId` is applied only on the
   * FIRST successful read: overwriting a choice the user made while the read
   * was in flight would silently undo it.
   *
   * A FAILED read leaves the picker empty and is not surfaced as a notice. The
   * terminal still opens - `system_default` is the initial value and is the
   * one shell that always resolves - so there is nothing the user would do
   * with the message.
   */
  const shellsLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void readShellCatalogue().then(
      (result) => {
        if (cancelled || !result.ok) return;
        setShells(result.data.shells);
        if (!shellsLoadedRef.current) {
          shellsLoadedRef.current = true;
          setShellId(result.data.defaultShellId);
        }
      },
      () => {
        // The bridge rejected. See above: an empty picker is the whole cost.
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * OPEN THE FIRST TERMINAL of a project that restored to nothing.
   *
   * Through `openTerminal`, the same call the `+` button makes, so the
   * keep-alive bound, the closing refusal, the publication fence and the
   * stale-kill compensation are the ones that already exist. A parallel create
   * here would be a second answer to every one of those questions, and the
   * cheapest way to reintroduce the invisible running shell this component
   * spends a hundred lines preventing.
   *
   * ## Every reason it declines, and why each one is not "just be safe"
   *
   *  - ALREADY BOOTSTRAPPED. StrictMode runs the restore effect twice and a
   *    remount runs it again; without the latch each pass spawns a pty. The
   *    latch is set BEFORE the call and there is no await between the read and
   *    the write, so two entries in one tick cannot both pass it.
   *  - TABS ALREADY EXIST. The restore brought a layout back, so the project
   *    has its terminals and the user did not ask for another one.
   *  - AN OPEN IS ALREADY IN FLIGHT. The user pressed `+` while the restore was
   *    still reading. Their terminal is the first one; adding ours beside it
   *    would open two for one gesture.
   *  - THE WORKSPACE IS CLOSING. `openTerminal` would refuse it anyway, but it
   *    would refuse it with a NOTICE, and telling a user that the terminal they
   *    never asked for could not be opened is worse than saying nothing.
   *
   * A create that fails still counts as the bootstrap: `openTerminal` names the
   * reason in the notice, the empty state below offers the retry, and a latch
   * that re-armed on failure would put a create on every restore of an
   * unreachable host.
   */
  const bootstrapFirstTerminal = (): void => {
    if (autoOpenedRef.current) return;
    if (stateRef.current.tabs.length > 0) return;
    if (countPendingOpens(generationRef.current) > 0) return;
    if (!admitsTerminalCreate(closeStateRef.current)) return;
    autoOpenedRef.current = true;
    void openTerminal({ kind: "tab" });
  };
  // Written during render, like `stateRef` and `projectIdRef` above it, so the
  // restore's continuation calls the current closure rather than the one that
  // existed when the effect was created.
  bootstrapFirstTerminalRef.current = bootstrapFirstTerminal;

  /* ---------------- opening a file ---------------- */

  /**
   * Put a file in the strip.
   *
   * The TITLE is `node.name`, which main already minted as the entry's own
   * name - deriving a basename here would be a second, weaker answer to a
   * question the wire has already answered. The TOKEN travels with the tab
   * because it, not the path, is what reads the file; see `WorkspaceFileTab`.
   *
   * No admissibility question to ask first, unlike `openTerminal`: a file tab
   * holds no pty, no lease and no host slot, so `addFileTab` cannot refuse and
   * there is no invisible resource a late completion could strand.
   *
   * `mode` is THE GESTURE'S, carried the whole way from the click that made it
   * (`ExplorerRow` -> `ExplorerTree` -> the open intent). It defaults to
   * `"pinned"` here as it does in every layer below, so a route that has not
   * chosen keeps the behaviour it had before previews existed.
   */
  const openFile = useCallback(
    (node: FileNode, mode: FileOpenMode = "pinned"): void => {
      apply((current) =>
        addFileTab(
          current,
          {
            kind: "file",
            tabId: newId("file"),
            title: node.name,
            relativePath: node.path,
            nodeId: node.nodeId,
            dirty: false,
          },
          { mode },
        ),
      );
    },
    [apply],
  );

  /**
   * Take whatever the explorer parked for THIS project.
   *
   * Consume-once and project-keyed, so StrictMode's second effect pass finds an
   * empty slot and a file chosen just before a project switch is dropped rather
   * than opened in the wrong workspace. See `workspace/file-open-intent.ts`.
   */
  const parkedFileOpen = useFileOpenIntentStore((store) => store.intent);
  useEffect(() => {
    if (parkedFileOpen === null) return;
    const taken = useFileOpenIntentStore
      .getState()
      .consumeFileOpenIntent(parkedFileOpen.intentId, projectId);
    if (taken === null) return;
    openFile(taken.node, taken.mode);
  }, [openFile, parkedFileOpen, projectId]);

  /**
   * KEEP a tab, promoting the workspace's preview to a pinned one.
   *
   * One handler for both gestures that mean it - the tab's own double click
   * and its "Keep open" control, and the `Ctrl+Enter` command below - so the
   * promotion has one route into the model. `pinTab` is idempotent and
   * refuses only a tab that is not there, so neither gesture has to ask
   * whether there was anything to promote.
   */
  const handlePinTab = useCallback(
    (tabId: string): void => {
      apply((current) => pinTab(current, tabId));
    },
    [apply],
  );

  /**
   * THE TAB FOLLOWS ITS FILE'S RENAME.
   *
   * The explorer parks the confirmed rename and this takes it, exactly as the
   * open intent above is taken and for the same reasons: project-keyed so a
   * rename in another project cannot retarget a tab here, consume-once so
   * StrictMode's second pass applies nothing twice.
   *
   * The retarget carries the new TOKEN, which is what makes the viewer follow
   * too: `FileViewerRegistry.acquire` swaps in a session on the new path the
   * moment the tab's `nodeId` changes.
   */
  const parkedFileRename = useFileRenameSignalStore((store) => store.signal);
  useEffect(() => {
    if (parkedFileRename === null) return;
    const taken = useFileRenameSignalStore
      .getState()
      .consumeFileRenameSignal(parkedFileRename.signalId, projectId);
    if (taken === null) return;
    const retarget = (from: string, to: FileTabTarget): void => {
      apply((current) => {
        const outcome = retargetFileTab(current, from, to);
        // NO TAB ON THAT PATH is the ORDINARY case, not something to tell the
        // user about: most renames are of files nobody has open. Answering
        // "unchanged" keeps the workspace's refusal notice for the refusals a
        // user's own gesture actually caused.
        return outcome.ok ? outcome : { ok: true, state: current };
      });
    };
    retarget(taken.fromRelativePath, taken.to);

    // AND THE SAME RENAME MAY HAVE BEEN A DIRECTORY'S, which moves every tab
    // underneath it. The signal names only the entry the user typed a new name
    // for, so the tabs below it are found here by prefix and their new tokens
    // are asked for; see `workspace/renamed-folder-tabs.ts` for why a token
    // cannot be computed on this side of the boundary. A rename of a FILE
    // selects nothing - no tab can live under a file's path - so the ordinary
    // case costs one array scan and no bridge call.
    const under = fileTabsUnderFolder(stateRef.current.tabs, taken.fromRelativePath);
    if (under.length === 0) return;
    const generation = generationRef.current;
    const isStale = (): boolean =>
      generation !== generationRef.current || projectIdRef.current !== projectId;
    void resolveRenamedFolderTabs({
      projectId,
      fromRelativePath: taken.fromRelativePath,
      toNodeId: taken.to.nodeId,
      tabs: under,
      list: listProjectChildren,
      isStale,
    }).then(
      (followed) => {
        // THE FENCE, checked again at publication rather than only at start:
        // everything interesting happens during the listings.
        if (isStale()) return;
        for (const one of followed) retarget(one.fromRelativePath, one.to);
      },
      (cause: unknown) => {
        console.warn(
          `studio workspace: following the rename of ${taken.fromRelativePath} failed`,
          cause,
        );
      },
    );
  }, [apply, parkedFileRename, projectId]);

  const handleSplit = useCallback(
    (tabId: string, orientation: "horizontal" | "vertical"): void => {
      apply((current) => setGroupOrientation(current, tabId, orientation));
      void openTerminal({ kind: "pane", tabId });
    },
    [apply, openTerminal],
  );

  /**
   * End a terminal for good: kill the pty AND destroy the xterm.
   *
   * BOTH HALVES, and the second is the one that was missing. The registry keeps
   * terminals outside React on purpose - `release` never disposes, so a
   * StrictMode remount or a tab switch cannot destroy a live shell - which
   * means a closed tab's xterm instance, its scrollback, its theme observer,
   * its DOM wrapper and its WebGL context were retained for the life of the
   * window, by a registry no surviving component could name. `dispose` is the
   * explicit verb for exactly this caller: the user closed it.
   */
  const endTerminal = useCallback(
    (terminalId: string): void => {
      void killTerminal(terminalId);
      activeRegistry.dispose(terminalId);
    },
    [activeRegistry],
  );

  const handleCloseTab = useCallback(
    (tabId: string): void => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab !== undefined) {
        // CLOSING: the user closed this tab, so its ptys are killed rather than
        // left running for a grace period nobody will come back through.
        const plan = collectCleanups([tab], "closing");
        for (const terminalId of plan.killTerminalIds) endTerminal(terminalId);
      }
      apply((current) => closeTab(current, tabId));
    },
    [apply, endTerminal],
  );

  /**
   * PRUNE the two display maps to the terminals still on screen.
   *
   * Rule 05: every growing store names its bound. The bound here is the
   * workspace itself - at most `WORKSPACE_TERMINAL_GROUPS_MAX` groups, each
   * with its panes - and the way it is enforced is to drop what the model no
   * longer holds, on the render after it stopped holding it. Doing it here
   * rather than in each close path means no close route can forget: the
   * strip's close, the header's kill, a project delete and a failed restore
   * all end in the same state change.
   */
  useEffect(() => {
    const live = new Set<string>();
    for (const tab of state.tabs) {
      if (tab.kind !== "terminalGroup") continue;
      for (const pane of tab.panes) live.add(pane.terminalId);
    }
    const prune = <T,>(current: ReadonlyMap<string, T>): ReadonlyMap<string, T> => {
      const stale = [...current.keys()].filter((id) => !live.has(id));
      if (stale.length === 0) return current;
      const next = new Map(current);
      for (const id of stale) next.delete(id);
      return next;
    };
    setExits(prune);
    setShellLabelById(prune);
  }, [state.tabs]);

  /** What the strip needs beyond the model to draw each tab's state. */
  const runFacts: TerminalRunFacts = useMemo(
    () => ({ lostTerminalIds, exits, restoring }),
    [lostTerminalIds, exits, restoring],
  );

  const handleClosePane = useCallback(
    (tabId: string, paneId: string): void => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.tabId === tabId);
      if (tab?.kind === "terminalGroup") {
        const pane = tab.panes.find((candidate) => candidate.paneId === paneId);
        // Only when the model will actually remove it: `closePane` refuses the
        // last pane of a group, and killing a terminal whose pane survives the
        // refusal would leave the pane rendering a shell that no longer exists.
        if (pane !== undefined && tab.panes.length > 1) endTerminal(pane.terminalId);
      }
      apply((current) => closePane(current, tabId, paneId));
    },
    [apply, endTerminal],
  );

  /** The workspace card, for the focus restoration below. */
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** A keyboard close is waiting for focus to be put back. See the effect. */
  const restoreFocusRef = useRef(false);

  /**
   * PUBLISH THE KEYBOARD-REACHABLE ACTIONS for as long as this workspace is
   * mounted.
   *
   * The keyboard table is mounted once, by `StudioCenter`, and the actions a
   * `Ctrl+W` or a `Ctrl+Shift+\`` needs are here - in a component that exists
   * once per kept-alive project and holds the state those actions mutate.
   * Publishing the handle is how the two meet without either reaching into the
   * other; `workspace/workspace-handles.ts` explains the seam, which the close
   * gesture already travels.
   *
   * EVERY ROUTE IS AN EXISTING HANDLER, deliberately. A shortcut that opened a
   * terminal by its own path would bypass the keep-alive bound, the closing
   * refusal and the publication fence that `openTerminal` enforces, and a
   * shortcut that closed a tab by its own path would leave its ptys running.
   * The only thing new here is which gesture calls them.
   *
   * Each returns whether it ACTED: the hook takes the keystroke only for a
   * command that answered, so `Ctrl+W` over an empty workspace reaches the
   * browser instead of being silently swallowed.
   *
   * Reads `stateRef`, never `state`: the effect must not re-publish on every
   * tab change, and the current strip is what these act on.
   */
  useEffect(
    () =>
      publishProjectWorkspaceCommands(projectId, {
        newTerminal: () => {
          handleNewTerminal();
          return true;
        },
        splitActiveTerminal: () => {
          const active = stateRef.current.tabs.find(
            (tab) => tab.tabId === stateRef.current.activeTabId,
          );
          // No side-by-side of a file, and nothing to split when the strip is
          // empty. "horizontal" is the header's own first split control, and
          // is what VS Code's Split Terminal does: side by side.
          if (active === undefined || active.kind !== "terminalGroup") return false;
          handleSplit(active.tabId, "horizontal");
          return true;
        },
        closeActiveTab: () => {
          const tabId = stateRef.current.activeTabId;
          if (tabId === null) return false;
          handleCloseTab(tabId);
          restoreFocusRef.current = true;
          return true;
        },
        selectTabAtOffset: (offset) => {
          const tabId = tabIdAtOffset(stateRef.current, offset);
          if (tabId === null) return false;
          apply((current) => selectTab(current, tabId));
          return true;
        },
        pinActiveTab: () => {
          const active = stateRef.current.tabs.find(
            (tab) => tab.tabId === stateRef.current.activeTabId,
          );
          // ONLY A PREVIEW ANSWERS. A terminal group, an already-pinned file
          // and an empty strip all have nothing to keep, and the hook takes
          // the keystroke only for a command that acted - which matters here
          // more than anywhere else in this map, because `Enter` is a key the
          // workspace must not swallow.
          if (active === undefined || !isPreviewFileTab(active)) return false;
          handlePinTab(active.tabId);
          return true;
        },
      }),
    [apply, handleCloseTab, handleNewTerminal, handlePinTab, handleSplit, projectId],
  );

  /**
   * FOCUS COMES BACK after a keyboard close. The rule `RenameField` already
   * follows, applied to the gesture that needs it most.
   *
   * A closed tab's trigger is REMOVED from the DOM, and focus left on a removed
   * node drops the user to `document.body` - which is outside every Studio
   * surface, so `studioSurfaceOf` answers `none` and the very next `Ctrl+W`
   * resolves to nothing. Measured, not theorised: before this, the shortcut
   * closed exactly one tab per pointer click, and the browser pass is what
   * caught it (the jsdom suites drive the command directly and never had focus
   * on a trigger to lose).
   *
   * AN EFFECT WITH NO DEPENDENCY ARRAY, and a flag, because the moment that
   * matters is "after the commit that removed the element" - which is exactly
   * what a post-commit effect is. A `queueMicrotask` from the key handler would
   * race React's scheduling of an update that did not originate in a React
   * event.
   *
   * It moves focus only when the workspace LOST it: a user whose focus is still
   * somewhere in this card (a terminal, the picker) is left where they are.
   */
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const card = cardRef.current;
    if (card === null || card.contains(document.activeElement)) return;
    // The newly selected tab, or - when the close emptied the strip - the one
    // control that is always there. Both are inside the card, so the surface
    // stays `workspace` and the next shortcut resolves.
    focusWorkspaceStrip(card);
  });

  /**
   * FOCUS LANDS IN THE TERMINAL THE USER JUST ASKED FOR.
   *
   * `openTerminal` arms this with the id it published; the pane's `XtermHost`
   * acquires the instance and parents xterm's textarea on a later commit, so
   * this effect - which has no dependency array, exactly like the two above it
   * - asks `focusActiveTerminal` after each commit until the textarea is
   * there. That is the same "stay armed until it is attached" shape the open
   * landing uses, and it goes through the same seam rather than a bare
   * `focus()`: the element to focus is xterm's own textarea by its own
   * accessible name, which this component has no business selecting for itself.
   *
   * IT DISARMS ON THE TERMINAL LEAVING THE WORKSPACE, not only on success. A
   * shell closed or lost between the create and the attach would otherwise
   * leave the request standing, and the next commit that happened to mount an
   * unrelated pane with that id - a revive hands ids back - would move the
   * caret for a gesture the user made minutes ago.
   */
  useEffect(() => {
    const terminalId = landingTerminalRef.current;
    if (terminalId === null) return;
    const card = cardRef.current;
    if (card === null) return;
    const stillOpen = stateRef.current.tabs.some(
      (tab) =>
        tab.kind === "terminalGroup"
        && tab.panes.some((pane) => pane.terminalId === terminalId),
    );
    if (!stillOpen) {
      landingTerminalRef.current = null;
      return;
    }
    if (focusActiveTerminal(card, terminalId)) landingTerminalRef.current = null;
  });

  /**
   * FOCUS LANDS IN A WORKSPACE THAT WAS JUST OPENED.
   *
   * The measured defect: `Enter` on the welcome's "Open <project>" opened the
   * project and left `document.activeElement` on `document.body`, because the
   * welcome's button was removed from the DOM and nothing claimed the focus it
   * dropped. A keyboard user then tabbed from the top of the window to reach
   * the shell that had just been opened for them.
   *
   * ARMED, not fired once. When a project is opened its terminals are not
   * there yet - the restore is an IPC round trip and a first terminal is
   * bootstrapped after it - so the first commit after `active` turns true has
   * nothing worth focusing. The flag stays raised while the workspace is still
   * PRODUCING its terminals (`restoring`, or an open in flight) and the effect,
   * which has no dependency array, asks again after each commit until there is
   * a terminal or there is nothing left to wait for.
   *
   * IT CANNOT STEAL FOCUS, and that is what makes retrying safe rather than
   * hostile: `studioFocusPermission` moves focus only when NOTHING holds it.
   * A user who clicked into the rail, opened a dialog or started typing while
   * the revive was in flight ends the arming with focus exactly where they put
   * it. That is `EditorPart.shouldRestoreFocus` and the "focus has not changed
   * meanwhile" guard in `EditorGroupView.restoreEditors`, applied to the same
   * situation they were written for - a restore completing after a user has
   * already acted.
   */
  const focusArmedRef = useRef(active);
  const wasActiveRef = useRef(active);
  if (active && !wasActiveRef.current) focusArmedRef.current = true;
  wasActiveRef.current = active;

  useEffect(() => {
    if (!active || !focusArmedRef.current) return;
    const card = cardRef.current;
    const permission = studioFocusPermission(card, document.activeElement);
    if (permission !== "take" || card === null) {
      // "inside" and "elsewhere" both end the arming: focus has an owner, and
      // this workspace is not going to take it away from them.
      focusArmedRef.current = false;
      return;
    }
    const terminalId = activeTerminalIdOf(stateRef.current);
    if (terminalId !== null) {
      // STAY ARMED until it is attached. The tab exists a commit before the
      // pane's `XtermHost` has acquired the instance and parented its wrapper.
      if (focusActiveTerminal(card, terminalId)) focusArmedRef.current = false;
      return;
    }
    if (
      !hydratedRef.current
      || !fileTabsHydratedRef.current
      || restoring
      || pendingOpensRef.current.size > 0
    ) {
      // The shell this workspace was opened for is still on its way. Stay
      // armed rather than parking focus on the strip and calling it done.
      //
      // The FILE-TAB LATCH is the second half of the same idea: the persisted
      // file strip is several listings behind the terminal snapshot, and a
      // landing that accepted the gap would park focus on the strip a moment
      // before the tabs it is describing arrive.
      //
      // The HYDRATION LATCH is the first of the four and the one that decides
      // the ordinary open: for the whole of the restore round trip the strip is
      // legitimately empty, and a landing that accepted it would put the caret
      // on the `+` button and be finished before the terminal the user opened
      // the project for had even been asked for.
      return;
    }
    // No terminal to land in: a file tab, or an empty workspace.
    if (focusWorkspaceStrip(card)) focusArmedRef.current = false;
  });

  return (
    // THE MOCKUP'S CARD. The workspace used to run edge to edge, so the
    // terminal met the window with no boundary and the watermark had nothing
    // to sit on. The column paints the shell's own ground, and the strip and
    // the panel live on a rounded `surface-1` card inset from it - which is
    // also the surface the transparent xterm canvas is read against, and the
    // one the palette's contrast is measured on.
    <div
      ref={cardRef}
      className={cn("flex h-full min-h-0 flex-col bg-surface-base p-3", className)}
      data-vex-workspace-card=""
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line-3 bg-surface-1">
      <TerminalTabs
        state={state}
        runFacts={runFacts}
        shellLabelById={shellLabelById}
        {...(watermarkRows === undefined ? {} : { watermarkRows })}
        {...(registry === undefined ? {} : { registry })}
        onSelectTab={(tabId) => {
          apply((current) => selectTab(current, tabId));
        }}
        onCloseTab={handleCloseTab}
        // THE STRIP'S OWN KEEP GESTURES - the tab's double click and its "Keep
        // open" control - reach the same promotion `Ctrl+Enter` does. Without
        // this prop `TerminalTabs` draws neither, so a preview tab had no
        // pointer route to being kept at all.
        onPinTab={handlePinTab}
        onNewTerminal={handleNewTerminal}
        onSplit={handleSplit}
        onResizePanes={(tabId, sizes) => {
          apply((current) => resizePanes(current, tabId, sizes));
        }}
        onActivatePane={(tabId, paneId) => {
          apply((current) => setActivePane(current, tabId, paneId));
        }}
        onClosePane={handleClosePane}
        // THE USER'S NAME FOR A TAB, which is a different thing from the
        // shell's title. `setTabTitle` refuses an empty one, so a rename
        // cannot blank the tab it names.
        onRenameTab={(tabId, title) => {
          apply((current) => setTabTitle(current, tabId, title));
        }}
        onDisplayCwdChange={(terminalId, displayCwd) => {
          apply((current) => setPaneDisplayCwd(current, terminalId, displayCwd));
        }}
        // The shell's own title NO LONGER RENAMES THE TAB. It says what is
        // running, which is a fact about the terminal rather than a name for
        // it, so it feeds the tooltip and the panel header's second line and
        // leaves `Terminal n` (or the user's own name) alone.
        // AS A PROCESS NAME, normalised here rather than at each place that
        // renders it: the poll reports the shell as the path it was launched
        // from (`/bin/bash`), and the restore path already stores the reduced
        // spelling (`shellLabelsOf`), so writing the raw value here would put
        // two spellings of one fact in the same map and make the equality
        // check below miss a no-op update. See `shellProcessName`.
        onShellTitle={(terminalId, title) => {
          const name = shellProcessName(title);
          setShellLabelById((current) => {
            if (current.get(terminalId) === name) return current;
            return new Map(current).set(terminalId, name);
          });
        }}
        shellId={shellId}
        shells={shells}
        onSelectShell={setShellId}
        renderFileTab={(tab, isActive) => (
          // The viewer needs the project, and `TerminalTabs` does not have one.
          // A render prop keeps the tab strip ignorant of the files domain
          // rather than threading `projectId` into a terminal component.
          <FileViewer projectId={projectId} tab={tab} active={isActive} />
        )}
        onPaneExit={(tabId, paneId, info) => {
          // An exited pty leaves its pane and its scrollback in place: the exit
          // code is what the user came back to read, and closing the pane for
          // them would take it away. `XtermHost` renders the exit line inside
          // the pane; RECORDED HERE so the tab in the strip can stop claiming
          // the shell is running, which is the one place a user looking at a
          // different tab would ever see it.
          const tab = stateRef.current.tabs.find(
            (candidate) => candidate.tabId === tabId,
          );
          const terminalId =
            tab?.kind === "terminalGroup"
              ? tab.panes.find((pane) => pane.paneId === paneId)?.terminalId
              : undefined;
          if (terminalId === undefined) return;
          setExits((current) => new Map(current).set(terminalId, info));
        }}
        notice={
          lostTerminalIds.size > 0 ? (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-2 border-b border-line-3 bg-warning-wash px-3 py-2 text-[12px] leading-4 text-ink-primary"
            >
              <span className="flex-1">
                {`The terminal service stopped and ${String(lostTerminalIds.size)} `
                  + `${lostTerminalIds.size === 1 ? "shell" : "shells"} ended with it. `
                  + "Their saved output can be restored."}
              </span>
              <button
                type="button"
                onClick={handleRestoreLost}
                disabled={restoring}
                className="rounded px-1 font-medium text-accent-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
              >
                {restoring ? "Restoring..." : "Restore terminals"}
              </button>
            </div>
          ) : notice === null && restoreNotice === null ? null : (
            <div
              // A FAILED CLOSE IS AN ERROR, not a status: the user asked for
              // something, it did not happen, and their shells are still
              // running. `alert` is what makes a screen reader say so without
              // waiting for the next focus move.
              role={closeIsFailed(closePhase) ? "alert" : "status"}
              className="flex shrink-0 items-start gap-2 border-b border-line-3 bg-warning-wash px-3 py-2 text-[12px] leading-4 text-ink-primary"
            >
              <span className="flex-1">
                {restoreNotice === null ? null : (
                  <span className="block">{restoreNotice}</span>
                )}
                {notice === null ? null : <span className="block">{notice}</span>}
              </span>
              {/* THE RETRY, beside the sentence that says a retry is worth
                * making. The copy has always said "Try closing again" while the
                * row offered only Dismiss, so the only way to act on it was to
                * find the close gesture again in another column. Same shape as
                * the host-loss row's "Restore terminals" action above, which is
                * this surface's pattern for an error row with one repair.
                *
                * `kill_not_owned` is the one failure with no retry: the host
                * reports the shell as another window's, and asking this window
                * again cannot change that. */}
              {closeIsFailed(closePhase) && closePhase.failure !== "kill_not_owned" ? (
                <button
                  type="button"
                  onClick={() => {
                    if (onRetryClose === undefined) {
                      void closeWorkspace();
                      return;
                    }
                    onRetryClose();
                  }}
                  className="rounded px-1 font-medium text-accent-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  Try closing again
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  // ONE Dismiss for one row: a user who has read it has read
                  // all of it, and two dismiss buttons in a two-line row is a
                  // control a keyboard user cannot tell apart by name.
                  setNotice(null);
                  setRestoreNotice(null);
                }}
                className="rounded px-1 text-ink-tertiary hover:text-ink-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Dismiss
              </button>
            </div>
          )
        }
      />
      </div>
    </div>
  );
}

/**
 * An open that has been ADMITTED and whose pty does not exist yet.
 *
 * The promise is what a close joins; the generation is which workspace asked
 * for it. Both facts are needed and they answer different questions - see
 * `countPendingOpens`.
 */
interface PendingOpen {
  readonly generation: number;
  readonly settled: Promise<void>;
}

/**
 * A shell the host did NOT prove ended, with the code it answered.
 *
 * `code` is `null` when the call did not reach main at all, which is a
 * different fact from a refusal and is kept separate for that reason: only a
 * refusal can carry `foreign_terminal`, the one code that says the shell exists
 * and belongs to somebody else.
 */
interface UnendedTerminal {
  readonly terminalId: string;
  readonly code: TerminalErrorCode | null;
}

/**
 * Kill every one of these, CONCURRENTLY, and report what survived.
 *
 * Returning the survivors rather than a boolean is what lets a retry finish the
 * close: `close-lifecycle.ts` puts these ids in the failed phase, and the next
 * attempt kills exactly them instead of re-running a commit that would write a
 * snapshot reconciled against a half-killed workspace.
 */
async function endTerminals(
  terminalIds: readonly string[],
): Promise<readonly UnendedTerminal[]> {
  const outcomes = await Promise.all(
    terminalIds.map(async (terminalId) => ({
      terminalId,
      outcome: await killTerminal(terminalId),
    })),
  );
  const unended: UnendedTerminal[] = [];
  for (const { terminalId, outcome } of outcomes) {
    if (!outcome.ok) {
      unended.push({ terminalId, code: null });
      continue;
    }
    if (outcome.data.ok || killProvedGone(outcome.data.code)) continue;
    unended.push({ terminalId, code: outcome.data.code });
  }
  return unended;
}

let idCounter = 0;

/**
 * A workspace-local id.
 *
 * `crypto.randomUUID` where it exists, a counter otherwise. These ids are
 * PERSISTED as group ids, so they must be stable for the life of a workspace,
 * but they never leave the renderer and name nothing outside it - so uniqueness
 * within this window is the whole requirement.
 */
function newId(prefix: string): string {
  idCounter += 1;
  const unique =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${String(Date.now())}-${String(idCounter)}`;
  return `${prefix}-${unique}`;
}
