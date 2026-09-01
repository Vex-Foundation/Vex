/**
 * STUDIO MCP ADMISSION: may a peer be served right now?
 *
 * This is the SECOND of the host's two lifecycle owners, and the split is the
 * whole point of the module. The LISTENER owns a transport question - is a
 * socket bound and accepting - and answers `stopped | starting | listening |
 * shutting_down`. ADMISSION owns an authority question - may what arrives on
 * that socket be served - and answers `locked | unready | ready`. They used to
 * be one flag, so a relock had to close the listener to close the door, and a
 * bridge could not tell "Vex is not running" from "Vex is locked".
 *
 * Binding a listener never opens this door: admission starts LOCKED and is
 * opened only by the secret-session owner, after its dispatch-generation
 * advance, its poison clearing and its pending-refusal repair have all
 * succeeded. Nothing here reads the vault; the vault's owner calls in.
 *
 * ## The epoch is the FENCE, and it lives here
 *
 * A start and a connection establish are both chains of awaits, and a lock can
 * land in any gap between them. Re-reading the locked flag is not enough on its
 * own: an unlock that follows the lock closely enough would clear it, and a
 * stale continuation would then promote a connection that belongs to a session
 * nobody asked for. A captured epoch cannot be cleared, so "is the session I
 * was accepted into still the current one" has exactly one answer and it never
 * becomes true again.
 *
 * Closing admission advances the epoch SYNCHRONOUSLY, before anything is torn
 * down, which is what lets `lockSecretSession` advance its own dispatch
 * generation without waiting for a peer's FIN.
 *
 * ## Unready is not locked
 *
 * The settlement readiness barrier is read here rather than stored, so it can
 * never drift from its owner in `../readiness.ts`. An unready Vex refuses
 * handshakes and calls with the barrier's own sentence while the listener stays
 * bound: a bridge started during boot gets an honest "still starting" instead
 * of a connection error it would report as "Vex is not installed".
 */

import { studioReadiness, type StudioUnreadyCode } from "../readiness.js";

/**
 * The one sentence a locked Vex tells a peer. It names what did NOT happen,
 * because a coding agent's next action depends on knowing nothing moved.
 */
const LOCKED_SENTENCE =
  "Vex is locked, so it will not serve MCP calls. Nothing was executed and no "
  + "funds moved. Unlock Vex and connect again.";

export type StudioAdmission =
  | { readonly state: "ready" }
  | { readonly state: "locked"; readonly cause: string }
  | {
      readonly state: "unready";
      readonly code: StudioUnreadyCode;
      readonly cause: string;
    };

/** LOCKED until the secret-session owner says otherwise. Fail closed at boot. */
let locked = true;

/** Monotonic, and never reset: a token handed out before a close must stay
 * distinguishable from every token handed out after it, for the life of the
 * process. */
let epoch = 0;

/** May a peer handshake or call right now, and if not, why not? */
export function studioAdmission(): StudioAdmission {
  if (locked) return { state: "locked", cause: LOCKED_SENTENCE };
  const readiness = studioReadiness();
  if (!readiness.ready) {
    return { state: "unready", code: readiness.code, cause: readiness.cause };
  }
  return { state: "ready" };
}

/** The current admission epoch. Captured by every connection at accept. */
export function studioAdmissionEpoch(): number {
  return epoch;
}

/**
 * Close the door and INVALIDATE every captured epoch, synchronously.
 *
 * Called by the lock teardown and by quit, in the same tick they decide, and
 * always BEFORE any socket is destroyed: the fence must be down before the
 * teardown it fences starts.
 */
export function closeStudioAdmission(): void {
  epoch += 1;
  locked = true;
}

/**
 * Open the door. The CALLER owns the proof that opening is safe - for the
 * secret session that is a committed generation advance, no dispatch poison and
 * no unwritten refusal. The epoch is NOT advanced: opening invalidates nothing.
 */
export function openStudioAdmission(): void {
  locked = false;
}

/** Test seam: back to the boot state, on a fresh epoch. */
export function resetStudioAdmissionForTests(): void {
  epoch += 1;
  locked = true;
}
