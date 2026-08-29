/**
 * The Vex Studio PROJECT DISPATCH-LEASE REGISTRY - one slot, one owner, ZERO
 * imports.
 *
 * ## What it is for
 *
 * `main/studio/project-lifecycle-gate.ts` counts the work a project has in
 * flight IN THIS PROCESS, so a delete can wait for it instead of committing a
 * tombstone while something is mid-execution. Two of its lease classes are
 * DRAINED: `executingCall`, which `runStudioCall` holds, and `dispatch`, which
 * is what an APPROVED action holds while it runs.
 *
 * The dispatch, however, happens in the ENGINE
 * (`post-tx/dispatch-approved/studio.ts`), and the gate is main's property: it
 * is main that owns the delete, the admission close and the drain. An engine
 * module cannot import it without dragging main into a headless engine's graph.
 * So main REGISTERS an acquirer here and the engine asks for a lease through it,
 * exactly as it already does for the dispatch preflight
 * (`dispatch-preflight.ts`) - and for the same reason that file has no imports:
 * the registration must be synchronous and infallible, because a dynamic import
 * would leave a window in which a dispatch ran uncounted.
 *
 * ## THIS IS NOT AN AUTHORITY CHECK, and must never become one
 *
 * A `null` answer means "no lease" - either nobody registered an acquirer (a
 * headless engine, which has no delete to race) or the project's admission is
 * closed. Neither is permission to stop: whether an approved action may run is
 * decided durably, by the tombstone re-check inside `runStudioDispatchGate`,
 * under the session control lock that serializes it against the delete
 * transaction. Refusing here as well would put a second, in-memory, unprovable
 * copy of that decision on the money path, which the lifecycle gate's own
 * header explicitly forbids.
 *
 * What the lease buys is the other half, which no query can answer: while it is
 * held, a concurrent delete's drain WAITS, so the ordinary case never reaches
 * the durable refusal at all.
 */

/** A held dispatch lease. `release` must be idempotent. */
export interface StudioProjectDispatchLease {
  readonly release: () => void;
}

/**
 * Take a `dispatch` lease on a project, SYNCHRONOUSLY, or answer `null`.
 *
 * Synchronous by contract: a lease acquired after an await describes a moment
 * that has already passed, and the drain it is supposed to hold open may have
 * completed in the gap.
 */
export type StudioProjectLeaseAcquirer = (
  projectId: string,
) => StudioProjectDispatchLease | null;

let registered: StudioProjectLeaseAcquirer | null = null;

/**
 * Install the acquirer, or clear it with `null`.
 *
 * Last writer wins, on purpose: main installs it at bridge setup and clears it
 * at teardown. Those are two points in ONE owner's lifecycle.
 */
export function setStudioProjectLeaseAcquirer(
  acquirer: StudioProjectLeaseAcquirer | null,
): void {
  registered = acquirer;
}

/**
 * Ask for a lease. `null` whenever one cannot be had, for ANY reason - no
 * registered owner, no project id on the row, admission closed, or an acquirer
 * that threw.
 *
 * A throwing acquirer is contained rather than propagated: this sits on the
 * approved-dispatch path, and an exception from an accounting call must not be
 * able to abort an action a human already authorized.
 */
export function acquireStudioDispatchLease(
  projectId: string | null,
): StudioProjectDispatchLease | null {
  if (projectId === null) return null;
  const acquirer = registered;
  if (acquirer === null) return null;
  try {
    return acquirer(projectId);
  } catch {
    return null;
  }
}
