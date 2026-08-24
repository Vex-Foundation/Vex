/**
 * The Vex Studio RUNTIME READINESS BARRIER.
 *
 * One flag with one owner, answering a single question: may this process let a
 * Studio action reach a dispatch yet?
 *
 * ## Why it exists
 *
 * Two things have to be true before a Studio call is safe in a freshly started
 * process, and neither is true at the moment main's modules load:
 *
 *   1. THE DISPATCH PREFLIGHT IS REGISTERED. It is the only reader of the one
 *      condition the durable fence cannot represent (a generation advance that
 *      never committed). The engine's default with nothing registered is ALLOW,
 *      which is correct for a headless engine that never had a main process and
 *      wrong for this one, where the registration is simply not done yet.
 *   2. THE STARTUP RECONCILER HAS FINISHED. It flips every row still marked
 *      `dispatching` to `indeterminate`, and terminally refuses every approved
 *      row still `not_started`, on the premise that this process is the only
 *      writer that could own them and it has just begun. A dispatch that begins
 *      WHILE that scan runs breaks the premise: its own fresh row is
 *      indistinguishable from an abandoned one, and the reconciler would settle
 *      a live call.
 *
 * So Studio is UNREADY until both hold, and unready is enforced in two places
 * that fail closed independently: `runStudioCall` refuses to queue anything,
 * and the registered preflight refuses every dispatch DURABLY. The preflight is
 * the one that matters for an approval that already exists, because a human can
 * approve one from the UI without any MCP call being involved.
 *
 * ## Fail closed, in both directions
 *
 * A preflight registration that fails leaves Studio unready for good (until a
 * retry succeeds): Vex cannot prove its fence, so it must not run approved
 * actions. Teardown makes it unready again rather than restoring the engine's
 * default, so a dispatch attempted during shutdown is refused durably instead
 * of being let through by an absent predicate.
 *
 * ## SHUTTING DOWN IS A ONE-WAY DOOR, and the EPOCH is what makes it one
 *
 * A bounded registration retry outlives the thing that scheduled it. Without a
 * generation token, a retry armed before teardown could land after it, call
 * `markStudioRuntimeReady`, and turn a shutting-down process back into one that
 * admits approved money-path dispatches - the single worst moment to open the
 * fence.
 *
 * So every transition into a ready or fence-failed state carries the EPOCH it
 * was started under, and `markStudioRuntimeShuttingDown` INVALIDATES the
 * current epoch. A late caller then holds a stale token, is ignored, and says
 * so in the log. The only way back to ready is a NEW lifecycle
 * (`beginStudioReadinessEpoch`), which is a fresh bridge setup and not a stale
 * timer.
 */

import { log } from "../logger/index.js";

/** Not ready, and the honest reason. Ready carries no reason at all. */
export type StudioReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly cause: string };

const STARTING_CAUSE =
  "Vex Studio is still starting, so this action was not queued. Nothing was "
  + "executed. Try again in a moment.";

const FENCE_CAUSE =
  "Vex Studio could not initialize its approval fence, so it did not queue "
  + "this action. Nothing was executed. Restart Vex and check that its local "
  + "database is running.";

const SHUTDOWN_CAUSE =
  "Vex is shutting down, so this action was not queued. Nothing was executed.";

let readiness: StudioReadiness = { ready: false, cause: STARTING_CAUSE };

/**
 * The generation of the CURRENT initialization. Monotonic, and never reset:
 * a token handed out before a teardown must stay distinguishable from every
 * token handed out after it, for the whole life of the process.
 */
let epoch = 0;

export function studioReadiness(): StudioReadiness {
  return readiness;
}

export function isStudioRuntimeReady(): boolean {
  return readiness.ready;
}

/**
 * Open a new initialization and return its token. Every later transition this
 * initialization performs must present it.
 *
 * Starting a new epoch also invalidates the previous one, so two overlapping
 * setups cannot both drive the flag.
 */
export function beginStudioReadinessEpoch(): number {
  epoch += 1;
  readiness = { ready: false, cause: STARTING_CAUSE };
  return epoch;
}

/** The epoch a caller must present to move the flag. Exposed for tests. */
export function currentStudioReadinessEpoch(): number {
  return epoch;
}

/**
 * The barrier completed: preflight registered AND reconciliation finished.
 * Ignored, and LOGGED, when the caller's epoch is stale - which is what a
 * retry timer that outlived its teardown holds.
 */
export function markStudioRuntimeReady(callerEpoch: number): void {
  if (!ownsEpoch(callerEpoch, "ready")) return;
  readiness = { ready: true };
}

/** The preflight could not be registered. Studio stays closed. */
export function markStudioFenceUninitialized(callerEpoch: number): void {
  if (!ownsEpoch(callerEpoch, "fence_uninitialized")) return;
  readiness = { ready: false, cause: FENCE_CAUSE };
}

/**
 * Bridge teardown. Never restores the engine's default-ALLOW, and never
 * reversible by anything already in flight: the epoch moves, so every token
 * handed out before this call is stale from here on.
 */
export function markStudioRuntimeShuttingDown(): void {
  epoch += 1;
  readiness = { ready: false, cause: SHUTDOWN_CAUSE };
}

function ownsEpoch(callerEpoch: number, transition: string): boolean {
  if (callerEpoch === epoch) return true;
  log.warn(
    `[studio:readiness] ignored ${transition} from a stale initialization `
      + `(epoch=${String(callerEpoch)} current=${String(epoch)})`,
  );
  return false;
}

/** Test seam: back to the pre-barrier state, on a fresh epoch. */
export function resetStudioReadinessForTests(): void {
  epoch += 1;
  readiness = { ready: false, cause: STARTING_CAUSE };
}
