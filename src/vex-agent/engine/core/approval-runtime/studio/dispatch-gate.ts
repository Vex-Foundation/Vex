/**
 * The Vex Studio DISPATCH GATE - the bridge between "the user locked Vex" and
 * "no queued Studio action can still dispatch".
 *
 * ## Why it is durable and not a flag
 *
 * A generation held only in memory is not a linearization point. A continuation
 * can read generation N, await the dispatch-slot CAS, the user locks Vex (the
 * env scrub runs, the in-memory generation becomes N+1), and the pending CAS
 * still commits against a database that never heard about the lock. The fence
 * therefore lives in a row (`studio_runtime_gate`, migration 086) that the slot
 * claim reads `FOR SHARE` inside its own UPDATE. A committed slot claim then
 * MEANS "dispatch began before the lock", and a claim racing the advance is
 * refused with zero rows.
 *
 * ## The window that remains, stated honestly
 *
 * Between the synchronous scrub and the advance's COMMIT, a slot claim can
 * still commit. That call is not a hole: the signing capability was revoked
 * synchronously with the scrub, so the dispatch fails closed at the signer and
 * is recorded as `failed` or `indeterminate` through the existing CAS. Nothing
 * can broadcast. The generation closes the door for everything after it; the
 * revocation closes it for the one call that got through.
 *
 * ## The in-memory mirror is a courtesy, never the authority
 *
 * `readMirroredStudioDispatchGeneration` exists so the broker can refuse a
 * waiter fast, without a round trip, when it already knows the generation
 * moved. No dispatch decision may read it. The authority is the row, read
 * inside the statement that acts on it.
 *
 * ## Monotonic in both directions
 *
 * Lock advances, and unlock advances too. Both INCREMENT; neither resets. That
 * is what stops a re-unlock from resurrecting an intent enqueued before the
 * lock: its recorded generation is in the past forever, so it can only be
 * refused, never dispatched, and the external agent has to ask again.
 */

import type { PoolClient } from "pg";

import logger from "@utils/logger.js";
import {
  advanceStudioDispatchGenerationRow,
  readStudioDispatchGenerationWith,
} from "@vex-agent/db/repos/studio-runtime-gate.js";

import {
  readStudioDispatchPreflight,
  setStudioDispatchPreflight,
} from "./dispatch-preflight.js";

/**
 * Re-exported so every existing consumer keeps ONE import site for the Studio
 * dispatch gate. The registry itself is a separate, import-free module because
 * the main process has to reach it without pulling `pg` into its static graph.
 */
export {
  setStudioDispatchPreflight,
  type StudioDispatchPreflight,
} from "./dispatch-preflight.js";

/**
 * Last generation this process observed. `null` means "never read one", which
 * every reader must treat as "no fast answer available", never as generation
 * zero.
 */
let mirroredGeneration: string | null = null;

/** What an advance did. A failure is reported, never swallowed into success. */
export type StudioGenerationAdvance =
  | { readonly ok: true; readonly generation: string }
  | { readonly ok: false; readonly cause: unknown };

/**
 * Advance the durable dispatch generation. Called by the lock and by the unlock
 * on the main side, ALWAYS after the synchronous scrub.
 *
 * It never throws. A lock whose database is unavailable must still complete its
 * scrub and its signing revocation; the caller is told the advance failed so it
 * can log it, and the durable refusal that follows reconciles through the
 * scheduled sweep when the database comes back.
 */
export async function advanceStudioDispatchGeneration(): Promise<StudioGenerationAdvance> {
  try {
    const generation = await advanceStudioDispatchGenerationRow();
    if (generation === null) {
      // The seeded row is missing, which means migration 086 has not run. Fail
      // loudly rather than silently leaving the fence open.
      logger.error("engine.studio.dispatch_gate_row_missing", {});
      return { ok: false, cause: new Error("studio_runtime_gate row missing") };
    }
    mirroredGeneration = generation;
    logger.info("engine.studio.dispatch_generation_advanced", { generation });
    return { ok: true, generation };
  } catch (cause) {
    logger.warn("engine.studio.dispatch_generation_advance_failed", {
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    return { ok: false, cause };
  }
}

/**
 * Read the current generation inside the caller's transaction and refresh the
 * mirror from it. Used by the Studio enqueue gate, which stamps the value onto
 * the intent it inserts in that same transaction.
 */
export async function readStudioDispatchGeneration(
  client: PoolClient,
): Promise<string | null> {
  const generation = await readStudioDispatchGenerationWith(client);
  if (generation !== null) mirroredGeneration = generation;
  return generation;
}

/**
 * The fast pre-check. `null` when this process has never seen a generation.
 * Advisory only - see the module header.
 */
export function readMirroredStudioDispatchGeneration(): string | null {
  return mirroredGeneration;
}

/**
 * The DISPATCH PREFLIGHT - the one gap the durable generation cannot cover.
 *
 * The fence is a row, and the fence is the authority whenever the advance
 * COMMITTED. But an advance can FAIL: PostgreSQL is down when the user locks
 * Vex, the lock still scrubs and still revokes signing, and the row still holds
 * the OLD generation. When the database comes back, a pre-lock intent's
 * recorded generation is still current, so its slot claim would match - the
 * fence never moved, because nobody could move it.
 *
 * Only the main process can observe that state (it is the one that tried to
 * advance), so it registers a predicate rather than the engine guessing. The
 * SLOT it registers into lives in `dispatch-preflight.ts`, which has no imports
 * at all so main can set it SYNCHRONOUSLY at module setup; see that module's
 * header for why an async registration was itself the defect. This function
 * owns the POLICY over that slot, which is what a pure module cannot hold:
 *
 *   - nothing registered means ALLOW (the headless engine's case);
 *   - a predicate that THROWS refuses, because a preflight that cannot answer
 *     has not proven the fence is intact.
 */
export function studioDispatchPreflightAllows(): boolean {
  const preflight = readStudioDispatchPreflight();
  if (preflight === null) return true;
  try {
    return preflight();
  } catch (cause) {
    logger.warn("engine.studio.dispatch_preflight_threw", {
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    return false;
  }
}

/**
 * Test seam. Production code never resets the mirror: the durable value is
 * monotonic, and a process that forgets it simply has no fast answer until its
 * next read. It also drops any registered preflight, so one test's predicate
 * cannot decide another test's dispatch.
 */
export function resetMirroredStudioDispatchGenerationForTests(): void {
  mirroredGeneration = null;
  setStudioDispatchPreflight(null);
}
