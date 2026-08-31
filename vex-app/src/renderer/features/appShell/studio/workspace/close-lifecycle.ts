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
 * ## The five phases
 *
 *   open       nothing is closing. Terminals may be created, layout may persist.
 *   closing    ADMISSION IS SHUT. No new terminal, no background persist. The
 *              close is committing the snapshot and then ending the shells.
 *   failed     the commit or the kills did not succeed. NOTHING WAS DESTROYED:
 *              the workspace stays mounted and fully usable, the user is told
 *              what happened, and a retry re-enters `closing`.
 *   closed     the snapshot is on disk and the shells are ended. Terminal.
 *   discarded  THE PROJECT IS GONE - deleted, its tombstone committed and its
 *              snapshot removed by main's own cleanup.
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
  | "failed"
  | "closed"
  | "discarded";

/**
 * Why a close did not finish.
 *
 * Three, because the user's next action differs for each and because the first
 * two mean the buffers were NOT saved while the third means they were.
 */
export type WorkspaceCloseFailure =
  /** The persist call itself did not reach main. */
  | "persist_unreachable"
  /** Main or the host REFUSED the commit. The snapshot on disk is unchanged. */
  | "persist_refused"
  /** The snapshot committed, but at least one shell could not be ended. */
  | "kill_incomplete";

export interface WorkspaceCloseState {
  readonly phase: WorkspaceClosePhase;
  /** Set only in `failed`, and it is what the notice is written from. */
  readonly failure: WorkspaceCloseFailure | null;
}

/**
 * What a close DID, as the caller that asked for it sees it.
 *
 * The Studio centre acts on this: only `ok` removes the project from the
 * kept-alive set. A failed close leaves the workspace mounted, which is the
 * whole point - the shells are still running and the layout is still only in
 * memory.
 */
export type WorkspaceCloseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: WorkspaceCloseFailure };

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
  /** Start one. The state to publish comes with it. */
  | { readonly admitted: "begin"; readonly state: WorkspaceCloseState }
  /** A close is already running. Await it and return its outcome. */
  | { readonly admitted: "join" }
  /** Nothing left to do; this is the answer. */
  | { readonly admitted: "settled"; readonly outcome: WorkspaceCloseOutcome };

export function openWorkspaceClose(): WorkspaceCloseState {
  return { phase: "open", failure: null };
}

const CLOSING: WorkspaceCloseState = { phase: "closing", failure: null };

/**
 * May a close start, join, or is it already answered?
 *
 * `failed` admits a retry: nothing was destroyed, so re-entering `closing` is
 * exactly what the user's second click should mean.
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
  return { admitted: "begin", state: CLOSING };
}

/** The snapshot is on disk and every shell is ended. */
export function closeCommitted(state: WorkspaceCloseState): WorkspaceCloseState {
  if (state.phase === "discarded") return state;
  return { phase: "closed", failure: null };
}

/**
 * The close did not finish. The workspace goes back to being usable.
 *
 * A delete that landed mid-close OUTRANKS the failure: `discarded` is about the
 * project existing at all, and reporting a retryable close for a project that
 * is gone would invite a retry that writes a snapshot for a deleted project.
 */
export function closeFailed(
  state: WorkspaceCloseState,
  failure: WorkspaceCloseFailure,
): WorkspaceCloseState {
  if (state.phase === "discarded") return state;
  return { phase: "failed", failure };
}

/**
 * THE PROJECT IS GONE. Suppress every write from every phase.
 *
 * Reachable from any phase, including `closing`: a delete can commit while a
 * close is mid-flight, and the delete is the authority.
 */
export function discardWorkspace(): WorkspaceCloseState {
  return { phase: "discarded", failure: null };
}

/**
 * May a BACKGROUND persist run - the debounce, the visibility flush, the
 * unmount flush?
 *
 * Not during `closing`: the close writes the one snapshot that carries the
 * buffers, and the host reconciles a layout against what is LIVE, so a second
 * write landing after the kills would put an empty snapshot over it. Not after
 * `closed`, for the same reason. Not in `discarded`, where the file must stay
 * deleted.
 *
 * The close's OWN commit does not ask this: it is the write this predicate
 * exists to protect.
 */
export function admitsPersist(state: WorkspaceCloseState): boolean {
  return state.phase === "open" || state.phase === "failed";
}

/**
 * May a new terminal be created into this workspace?
 *
 * The same two phases, and for a sharper reason. A create admitted during
 * `closing` resolves AFTER the close captured the layout it is about to
 * commit, so the new pty is in no snapshot and in no kill set: an orphan shell
 * for a workspace that is gone, holding a lease and a host slot that nothing
 * can ever release. Refusing at admission is half the fence; the other half is
 * in the controller, where a create already in flight when `closing` began
 * kills its own pty at publication.
 */
export function admitsTerminalCreate(state: WorkspaceCloseState): boolean {
  return state.phase === "open" || state.phase === "failed";
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
 * `foreign_terminal` is the same shape of answer from the other direction: this
 * window does not own it, so this window is not the one that ends it, and
 * blocking the close on a shell it has no authority over would strand the
 * workspace. Every other code leaves the shell possibly still running, which is
 * `kill_incomplete`.
 */
export function killProvedGone(code: TerminalErrorCode): boolean {
  return code === "unknown_terminal" || code === "foreign_terminal";
}
