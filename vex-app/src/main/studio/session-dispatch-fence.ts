/**
 * THE STUDIO DISPATCH FENCE STATE, owned in one place.
 *
 * Three facts decide whether this process may let a Studio action be queued or
 * dispatched, and all three are written by the secret session's lock and unlock
 * paths: a durable generation advance that did NOT commit, a session transition
 * that is still in flight, and a durable refusal sweep this process still owes.
 * They used to live as five module bindings inside `secrets/session.ts`
 * alongside the vault, the keystore-password provider and the env scrub, which
 * put two unrelated lifecycles in one file: credentials, and a fence with a
 * timer.
 *
 * This module owns the STATE and the TIMER; the secret session owns what the
 * recovery pass actually DOES (the generation advance and the refusal write,
 * both of which reach the engine and the vault session) and what an
 * all-clear MEANS for MCP admission, which depends on the session being
 * unlocked. That split is why the recovery pass is handed in as an argument
 * rather than imported: an import in that direction would close a cycle back
 * into the session this fence exists to serve.
 *
 * ## The POISON, and why a failed advance is not a shrug
 *
 * The durable dispatch generation is the fence: a queued Studio action may only
 * dispatch while the generation it recorded at enqueue is still current, so a
 * lock or an unlock ADVANCES it and every intent from before is refused. That
 * works exactly as long as the advance commits.
 *
 * When it does not - PostgreSQL is down while the user locks Vex - the old
 * generation stays current. The lock still scrubs and still revokes signing, so
 * nothing can be signed; but once the database comes back, a pre-lock intent's
 * recorded generation matches again and its slot claim would succeed. The fence
 * silently never moved.
 *
 * So a failed advance POISONS the runtime: no new Studio approval may be queued
 * (`isStudioRuntimeAvailable` in `studio/approval-service.ts`), and no approved
 * Studio intent may dispatch (the engine's dispatch preflight, registered in
 * `agent/studio-settlement-bridge.ts`). Only a SUCCESSFUL advance clears it,
 * and a bounded retry keeps trying so recovery does not wait for the user's
 * next lock or unlock.
 */

import { log } from "../logger/index.js";

/**
 * WHY the session is being locked, as a TRUSTED value.
 *
 * The two causes write DIFFERENT durable audit rows and must not be confused:
 * a user locking Vex is `lock`, and the application leaving is `vex_quit`. The
 * quit hooks used to call the lock with the default, so a quit stamped `lock`
 * on every pending Studio intent it happened to reach first, racing the ordered
 * quit cleanup's own `vex_quit` pass for the same rows. One caller, one cause,
 * threaded all the way to `approval_intents.refusal_reason` and to the cause
 * each blocked MCP call is told.
 */
export type SecretSessionLockCause = "lock" | "vex_quit";

/** The recovery pass the session owns; this module only schedules it. */
type StudioFenceRecoveryPass = () => Promise<void>;

let studioGenerationPoisoned = false;
/**
 * Synchronous authority transition. Set before lock or unlock reaches its
 * first await and cleared only by a committed generation advance. It closes
 * the non-signing dispatch window that secret scrubbing alone cannot close.
 */
let studioSessionTransitionInProgress = false;
/**
 * A lock/quit refusal sweep that has not yet committed. The typed cause is
 * retained verbatim so a recovery pass writes the same durable audit fact.
 */
let studioPendingRefusalCause: SecretSessionLockCause | null = null;
let studioPoisonRetryTimer: NodeJS.Timeout | null = null;
/**
 * SINGLE-FLIGHT for the retry. An advance is a database round trip that can
 * take longer than the retry interval when the database is the thing that is
 * unwell; without this, a slow database would accumulate one concurrent
 * advance per tick, each writing the same monotonic row.
 */
let studioPoisonRetryInFlight = false;

/** Bounded retry cadence while poisoned. Short: this blocks real work. */
const STUDIO_POISON_RETRY_MS = 12_000;

/**
 * Can Vex currently prove its Studio lock fence?
 *
 * Read by the enqueue predicate and by the engine's dispatch preflight. `true`
 * means an advance failed and no later advance has succeeded, so both refuse.
 */
export function isStudioDispatchPoisoned(): boolean {
  return (
    studioGenerationPoisoned
    || studioSessionTransitionInProgress
    || studioPendingRefusalCause !== null
  );
}

/** Main-side preflight fact, exported so dispatch checks it explicitly. */
export function isStudioSessionTransitionInProgress(): boolean {
  return studioSessionTransitionInProgress;
}

/** Test and readiness seam for the durable refusal-repair obligation. */
export function hasPendingStudioRefusalRepair(): boolean {
  return studioPendingRefusalCause !== null;
}

/** The exact typed cause a still-owed refusal sweep must write. */
export function pendingStudioRefusalCause(): SecretSessionLockCause | null {
  return studioPendingRefusalCause;
}

/**
 * Whether the recovery pass still owes a GENERATION advance, as opposed to a
 * refusal write. The two obligations are cleared independently: a successful
 * advance never erases a pending refusal, and a successful refusal never
 * pretends a failed generation moved.
 */
export function needsStudioGenerationAdvance(): boolean {
  return studioGenerationPoisoned || studioSessionTransitionInProgress;
}

/**
 * Stop the retry timer. Owned by the ordered quit cleanup; idempotent, so a
 * second quit hook or a test teardown is safe.
 */
export function disposeStudioDispatchPoisonRetry(): void {
  if (studioPoisonRetryTimer === null) return;
  clearInterval(studioPoisonRetryTimer);
  studioPoisonRetryTimer = null;
}

/** Test seam: forget the poison and its timer between cases. */
export function resetStudioDispatchPoisonForTests(): void {
  disposeStudioDispatchPoisonRetry();
  studioGenerationPoisoned = false;
  studioSessionTransitionInProgress = false;
  studioPendingRefusalCause = null;
  studioPoisonRetryInFlight = false;
}

/**
 * The fence is UNPROVEN: refuse queueing and dispatch, and start the bounded
 * recovery. Announced once per poisoned stretch rather than per failure.
 */
export function poisonStudioDispatch(recoveryPass: StudioFenceRecoveryPass): void {
  const wasPoisoned = studioGenerationPoisoned;
  studioGenerationPoisoned = true;
  if (!wasPoisoned) {
    log.warn(
      "[secrets-session] studio dispatch fence UNPROVEN: queueing and dispatch "
        + "are refused until an advance succeeds",
    );
  }
  ensureStudioRecoveryTimer(recoveryPass);
}

export function ensureStudioRecoveryTimer(
  recoveryPass: StudioFenceRecoveryPass,
): void {
  if (studioPoisonRetryTimer !== null) return;
  studioPoisonRetryTimer = setInterval(() => {
    if (studioPoisonRetryInFlight) return;
    studioPoisonRetryInFlight = true;
    void recoveryPass().finally(() => {
      studioPoisonRetryInFlight = false;
    });
  }, STUDIO_POISON_RETRY_MS);
  // The retry must never hold the process open by itself.
  studioPoisonRetryTimer.unref?.();
}

/**
 * A generation advance COMMITTED. Clears the poison and the transition, and
 * stops the recovery when nothing else is outstanding. Reopening MCP admission
 * belongs to the session, which owns the other half of that question.
 */
export function clearStudioGenerationPoison(): void {
  if (studioGenerationPoisoned) {
    log.info("[secrets-session] studio dispatch fence proven again");
  }
  studioGenerationPoisoned = false;
  studioSessionTransitionInProgress = false;
  stopStudioRecoveryWhenClear();
}

export function beginStudioSessionTransition(): void {
  studioSessionTransitionInProgress = true;
}

export function cancelStudioSessionTransition(): void {
  studioSessionTransitionInProgress = false;
  stopStudioRecoveryWhenClear();
}

export function stopStudioRecoveryWhenClear(): void {
  if (!isStudioDispatchPoisoned()) {
    disposeStudioDispatchPoisonRetry();
  }
}

/**
 * Record the obligation to refuse pending intents durably, and answer with the
 * cause that must actually be written.
 *
 * Quit is the terminal and more specific transition. A user-lock cleanup
 * already in flight must never overwrite it with the weaker earlier cause.
 */
export function retainPendingRefusalCause(
  cause: SecretSessionLockCause,
): SecretSessionLockCause {
  if (studioPendingRefusalCause === "vex_quit" || cause === "vex_quit") {
    studioPendingRefusalCause = "vex_quit";
  } else {
    studioPendingRefusalCause = "lock";
  }
  return studioPendingRefusalCause;
}

/**
 * A refusal sweep COMMITTED. Cleared only when the obligation is still the one
 * that was written: a quit that escalated the cause while the sweep ran leaves
 * its own stronger obligation standing.
 */
export function clearPendingRefusalCause(
  written: SecretSessionLockCause,
): void {
  if (studioPendingRefusalCause === written) {
    studioPendingRefusalCause = null;
  }
}
