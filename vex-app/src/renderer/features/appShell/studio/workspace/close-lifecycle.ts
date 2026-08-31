/**
 * THE CLOSE LIFECYCLE of one project workspace, as a pure model.
 *
 * ## Why this is its own module rather than a boolean in the controller
 *
 * Closing a workspace used to be a latch: one `closedRef` set before the first
 * await, and everything after it assumed success. That assumption is what made
 * the close unsafe. A close COMMITS THE USER'S BUFFERS and only then ends their
 * shells, so it has at least four genuinely different states - it has not
 * started, it is running, it finished, or it FAILED and the shells are still
 * alive with nothing saved - and a boolean can express two of them. The bug the
 * boolean produced was the expensive one: a refused snapshot commit still went
 * on to kill every pty, so the layout and the scrollback the close existed to
 * save were destroyed by the operation that was saving them.
 *
 * So the rules live here, pure and table-tested, and
 * `StudioWorkspaceController` performs the effects and publishes the state -
 * the same split it already keeps with `workspace-model.ts` and the same one
 * `StudioCenter` keeps with `keep-alive.ts`. The controller is the ONE owner of
 * the phase; nothing else writes it, and the two consumers that must respect it
 * (the centre's set transition and the persist writers) read it through the
 * outcome it returns and through {@link admitsPersist}.
 *
 * ## The six phases
 *
 *   open                  nothing is closing. Terminals may be created, layout
 *                         may persist.
 *   closing               ADMISSION IS SHUT. No new terminal, no background
 *                         persist. The close is committing the snapshot and
 *                         then ending the shells.
 *   failed_before_commit  the snapshot did NOT land. NOTHING WAS DESTROYED and
 *                         nothing was saved: the workspace stays mounted and
 *                         fully usable, the user is told what happened, and a
 *                         retry re-runs the WHOLE close.
 *   failed_after_commit   the snapshot IS on disk and correct, and at least one
 *                         shell could not be ended. A retry finishes ONLY those
 *                         kills, and no persist of any kind may run again.
 *   closed                the snapshot is on disk and the shells are ended.
 *                         Terminal.
 *   discarded             THE PROJECT IS GONE - deleted, its tombstone
 *                         committed and its snapshot removed by main's own
 *                         cleanup.
 *
 * ## Why the failure is TWO phases and not one
 *
 * This is the whole of the B4 round-2 finding, and it is a data-loss one. The
 * host does not write the layout it is handed: `PtyHostService` reconciles that
 * layout against the terminals that are LIVE at the moment of the commit
 * (`host-service.ts`, `const committed = reconcile(layout, entries)`) and
 * writes the intersection. So a persist issued after a PARTIAL kill sweep
 * commits a snapshot with the killed terminals missing - over the one that
 * carried their buffers.
 *
 * A single `failed` phase forgot which side of the commit the failure was on.
 * It admitted background persists and it re-ran the whole close on a retry, so
 * the ordinary "one shell would not die" case wrote a second, emptier snapshot
 * and lost exactly the scrollback the first commit had saved. Splitting the
 * phase is what makes the two answers different:
 *
 *   failed_before_commit  nothing is on disk yet, so a write is still WANTED.
 *                         `admitsPersist` is true and a retry persists again.
 *   failed_after_commit   the correct snapshot is already on disk, so every
 *                         further write is a LOSS. `admitsPersist` is false,
 *                         `admitsTerminalCreate` is false (a terminal opened
 *                         here could reach no snapshot and no kill set), and
 *                         the retry carries the ids that remain
 *                         ({@link WorkspaceCloseState.outstandingKillIds}) so
 *                         it can finish the kills and nothing else.
 *
 * VS Code holds the same rule from the other end: once `_isShuttingDown` is
 * latched its debounced `_saveState` returns immediately, "to avoid saving
 * state when shutting down as that would override process state to be revived"
 * (`terminalService.ts`). Their shutdown cannot be retried, so they need one
 * latch where we need two phases; the invariant being protected is identical.
 *
 * `discarded` belongs in THIS machine rather than beside it because it answers
 * the same question every other phase answers - may this workspace persist, may
 * it admit a terminal - and a second flag answering it would be a second source
 * of truth for one lifecycle. It differs from `closed` in what it forbids and
 * why: `closed` means "we already saved this, do not overwrite it", while
 * `discarded` means "there is nothing to save this to, and writing would
 * RECREATE a file main just deleted". It kills nothing, because the delete's
 * own close hook has already ended the project's shells with authority this
 * renderer does not have.
 *
 * ## The renderer's latch is not the authority
 *
 * A persist suppressed here is a persist that never leaves the window, which is
 * a courtesy, not a guarantee. Main enforces the same rule from the other side:
 * `TerminalDomain.persistWorkspace` takes a drained `terminalPersist` lease and
 * refuses `project_deleting` once the project's admission has closed. Both
 * halves exist because either one alone is a single point of failure on a path
 * that writes a user's terminal scrollback to disk.
 */

import type { TerminalErrorCode } from "@shared/schemas/terminal.js";

export type WorkspaceClosePhase =
  | "open"
  | "closing"
  | "failed_before_commit"
  | "failed_after_commit"
  | "closed"
  | "discarded";

/**
 * Why a close did not finish.
 *
 * Four, because the user's next action differs for each. The first two mean the
 * buffers were NOT saved and everything is exactly as they left it; the last
 * two mean the buffers ARE saved and a shell outlived the close.
 */
export type WorkspaceCloseFailure =
  /** The persist call itself did not reach main. */
  | "persist_unreachable"
  /** Main or the host REFUSED the commit. The snapshot on disk is unchanged. */
  | "persist_refused"
  /** The snapshot committed, but at least one shell could not be ended. */
  | "kill_incomplete"
  /**
   * The snapshot committed, and the host says a shell this window believed it
   * owned belongs to ANOTHER window. An ownership-invariant violation, and the
   * one failure a retry from here cannot fix.
   */
  | "kill_not_owned";

/**
 * What the controller REPORTS when a close attempt fails.
 *
 * A discriminated union rather than a bare failure code, because the phase is
 * derived from it and the two after-commit failures carry something the
 * before-commit ones cannot have: the shells a retry still has to end. Passing
 * outstanding ids with `persist_refused` is not expressible, so the state
 * machine cannot be put into the combination that caused the defect.
 */
export type WorkspaceCloseFailureReport =
  | { readonly failure: "persist_unreachable" | "persist_refused" }
  | {
      readonly failure: "kill_incomplete" | "kill_not_owned";
      /**
       * Shells of the COMMITTED layout that the host did not prove ended. A
       * retry kills exactly these.
       */
      readonly outstandingKillIds: readonly string[];
    };

export interface WorkspaceCloseState {
  readonly phase: WorkspaceClosePhase;
  /** Set only in the two failed phases, and the notice is written from it. */
  readonly failure: WorkspaceCloseFailure | null;
  /**
   * Shells the last attempt could not prove ended.
   *
   * Non-empty only in `failed_after_commit`, where it is the retry's whole
   * work list. It lives in the phase rather than in a ref beside it for the
   * reason `discarded` lives here: a second holder of "what does this close
   * still owe" is a second source of truth for one lifecycle, and the two would
   * disagree the first time a retry landed while the phase moved.
   */
  readonly outstandingKillIds: readonly string[];
}

/**
 * What a close DID, as the caller that asked for it sees it.
 *
 * The Studio centre acts on this: only `ok` removes the project from the
 * kept-alive set. A failed close leaves the workspace mounted, which is the
 * whole point - the shells are still running and, before the commit, the layout
 * is still only in memory.
 */
export type WorkspaceCloseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: WorkspaceCloseFailure };

/**
 * What an admitted close attempt has to DO.
 *
 * The model decides it, because it is the same decision as the phase split and
 * deciding it twice is how the two would drift. The controller only performs
 * the steps it is handed.
 */
export type WorkspaceCloseWork =
  /** Commit the snapshot, then end every shell of the layout. */
  | { readonly kind: "commit_then_kill" }
  /**
   * The snapshot is ALREADY on disk and correct. End these shells and persist
   * NOTHING: a second commit would reconcile the layout against what is still
   * live and drop the terminals the first sweep already killed.
   */
  | { readonly kind: "finish_kills"; readonly terminalIds: readonly string[] };

/**
 * What a close REQUEST may do, decided here so the controller owns only the
 * mechanism.
 *
 * `join` is the second-close rule, and it replaces the take-once registration
 * that used to stand in for concurrency control. Take-once made a second
 * gesture arriving mid-persist find nothing and fall through to unmounting the
 * controller - tearing down the only owner of the layout while it was being
 * committed. A second caller must instead WAIT FOR THE SAME COMPLETION, and
 * that is a rule, so it is stated here; the promise it waits on is an effect,
 * so it lives in the controller.
 */
export type WorkspaceCloseAdmission =
  /** Start one. The state to publish and the work to do come with it. */
  | {
      readonly admitted: "begin";
      readonly state: WorkspaceCloseState;
      readonly work: WorkspaceCloseWork;
    }
  /** A close is already running. Await it and return its outcome. */
  | { readonly admitted: "join" }
  /** Nothing left to do; this is the answer. */
  | { readonly admitted: "settled"; readonly outcome: WorkspaceCloseOutcome };

export function openWorkspaceClose(): WorkspaceCloseState {
  return { phase: "open", failure: null, outstandingKillIds: [] };
}

const CLOSING: WorkspaceCloseState = {
  phase: "closing",
  failure: null,
  outstandingKillIds: [],
};

/**
 * May a close start, join, or is it already answered?
 *
 * Both failed phases admit a retry - nothing was destroyed in either - and they
 * differ in the WORK the retry is given. `failed_before_commit` re-runs the
 * whole close because no snapshot landed. `failed_after_commit` finishes the
 * outstanding kills and never persists again, because the snapshot that landed
 * is the correct one and any further write would be reconciled against a
 * half-killed workspace.
 *
 * `closed` and `discarded` answer `ok`. Both are terminal and neither leaves
 * work for a caller: after `closed` the snapshot is committed and the shells
 * are ended, and after `discarded` the project no longer exists. Reporting a
 * failure for either would keep a workspace mounted for a project that has
 * nothing left to close.
 */
export function beginClose(state: WorkspaceCloseState): WorkspaceCloseAdmission {
  if (state.phase === "closing") return { admitted: "join" };
  if (state.phase === "closed" || state.phase === "discarded") {
    return { admitted: "settled", outcome: { ok: true } };
  }
  if (state.phase === "failed_after_commit") {
    return {
      admitted: "begin",
      state: CLOSING,
      work: { kind: "finish_kills", terminalIds: state.outstandingKillIds },
    };
  }
  return { admitted: "begin", state: CLOSING, work: { kind: "commit_then_kill" } };
}

/** The snapshot is on disk and every shell is ended. */
export function closeCommitted(state: WorkspaceCloseState): WorkspaceCloseState {
  if (state.phase === "discarded") return state;
  return { phase: "closed", failure: null, outstandingKillIds: [] };
}

/**
 * The close did not finish. The workspace goes back to being usable.
 *
 * THE PHASE IS DERIVED FROM THE FAILURE, and that derivation is the fix: a
 * persist failure means no snapshot landed, a kill failure means one did. The
 * caller cannot report the wrong side of the commit because it does not choose
 * the phase.
 *
 * A delete that landed mid-close OUTRANKS the failure: `discarded` is about the
 * project existing at all, and reporting a retryable close for a project that
 * is gone would invite a retry that writes a snapshot for a deleted project.
 */
export function closeFailed(
  state: WorkspaceCloseState,
  report: WorkspaceCloseFailureReport,
): WorkspaceCloseState {
  if (state.phase === "discarded") return state;
  switch (report.failure) {
    case "persist_unreachable":
    case "persist_refused":
      return {
        phase: "failed_before_commit",
        failure: report.failure,
        outstandingKillIds: [],
      };
    case "kill_incomplete":
    case "kill_not_owned":
      return {
        phase: "failed_after_commit",
        failure: report.failure,
        outstandingKillIds: [...report.outstandingKillIds],
      };
  }
}

/**
 * THE PROJECT IS GONE. Suppress every write from every phase.
 *
 * Reachable from any phase, including `closing`: a delete can commit while a
 * close is mid-flight, and the delete is the authority.
 */
export function discardWorkspace(): WorkspaceCloseState {
  return { phase: "discarded", failure: null, outstandingKillIds: [] };
}

/**
 * May a BACKGROUND persist run - the debounce, the visibility flush, the
 * unmount flush?
 *
 * Not during `closing`: the close writes the one snapshot that carries the
 * buffers, and the host reconciles a layout against what is LIVE, so a second
 * write landing after the kills would put an emptier snapshot over it. Not
 * after `closed`, nor in `failed_after_commit`, for exactly that reason - in
 * the second case some shells are already gone, so a write now is guaranteed
 * to drop them. Not in `discarded`, where the file must stay deleted.
 *
 * `failed_before_commit` is the one failure that still WANTS a write: nothing
 * was killed and nothing was saved, so the workspace is an ordinary live
 * workspace whose layout belongs on disk.
 *
 * The close's OWN commit does not ask this: it is the write this predicate
 * exists to protect.
 */
export function admitsPersist(state: WorkspaceCloseState): boolean {
  return state.phase === "open" || state.phase === "failed_before_commit";
}

/**
 * May a new terminal be created into this workspace?
 *
 * Refused wherever it could produce a shell that no snapshot and no kill set
 * can reach. During `closing` that is sharp: a create admitted then resolves
 * AFTER the close captured the layout it is about to commit, so the new pty is
 * in no snapshot and in no kill set - an orphan shell holding a lease and a
 * host slot that nothing can ever release. Refusing at admission is half the
 * fence; the other half is in the controller, where a create already in flight
 * when `closing` began hands its pty to the close's own sweep.
 *
 * `failed_after_commit` refuses for the same reason with the timing reversed:
 * the snapshot is committed and no further persist may run, so a terminal
 * opened there could never be saved, and the retry - which only finishes the
 * outstanding kills - would not end it either.
 *
 * `failed_before_commit` admits, because nothing happened: the workspace is
 * live, its layout still persists, and the user may keep working in it.
 */
export function admitsTerminalCreate(state: WorkspaceCloseState): boolean {
  return state.phase === "open" || state.phase === "failed_before_commit";
}

/**
 * Is a close RUNNING right now?
 *
 * The controller's late-create fence asks this to decide WHO ends a pty that
 * arrived too late: a running close is already awaiting that create and will
 * sweep the pty with an outcome check, while in every other phase there is no
 * such owner and the create must end its own terminal.
 */
export function closeInFlight(state: WorkspaceCloseState): boolean {
  return state.phase === "closing";
}

/**
 * Did the last close attempt FAIL, on either side of the commit?
 *
 * What the notice renders from: both phases mean the user asked for something,
 * it did not happen, and a retry is available.
 */
export function closeIsFailed(state: WorkspaceCloseState): boolean {
  return (
    state.phase === "failed_before_commit" || state.phase === "failed_after_commit"
  );
}

/**
 * Does this refusal PROVE the pty is gone?
 *
 * A kill asks for one thing: that the shell stop running. `unknown_terminal`
 * says main holds no record of it, which is that outcome and not a failure -
 * and it is the ordinary case rather than an edge one, because a pty the user
 * exited themselves leaves its pane in place (the exit code is what they came
 * back to read) while main forgot the record the moment the exit arrived.
 * Treating it as a failure would make every close of a workspace with one
 * exited tab fail, forever, with no retry that could ever succeed.
 *
 * `foreign_terminal` is NOT such a proof, and reading it as one was a defect.
 * The host's own contract says the opposite: `PtyHostService.owned` returns
 * `unknown_terminal` when it holds no record and `foreign_terminal` when it
 * holds one owned by a DIFFERENT window, and its doc states the difference
 * plainly - "the first says the terminal is gone and the UI should forget it,
 * the second says the caller asked about someone else's and the UI should not".
 * A `foreign_terminal` answer therefore means the shell EXISTS and is running.
 * It also means this window's own bookkeeping is wrong, since it asked to kill
 * a terminal it believed it owned, so the close fails with `kill_not_owned`
 * rather than reporting a success that would unmount the workspace and leave a
 * live shell behind it. Every other code likewise leaves a shell that may still
 * be running.
 */
export function killProvedGone(code: TerminalErrorCode): boolean {
  return code === "unknown_terminal";
}
