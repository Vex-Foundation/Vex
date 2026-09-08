/**
 * The VERIFIED-FINGERPRINT store for the two-stage desktop launch.
 *
 * PROCESS MEMORY, NOT A TABLE (coordinator decision 2026-08-18). The reasons are
 * recorded here rather than left to be re-derived:
 *
 *  1. FAIL-CLOSED BY CONSTRUCTION. A restart means the user re-prepares, which
 *     re-runs all 13 verifier points AND re-reads the deployment fee. That fee
 *     moved 0.000263 -> 0.00105 ETH inside 24 hours, so a prepared launch
 *     surviving a restart is not a feature: a stale one is a liability, and
 *     re-preparing is the behaviour we want anyway.
 *  2. THE WINDOW IS ~20 MINUTES, bounded by the gateway's own deadline.
 *     Durability beyond a process lifetime buys nothing real.
 *  3. PERSISTING VERIFIED CALLDATA for a launch nobody has authorized yet would
 *     create a durable, replayable money-path artifact. Memory bounds it
 *     naturally.
 *  4. IT ADDS NO STORED STATE to the money path, which would be a fresh owner
 *     decision beyond the approved 082 package - and the durable record that
 *     MATTERS already exists: the intent row, written at stage 2 when an
 *     authorization is actually taken.
 *
 * FOUR PROPERTIES, each of them a refusal rather than a comment:
 *
 *   EXPIRES. Entries carry the prepare's own `expiresAt` and are swept on every
 *   access, so the map cannot grow without bound and a lapsed quote cannot be
 *   deployed.
 *
 *   SINGLE USE. `consume` REMOVES the entry. A replayed `fingerprintId` finds
 *   nothing and is refused by name - the same answer a second Deploy click gets,
 *   which is the point: two clicks must not become two launches.
 *
 *   SESSION-KEYED. An entry belongs to the session that prepared it. A lookup
 *   from another session is refused, and it is refused with the SAME answer as a
 *   miss: a distinct "wrong session" reply would confirm that some other
 *   session's launch exists.
 *
 *   CANCELLABLE. `drop` discards it, so a user who backs out of the form leaves
 *   nothing behind that a later click could deploy.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT MONEY. The entry is the plan the verifier
 * already proved; stage 2 still takes its own authorization and hands the
 * broadcaster the fingerprint this entry carries.
 */

import { randomUUID } from "node:crypto";

import type { Address } from "viem";

import type { PoolsLaunchPlan } from "../handlers/launch/execute/plan.js";
import type { PoolsLaunchFingerprintId, PoolsPreparedLaunch } from "./runtime-contract.js";

/** One prepared, verified launch waiting for the user's Deploy click. */
export interface PreparedLaunchEntry {
  readonly fingerprintId: PoolsLaunchFingerprintId;
  readonly sessionId: string;
  /** The wallet the plan was verified FOR. Stage 2 refuses to sign as anyone else. */
  readonly walletAddress: Address;
  readonly plan: PoolsLaunchPlan;
  /** Epoch ms. Past this the entry is gone, whether or not anything swept it. */
  readonly expiresAtMs: number;
  /**
   * WHICH clock set {@link expiresAtMs}, so a lapsed confirmation can say why.
   *
   * "Expired" alone is unactionable when the three possible windows differ by
   * two orders of magnitude: a signed stock quote lapses in seconds and needs an
   * immediate re-prepare, while Vex's own window lapsing after ten minutes means
   * the user simply took their time.
   */
  readonly expiryReason: PoolsPreparedLaunch["expiryReason"];
}

/**
 * Why a handle produced no launch. ONE answer for every reason it could be
 * missing, and a SEPARATE one for expiry.
 *
 * `missing` deliberately covers never-prepared, already-deployed, cancelled AND
 * another session's launch: a distinct answer for the last of those would
 * confirm that some other session's launch exists.
 *
 * `expired` is split out because it is not ambiguous and not a secret - the
 * caller already held a valid handle - and because the remedy depends on WHICH
 * clock ran out.
 */
export type ConsumePreparedLaunchOutcome =
  | { readonly kind: "ok"; readonly entry: PreparedLaunchEntry }
  | { readonly kind: "expired"; readonly reason: PoolsPreparedLaunch["expiryReason"] }
  | { readonly kind: "missing" };

const entries = new Map<string, PreparedLaunchEntry>();

/** Drop everything already past its own expiry. Called on every access. */
function sweep(now: number): void {
  for (const [id, entry] of entries) {
    if (entry.expiresAtMs <= now) entries.delete(id);
  }
}

/**
 * Store a verified plan and return its opaque handle.
 *
 * The id is a random UUID and carries NO information about the launch: the
 * renderer cannot reconstruct or alter a launch from it, which is what stops a
 * tampered round trip from reaching the signer.
 */
export function storePreparedLaunch(
  input: Omit<PreparedLaunchEntry, "fingerprintId">,
): PoolsLaunchFingerprintId {
  sweep(Date.now());
  const fingerprintId = randomUUID();
  entries.set(fingerprintId, { ...input, fingerprintId });
  return fingerprintId;
}

/**
 * Take the entry OUT of the store, or say why there is none.
 *
 * THE LOOKUP HAPPENS BEFORE THE SWEEP, and the order is the whole reason expiry
 * can be reported at all. Sweeping first would delete a just-lapsed entry and
 * leave this function unable to tell "your signed price quote ran out forty
 * seconds ago" from "that handle never existed" - and those have different
 * remedies. The entry is still removed either way, so a lapsed one cannot be
 * deployed and cannot linger: an expired hit is deleted here, and everything
 * else lapsed is swept immediately after.
 *
 * SINGLE USE is unchanged: a successful consume removes the entry, so a second
 * Deploy click finds nothing.
 */
export function consumePreparedLaunch(
  sessionId: string,
  fingerprintId: PoolsLaunchFingerprintId,
): ConsumePreparedLaunchOutcome {
  const now = Date.now();
  const entry = entries.get(fingerprintId);
  if (entry === undefined || entry.sessionId !== sessionId) {
    sweep(now);
    return { kind: "missing" };
  }
  // THE PRE-SIGN EXPIRY RE-CHECK. The confirmation screen counted down to this
  // moment; nothing signs until the clock is asked again, here, against the
  // entry's own deadline rather than against the window it was shown under.
  entries.delete(fingerprintId);
  sweep(now);
  if (entry.expiresAtMs <= now) return { kind: "expired", reason: entry.expiryReason };
  return { kind: "ok", entry };
}

/** Discard a prepared launch. `false` when there was nothing of this session's to discard. */
export function dropPreparedLaunch(
  sessionId: string,
  fingerprintId: PoolsLaunchFingerprintId,
): boolean {
  sweep(Date.now());
  const entry = entries.get(fingerprintId);
  if (entry === undefined || entry.sessionId !== sessionId) return false;
  entries.delete(fingerprintId);
  return true;
}

/**
 * How many prepared launches are held right now.
 *
 * Exported for tests and diagnostics ONLY: it answers "did the sweep actually
 * remove that", which is the property that keeps this map bounded, and a
 * property nothing else can observe.
 */
export function preparedLaunchCount(): number {
  sweep(Date.now());
  return entries.size;
}

/** Test-only reset, so one suite's entries cannot leak into another's. */
export function resetPreparedLaunches(): void {
  entries.clear();
}
