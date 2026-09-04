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

/**
 * The CLOSED set of reasons Studio is not ready, as CODES.
 *
 * `cause` below is a sentence written for an MCP peer, and prose never crosses
 * the IPC boundary to the renderer (every other event channel in this app
 * refuses provider or runtime prose for the same reason). So each unready state
 * carries a code as well, and the renderer-facing host-status contract is
 * derived from THIS list rather than hand-spelled beside it: adding a member
 * here is what makes it representable on the wire, and the shared schema's
 * table test fails when the two drift.
 */
export const STUDIO_UNREADY_CODES = [
  "starting",
  "fence_uninitialized",
  "shutting_down",
] as const;

export type StudioUnreadyCode = (typeof STUDIO_UNREADY_CODES)[number];

/** Not ready, and the honest reason. Ready carries no reason at all. */
export type StudioReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly code: StudioUnreadyCode;
      readonly cause: string;
    };

const STARTING_CAUSE =
  "Vex Studio is still starting, so this action was not queued. Nothing was "
  + "executed. Try again in a moment.";

const FENCE_CAUSE =
  "Vex Studio could not initialize its approval fence, so it did not queue "
  + "this action. Nothing was executed. Restart Vex and check that its local "
  + "database is running.";

const SHUTDOWN_CAUSE =
  "Vex is shutting down, so this action was not queued. Nothing was executed.";

let readiness: StudioReadiness = {
  ready: false,
  code: "starting",
  cause: STARTING_CAUSE,
};

/**
 * The generation of the CURRENT initialization. Monotonic, and never reset:
 * a token handed out before a teardown must stay distinguishable from every
 * token handed out after it, for the whole life of the process.
 */
let epoch = 0;

export function studioReadiness(): StudioReadiness {
  return readiness;
}

type StudioReadinessListener = () => void;

const readinessListeners = new Set<StudioReadinessListener>();

/**
 * THE TRANSITION SEAM, and why the barrier needs one.
 *
 * The MCP host DERIVES admission from this flag rather than copying it, so a
 * late `markStudioRuntimeReady` already changes what the next handshake is
 * told. What it cannot change by itself is what the renderer was last TOLD: the
 * host publishes its status from transition sites IT owns, and a barrier that
 * opened through its own retry path is not one of them. Without this seam, an
 * unlock that happened while the barrier was still closed would leave the
 * status strip reading "still starting" until some unrelated host transition
 * happened to republish it.
 *
 * A listener is a NOTIFICATION, never a value: subscribers re-read
 * `studioReadiness()` themselves, so there is one source of truth and no
 * payload to keep in sync. The set is bounded by its callers - the host
 * registers exactly one for the life of the process - and returns an idempotent
 * unsubscribe. A listener that throws must not stop the transition that
 * notified it: this runs inside boot and teardown sequences where an exception
 * would abort the caller mid-way.
 */
export function onStudioReadinessChange(
  listener: StudioReadinessListener,
): () => void {
  readinessListeners.add(listener);
  let removed = false;
  return (): void => {
    if (removed) return;
    removed = true;
    readinessListeners.delete(listener);
  };
}

function announceReadiness(): void {
  for (const listener of [...readinessListeners]) {
    try {
      listener();
    } catch {
      // Contained on purpose - see the doc above.
    }
  }
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
  readiness = { ready: false, code: "starting", cause: STARTING_CAUSE };
  announceReadiness();
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
  announceReadiness();
}

/** The preflight could not be registered. Studio stays closed. */
export function markStudioFenceUninitialized(callerEpoch: number): void {
  if (!ownsEpoch(callerEpoch, "fence_uninitialized")) return;
  readiness = { ready: false, code: "fence_uninitialized", cause: FENCE_CAUSE };
  announceReadiness();
}

/**
 * Bridge teardown. Never restores the engine's default-ALLOW, and never
 * reversible by anything already in flight: the epoch moves, so every token
 * handed out before this call is stale from here on.
 */
export function markStudioRuntimeShuttingDown(): void {
  epoch += 1;
  readiness = { ready: false, code: "shutting_down", cause: SHUTDOWN_CAUSE };
  announceReadiness();
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
  readiness = { ready: false, code: "starting", cause: STARTING_CAUSE };
  announceReadiness();
}
