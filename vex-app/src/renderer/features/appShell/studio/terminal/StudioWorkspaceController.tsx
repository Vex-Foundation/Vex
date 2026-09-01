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

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { FileNode } from "@shared/schemas/files.js";
import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import { cn } from "../../../../lib/utils.js";
import { reportRendererFailure } from "../../../../lib/renderer-error-report.js";
import {
  createTerminal,
  killTerminal,
  onTerminalsLost,
  persistTerminalWorkspace,
  readTerminalWorkspace,
} from "../../../../lib/api/terminal.js";
import {
  addFileTab,
  addPane,
  addTerminalGroup,
  canAddTerminalGroup,
  closePane,
  closeTab,
  collectCleanups,
  emptyWorkspace,
  fromSnapshot,
  resizePanes,
  selectTab,
  setActivePane,
  setGroupOrientation,
  setTabTitle,
  toPersistedLayout,
} from "../workspace/workspace-model.js";
import { useFileOpenIntentStore } from "../workspace/file-open-intent.js";
import {
  publishProjectTerminals,
  publishProjectWorkspaceLifecycle,
} from "../workspace/project-terminals.js";
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
import type { WorkspaceMutation, WorkspaceState } from "../workspace/types.js";
import { TerminalTabs } from "./TerminalTabs.js";
import { FileViewer } from "../viewer/index.js";
import { terminalRegistry, type TerminalRegistry } from "./terminal-registry.js";
import {
  CLOSE_FAILURE_COPY,
  CLOSING_CREATE_COPY,
  KEEP_ALIVE_COPY,
  MUTATION_REFUSAL_COPY,
  REFUSAL_COPY,
  RESTORE_FAILED_COPY,
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
}

export function StudioWorkspaceController({
  projectId,
  registry,
  className,
  onRetryClose,
}: StudioWorkspaceControllerProps): JSX.Element {
  const [state, setState] = useState<WorkspaceState>(() => emptyWorkspace(projectId));
  const [notice, setNotice] = useState<string | null>(null);
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

  const flushPersist = useCallback((): void => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!hydratedRef.current) return;
    if (!admitsPersist(closeStateRef.current)) return;
    void persistTerminalWorkspace(toPersistedLayout(stateRef.current));
  }, []);

  /* ---------------- restore ---------------- */

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    hydratedRef.current = false;
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
        return;
      }
      if (result.data.value !== null) {
        stateRef.current = fromSnapshot(result.data.value);
        setState(stateRef.current);
      }
      hydratedRef.current = true;
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
   * `workspace/project-terminals.ts` for why the index exists at all.
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
  }, [publishCloseState]);

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
        stateRef.current = fromSnapshot(result.data.value);
        setState(stateRef.current);
        setLostTerminalIds(new Set());
        setNotice(null);
      } finally {
        setRestoring(false);
      }
    })();
  }, [restoring]);

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
      const { terminalId, shellName } = result.data.value;

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
      const paneId = newId("pane");
      if (into.kind === "tab") {
        apply((current) =>
          addTerminalGroup(current, {
            kind: "terminalGroup",
            tabId: newId("group"),
            title: shellName,
            orientation: "horizontal",
            panes: [{ paneId, terminalId, relativeSize: 1 }],
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
        }),
      );
    },
    [apply, projectId],
  );

  const handleNewTerminal = useCallback((): void => {
    void openTerminal({ kind: "tab" });
  }, [openTerminal]);

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
   */
  const openFile = useCallback(
    (node: FileNode): void => {
      apply((current) =>
        addFileTab(current, {
          kind: "file",
          tabId: newId("file"),
          title: node.name,
          relativePath: node.path,
          nodeId: node.nodeId,
          dirty: false,
        }),
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
    openFile(taken.node);
  }, [openFile, parkedFileOpen, projectId]);

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

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface-base", className)}>
      <TerminalTabs
        state={state}
        lostTerminalIds={lostTerminalIds}
        {...(registry === undefined ? {} : { registry })}
        onSelectTab={(tabId) => {
          apply((current) => selectTab(current, tabId));
        }}
        onCloseTab={handleCloseTab}
        onNewTerminal={handleNewTerminal}
        onSplit={handleSplit}
        onResizePanes={(tabId, sizes) => {
          apply((current) => resizePanes(current, tabId, sizes));
        }}
        onActivatePane={(tabId, paneId) => {
          apply((current) => setActivePane(current, tabId, paneId));
        }}
        onClosePane={handleClosePane}
        onTitleChange={(tabId, title) => {
          apply((current) => setTabTitle(current, tabId, title));
        }}
        renderFileTab={(tab, isActive) => (
          // The viewer needs the project, and `TerminalTabs` does not have one.
          // A render prop keeps the tab strip ignorant of the files domain
          // rather than threading `projectId` into a terminal component.
          <FileViewer projectId={projectId} tab={tab} active={isActive} />
        )}
        onPaneExit={() => {
          // An exited pty leaves its pane and its scrollback in place: the exit
          // code is what the user came back to read, and closing the pane for
          // them would take it away. `XtermHost` renders the exit line.
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
          ) : notice === null ? null : (
            <div
              // A FAILED CLOSE IS AN ERROR, not a status: the user asked for
              // something, it did not happen, and their shells are still
              // running. `alert` is what makes a screen reader say so without
              // waiting for the next focus move.
              role={closeIsFailed(closePhase) ? "alert" : "status"}
              className="flex shrink-0 items-start gap-2 border-b border-line-3 bg-warning-wash px-3 py-2 text-[12px] leading-4 text-ink-primary"
            >
              <span className="flex-1">{notice}</span>
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
                  setNotice(null);
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
