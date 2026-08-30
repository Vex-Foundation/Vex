/**
 * THE PROJECT LIFECYCLE GATE: in-process admission and leases, per project.
 *
 * ## What this is for, and what it is NOT a source of truth for
 *
 * The `projects.deleted_at` tombstone is the AUTHORITY. Every gate that decides
 * whether an action may run reads it from the database, inside the transaction
 * that matters, and nothing here can override that. This module answers a
 * different question, one the tombstone cannot: **is work already in flight in
 * THIS process right now, and can I stop admitting more of it?**
 *
 * That distinction is why both exist. A delete that only wrote the tombstone
 * would commit while a full-permission MCP call was mid-execution, and the
 * call's own later gates would refuse it - correctly, but after the user was
 * told the project was gone and while the call was still running. A delete that
 * only closed admission would prove nothing durable at all. So:
 *
 *   - admission + leases (here)  -> "nothing NEW starts, and I can wait for
 *                                    what already started"
 *   - `deleted_at` (Postgres)    -> "nothing is AUTHORIZED, ever again"
 *
 * The gate is deliberately not consulted to decide authority anywhere.
 *
 * ## Lease classes
 *
 * Six, because they drain differently and that difference is the whole design:
 *
 *   - `executingCall`   an MCP call running inside `runStudioCall`.
 *   - `dispatch`        an approved action claimed for dispatch.
 *   - `pendingApproval` a call PARKED waiting for a human decision.
 *   - `render`          an installer job writing this project's artifacts.
 *   - `watcher`         a filesystem watcher (consumer arrives in a later stage).
 *   - `terminal`        an open terminal session, taken by `terminals.ts`.
 *
 * `executingCall` and `dispatch` are DRAINED: they are bounded by their own
 * work and will finish. `pendingApproval` is PARKED and never drained, because
 * a parked approval releases only when it is settled, and the settlement that
 * releases it is the refusal the delete transaction itself commits. Draining it
 * first would mean waiting for an event that the wait is blocking - a deadlock,
 * and the reason the two are separate classes rather than one "busy" counter.
 *
 * A call MOVES BETWEEN THE FIRST TWO AND THE THIRD during its life, and that
 * movement is `reclassifyProjectLease`. `runStudioCall` takes `executingCall`
 * up front; the instant its tool result says `pendingApproval` it reclassifies
 * to `pendingApproval`, and when the broker releases it moves back. Without
 * that move the split is decorative: the call that parks is exactly the call
 * still counted as executing, so the drain waits for it, times out, and the
 * delete reports `blocked_active_calls` for work that will never finish. The
 * `dispatch` class has the mirror-image owner on the engine side, reached
 * through the main-registered acquirer in
 * `engine/core/approval-runtime/studio/project-lease-registry.ts`.
 *
 * `terminal` HAS a consumer: `terminals.ts` takes one per terminal it opens and
 * registers the close hook that step 6 of a delete runs, so a project delete
 * closes that project's shells after its tombstone has committed.
 *
 * `watcher` still has none. It is defined now because the delete ORDER has to
 * reserve a place for closing it (step 6), and a class added later would
 * silently not be closed by deletes shipped before it.
 *
 * ## Bounds and ownership
 *
 * One entry per project id, created on first acquisition and DELETED when its
 * last lease is released and admission is open - so an idle process holds
 * nothing. A tombstone's entry is retained while admission stays closed,
 * because "closed" is exactly the fact that must not be forgotten.
 *
 * Every acquisition returns an idempotent release. Callers take a lease
 * SYNCHRONOUSLY, before their first await; a lease taken after an await
 * describes a moment that has already passed.
 *
 * This is process-local by design. A second Vex process cannot see these
 * leases, which is correct: it also cannot be running this process's calls. The
 * durable half of the answer is the tombstone.
 */

import { log } from "../logger/index.js";

/** The classes of in-flight work a project can own. */
export type ProjectLeaseClass =
  | "executingCall"
  | "dispatch"
  | "pendingApproval"
  | "render"
  | "watcher"
  | "terminal"
  | "terminalCreate";

/**
 * The classes a delete WAITS for. Bounded work that finishes on its own.
 *
 * `pendingApproval` is deliberately absent - see the module doc.
 *
 * `terminalCreate` is present and `terminal` is not, and the difference is the
 * whole reason they are two classes. An OPEN terminal is unbounded work: it
 * lives until the user closes it, so a delete that waited for one would wait
 * forever - that is what step 6's close hook is for. A terminal being CREATED
 * is bounded: it resolves a cwd, asks the host to spawn, and finishes. Before
 * this split an in-flight create was invisible to the delete - it held no lease
 * yet and no record yet - so a create that started before the tombstone could
 * insert a live terminal for a project that had already been deleted, after the
 * close hook had already run and found nothing.
 */
export const DRAINED_LEASE_CLASSES: readonly ProjectLeaseClass[] = [
  "executingCall",
  "dispatch",
  "terminalCreate",
];

/**
 * A held lease. `release` is idempotent.
 *
 * The type is structural, so it does not by itself prove a handle came from
 * this gate. `release` needs no such proof - it is a CLOSURE over the entry the
 * acquisition created, so a hand-built object's `release` is simply its own
 * function and can never reach these counters. `reclassifyProjectLease` is the
 * one operation that takes a handle as an ARGUMENT, so it is the one that
 * checks; see `issuedLeases`.
 */
export interface ProjectLease {
  readonly release: () => void;
  /** The class this lease is currently counted under. Moves on reclassification. */
  readonly leaseClass: ProjectLeaseClass;
}

/**
 * What a reclassification did.
 *
 * `released` is not an error: a lease whose owner already released it (a
 * cancellation racing the transition) has nothing to move, and the caller's
 * correct response is to carry on, not to throw on the approval path.
 *
 * `unknown_handle` is the refusal for an object this module did not issue. It
 * is separate from `released` because the two mean opposite things: `released`
 * says "your lease is finished, carry on", while `unknown_handle` says "that
 * was never a lease" - a caller bug or a forgery, and the counters were not
 * touched.
 */
export type ProjectLeaseReclassification =
  | "reclassified"
  | "unchanged"
  | "released"
  | "unknown_handle";

/**
 * The answer to an acquisition request.
 *
 * `project_deleting` is a TYPED refusal, not an exception: a call that arrives
 * during a delete has not failed, it has been declined, and the caller renders
 * that differently.
 */
export type ProjectLeaseOutcome =
  | { readonly ok: true; readonly lease: ProjectLease }
  | { readonly ok: false; readonly reason: "project_deleting" };

/**
 * The ADMINISTRATIVE token.
 *
 * Cleanup runs AFTER admission has been closed permanently for a tombstone, and
 * it needs a render lease to do its work - the very thing admission now
 * refuses. Rather than reopening admission (which would also readmit ordinary
 * calls, the exact thing the close exists to prevent), the deleting owner holds
 * an opaque token that bypasses the admission check and nothing else.
 *
 * It is an object identity, not a string or a boolean, so it cannot be forged
 * by a caller that merely guessed a value, and it is never serialized.
 */
export interface ProjectDeletionToken {
  readonly projectId: string;
}

interface ProjectEntry {
  admitting: boolean;
  readonly counts: Map<ProjectLeaseClass, number>;
  /** Resolvers waiting for the drained classes to reach zero. */
  readonly drainWaiters: Set<() => void>;
  token: ProjectDeletionToken | null;
}

const entries = new Map<string, ProjectEntry>();

function entryFor(projectId: string): ProjectEntry {
  const existing = entries.get(projectId);
  if (existing !== undefined) return existing;
  const created: ProjectEntry = {
    admitting: true,
    counts: new Map(),
    drainWaiters: new Set(),
    token: null,
  };
  entries.set(projectId, created);
  return created;
}

function held(entry: ProjectEntry, leaseClass: ProjectLeaseClass): number {
  return entry.counts.get(leaseClass) ?? 0;
}

function drainedCount(entry: ProjectEntry): number {
  let total = 0;
  for (const leaseClass of DRAINED_LEASE_CLASSES) {
    total += held(entry, leaseClass);
  }
  return total;
}

/** Drop an entry that holds nothing and is not carrying a closed admission. */
function collect(projectId: string, entry: ProjectEntry): void {
  if (!entry.admitting) return;
  if (entry.drainWaiters.size > 0) return;
  for (const count of entry.counts.values()) {
    if (count > 0) return;
  }
  entries.delete(projectId);
}

/**
 * Take a lease, SYNCHRONOUSLY.
 *
 * Refuses with `project_deleting` once admission is closed, unless the caller
 * presents this project's administrative token.
 */
export function acquireProjectLease(
  projectId: string,
  leaseClass: ProjectLeaseClass,
  token?: ProjectDeletionToken,
): ProjectLeaseOutcome {
  const entry = entryFor(projectId);
  const administrative =
    token !== undefined && entry.token !== null && token === entry.token;
  if (!entry.admitting && !administrative) {
    collect(projectId, entry);
    return { ok: false, reason: "project_deleting" };
  }

  entry.counts.set(leaseClass, held(entry, leaseClass) + 1);
  const handle: MutableLease = {
    projectId,
    current: leaseClass,
    released: false,
    get leaseClass(): ProjectLeaseClass {
      return handle.current;
    },
    release: (): void => {
      if (handle.released) return;
      handle.released = true;
      const owner = entries.get(projectId);
      if (owner === undefined) return;
      decrement(owner, handle.current);
      wakeIfDrained(owner);
      collect(projectId, owner);
    },
  };
  issuedLeases.add(handle);
  return { ok: true, lease: handle };
}

/** The private, mutable half of a lease handle. Never exported. */
interface MutableLease extends ProjectLease {
  readonly projectId: string;
  current: ProjectLeaseClass;
  released: boolean;
}

/**
 * THE HANDLES THIS MODULE ISSUED, and the only ones `reclassifyProjectLease`
 * will act on.
 *
 * `ProjectLease` is a STRUCTURAL public type, so any object with a `release`
 * and a `leaseClass` satisfies it, and reclassification reaches the private
 * `MutableLease` fields by narrowing. Without this registry, a caller that
 * passed a hand-built object - by mistake or by design - would name an
 * arbitrary `projectId` and `current`, and the gate would obediently decrement
 * a class the object never held. That corrupts the very counters a delete's
 * drain waits on, so a wrong count here is a delete that hangs or a delete that
 * proceeds over live work.
 *
 * A `WeakSet` rather than a brand property because it cannot be copied onto a
 * forgery, and it holds no strong reference: a handle whose owner dropped it is
 * collected exactly as before. Membership is never removed on release - a
 * released handle is still one we issued, and `released` is the field that
 * answers that question.
 */
const issuedLeases = new WeakSet<ProjectLease>();

function decrement(entry: ProjectEntry, leaseClass: ProjectLeaseClass): void {
  entry.counts.set(leaseClass, Math.max(0, held(entry, leaseClass) - 1));
}

function wakeIfDrained(entry: ProjectEntry): void {
  if (drainedCount(entry) !== 0) return;
  for (const waiter of [...entry.drainWaiters]) waiter();
}

/**
 * Move a HELD lease from one class to another, SYNCHRONOUSLY and atomically.
 *
 * This exists because a Studio call is not one kind of work for its whole life.
 * It starts as `executingCall` - bounded work a delete may wait for - and the
 * moment its tool result comes back saying `pendingApproval`, it becomes the
 * one thing a delete must NOT wait for: a call parked on a human decision that
 * only the delete's own refusal will release. Holding `executingCall` across
 * that park is the deadlock the class split exists to prevent, so the call
 * moves itself, and moves back when the approval is granted and execution
 * resumes.
 *
 * ## Why it takes the lease handle rather than (projectId, from, to)
 *
 * A `from` argument is a fact the caller has to restate, and a caller that
 * restates it wrongly silently corrupts two counters at once. The handle
 * already knows its project and its current class, so the transition cannot be
 * mis-addressed. The brief's four-argument shape is the same operation with one
 * more way to get it wrong.
 *
 * ## Atomicity, and the wake
 *
 * The decrement and the increment happen in the same synchronous statement
 * pair, with no await between them, so no drain waiter and no `collect` can
 * observe the lease belonging to neither class. Drain waiters are woken only
 * when the drained total REACHES zero, which is exactly what
 * `executingCall -> pendingApproval` causes when this was the last executing
 * call: a delete blocked on the drain proceeds, which is the intended effect
 * and not an accident of ordering.
 *
 * The reverse move (`pendingApproval -> executingCall`) can only happen after a
 * human approved, and a delete that committed in the meantime has already
 * refused that intent, so the call never resumes. It therefore cannot resurrect
 * drained work behind a completed drain.
 *
 * `collect` is deliberately NOT called: the entry still holds this lease.
 *
 * ## The handle must be one WE issued
 *
 * The narrowing to `MutableLease` below is safe ONLY because `issuedLeases`
 * has already proven this object came out of `acquireProjectLease`; see that
 * registry's note for what an unchecked forgery would do to the drain
 * counters. A handle we did not issue is refused with `unknown_handle` and
 * changes nothing - the gate never throws at its callers, and the approval
 * path in particular must not gain a new failure mode from a bad argument.
 */
export function reclassifyProjectLease(
  lease: ProjectLease,
  to: ProjectLeaseClass,
): ProjectLeaseReclassification {
  if (!issuedLeases.has(lease)) {
    log.warn(
      "[studio:lifecycle] reclassify refused a lease handle this gate did not issue",
    );
    return "unknown_handle";
  }
  const handle = lease as MutableLease;
  if (handle.released) return "released";
  if (handle.current === to) return "unchanged";
  const entry = entries.get(handle.projectId);
  if (entry === undefined) {
    // The entry was collected out from under a live lease. That is a bug in
    // this module rather than a caller error, so it is logged and the lease is
    // left where it is instead of inventing a count on a fresh entry.
    log.warn(
      `[studio:lifecycle] reclassify found no entry projectId=${handle.projectId}`,
    );
    return "released";
  }
  decrement(entry, handle.current);
  entry.counts.set(to, held(entry, to) + 1);
  handle.current = to;
  wakeIfDrained(entry);
  return "reclassified";
}

/**
 * Stop admitting new work for this project and mint its administrative token.
 *
 * Idempotent: a repeated delete on an unfinished tombstone closes an already
 * closed gate and gets the SAME token back, so a resumed cleanup keeps working
 * under the identity the first attempt established.
 */
export function closeProjectAdmission(projectId: string): ProjectDeletionToken {
  const entry = entryFor(projectId);
  entry.admitting = false;
  entry.token ??= { projectId };
  return entry.token;
}

/**
 * Reopen admission after an ABANDONED delete.
 *
 * Called only when the delete decided not to proceed - the drain timed out, or
 * the caller cancelled before the transaction opened. Never called after the
 * tombstone commits: for a committed tombstone, closed is permanent.
 */
export function reopenProjectAdmission(projectId: string): void {
  const entry = entries.get(projectId);
  if (entry === undefined) return;
  entry.admitting = true;
  entry.token = null;
  collect(projectId, entry);
}

/** Is this project admitting new work? Exposed for the gate's own tests. */
export function isProjectAdmitting(projectId: string): boolean {
  return entries.get(projectId)?.admitting ?? true;
}

/** How many leases of a class are held. Exposed for tests and diagnostics. */
export function heldProjectLeases(
  projectId: string,
  leaseClass: ProjectLeaseClass,
): number {
  const entry = entries.get(projectId);
  return entry === undefined ? 0 : held(entry, leaseClass);
}

/** The outcome of waiting for the drained classes to empty. */
export type ProjectDrainOutcome =
  | { readonly drained: true }
  | { readonly drained: false; readonly remaining: number };

/**
 * Wait for `executingCall` and `dispatch` to reach zero, bounded by a deadline.
 *
 * Returns the REMAINING count on a timeout so the caller can tell the user how
 * many calls are still running rather than "it is busy". The timer is cleared
 * on every path, and the waiter is removed on every path, so a timed-out drain
 * leaves nothing registered.
 */
export async function drainProjectLeases(
  projectId: string,
  timeoutMs: number,
): Promise<ProjectDrainOutcome> {
  const entry = entryFor(projectId);
  if (drainedCount(entry) === 0) {
    collect(projectId, entry);
    return { drained: true };
  }

  let settle: (() => void) | null = null;
  const waiter = (): void => settle?.();
  entry.drainWaiters.add(waiter);

  let timer: NodeJS.Timeout | null = null;
  try {
    await new Promise<void>((resolve) => {
      settle = resolve;
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
    entry.drainWaiters.delete(waiter);
  }

  const remaining = drainedCount(entry);
  collect(projectId, entry);
  if (remaining > 0) {
    log.warn(
      `[studio:lifecycle] drain timed out projectId=${projectId} remaining=${String(remaining)}`,
    );
    return { drained: false, remaining };
  }
  return { drained: true };
}

/* ------------------------------------------------------------------ *
 * Step 6 of a delete: CLOSE what the project owns in this process
 * ------------------------------------------------------------------ */

/**
 * Owners that must close a project's resources once its tombstone has COMMITTED.
 *
 * A registry rather than a direct call from `project-delete.ts` because the
 * owners are process-local subsystems with their own lifetimes - the terminal
 * domain registers when the first terminal is created and unregisters when the
 * last one goes - and a delete must not import every one of them. The delete
 * order names step 6; this is where step 6 finds its work.
 *
 * IT RUNS AFTER THE COMMIT, NEVER BEFORE. Closing a user's terminals for a
 * delete that then fails its transaction would destroy work for a project that
 * still exists. The tombstone is the point of no return, so the closing follows
 * it.
 *
 * Each hook is awaited but never allowed to fail the delete: the authority
 * change already committed, and a subsystem that could not close cleanly is an
 * operator problem, not a reason to tell the user their delete did not happen.
 */
type ProjectCloseHook = (projectId: string) => Promise<void> | void;

const closeHooks = new Set<ProjectCloseHook>();

/** Register a close owner. Returns an idempotent unregister. */
export function registerProjectCloseHook(hook: ProjectCloseHook): () => void {
  closeHooks.add(hook);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    closeHooks.delete(hook);
  };
}

/** Run every close hook for a project whose tombstone has committed. */
export async function closeProjectResources(projectId: string): Promise<void> {
  for (const hook of [...closeHooks]) {
    try {
      await hook(projectId);
    } catch {
      log.warn(
        `[studio:lifecycle] a close hook failed projectId=${projectId}; continuing`,
      );
    }
  }
}

/** Test seam: forget every project's admission state and leases. */
export function resetProjectLifecycleGateForTests(): void {
  entries.clear();
  closeHooks.clear();
}
