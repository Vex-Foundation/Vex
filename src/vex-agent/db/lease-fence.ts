/**
 * Lease fence — makes a runner's write conditional on it STILL holding the
 * session lease, race-free.
 *
 * A runner can be slow enough (a long tool call, a stalled event loop) that
 * its lease expires and another runner takes the session over. The old runner
 * does not know yet, and whatever it writes next — an assistant row, a tool
 * result, a run status — lands on a session the new owner is driving. The
 * heartbeat notices only on its next tick; the fence closes the gap at the
 * write itself.
 *
 * ## How
 *
 * One transaction on a pooled client:
 *
 *   1. (optional) lock the `mission_runs` row `FOR UPDATE` — see lock order;
 *   2. read the session's `runner_leases` row `FOR SHARE`;
 *   3. only if the row still carries OUR claim token, run the write on the
 *      same client, then COMMIT.
 *
 * A takeover is an UPDATE of that lease row (`acquireLease`'s conflict path),
 * so it WAITS for our share lock: the check and the write commit before the
 * steal can land, and after the steal the check sees the new token and the
 * write never runs. There is no window in between.
 *
 * ## The three states
 *
 * - `held`       — the row carries our token. The write runs.
 * - `taken_over` — the row carries another claim's token. The write is
 *                  REFUSED: nothing runs, nothing commits, and the caller gets
 *                  `{ fenced: false }` instead of an exception.
 * - `released`   — there is no row. The write runs. A lease row disappears
 *                  only when its holder releases it or an operator Stop's
 *                  transaction deletes it (`apply-user-stop.ts`), and in the
 *                  Stop case the stopped turn still has closing writes to make
 *                  (the partial `chat_stopped` row, the synthetic results that
 *                  keep a stopped batch's tool_call/tool_result pairing
 *                  balanced). Refusing them would change what Stop leaves
 *                  behind. Nobody else holds the session at that instant; a
 *                  runner that claims it afterwards sees a row again and every
 *                  later write from the old runner is refused.
 *
 * ## Lock order
 *
 * Claimers lock `mission_runs` before `runner_leases` (`claim-run-lease.ts`),
 * so a fenced write that also touches `mission_runs` must take the run row
 * FIRST (`lockMissionRunId`) — taking the lease share lock first and the run
 * row second is the reverse order and could deadlock against a claimer.
 * Transcript writes touch `messages` and `sessions`, which no claimer locks
 * after the lease row, so they need no pre-lock. A caller already inside a
 * session-control-lock transaction uses `fenceRunWriteWith` on its own
 * client, after its own earlier locks.
 */

import type { PoolClient } from "pg";
import logger from "@utils/logger.js";
import { queryOneWith, withTransaction } from "./client.js";

/** The claim a fenced write is conditional on. */
export interface LeaseFence {
  readonly sessionId: string;
  readonly claimToken: string;
}

export type LeaseFenceState = "held" | "released" | "taken_over";

/**
 * Where a fenced write came from. A closed set so the refusal log stays a
 * bounded enum, never free text.
 */
export type LeaseFenceSite =
  | "assistant_message"
  | "tool_batch_transcript"
  | "mission_finalize"
  | "mission_park"
  | "dispatch_check";

export type LeaseFenceOutcome<T> =
  | { readonly fenced: true; readonly state: "held" | "released"; readonly value: T }
  | { readonly fenced: false; readonly state: "taken_over" };

/**
 * Read the lease row under `FOR SHARE` on the caller's transaction and say
 * which state the fence is in. MUST run inside a transaction: the share lock
 * is what holds a concurrent takeover off until this transaction ends.
 */
export async function readLeaseFenceWith(
  client: PoolClient,
  fence: LeaseFence,
): Promise<LeaseFenceState> {
  const row = await queryOneWith<{ readonly held: boolean }>(
    client,
    `SELECT (claim_token = $2) AS held
       FROM runner_leases
      WHERE session_id = $1
      FOR SHARE`,
    [fence.sessionId, fence.claimToken],
  );
  if (row === null) return "released";
  return row.held ? "held" : "taken_over";
}

/** The one sanitised refusal record: ids and enums only. */
export function logFencedWriteRefused(
  fence: LeaseFence,
  site: LeaseFenceSite,
  reason: "taken_over" | "known_lost",
): void {
  logger.warn("runtime.lease.fenced_write_refused", {
    sessionId: fence.sessionId,
    site,
    reason,
  });
}

/**
 * Fence a mission-run write on a transaction the caller already owns (a
 * session-control-lock park, for example). Locks the run row, then reads the
 * fence, in the documented order. Returns `false` — and logs the refusal —
 * when another claim holds the lease; the caller must then write nothing.
 */
export async function fenceRunWriteWith(
  client: PoolClient,
  fence: LeaseFence,
  missionRunId: string,
  site: LeaseFenceSite,
): Promise<boolean> {
  await queryOneWith(
    client,
    `SELECT 1 FROM mission_runs WHERE id = $1 FOR UPDATE`,
    [missionRunId],
  );
  const state = await readLeaseFenceWith(client, fence);
  if (state === "taken_over") {
    logFencedWriteRefused(fence, site, "taken_over");
    return false;
  }
  return true;
}

/**
 * Run `fn` in a transaction that commits only while `fence` still holds the
 * session lease (or the lease was released — see the module header). Never
 * throws for a refusal: a refused write returns `{ fenced: false }` without
 * running `fn`. Errors thrown by `fn` itself propagate exactly as an unfenced
 * write's would, and roll the transaction back.
 */
export async function withLeaseFence<T>(
  fence: LeaseFence,
  fn: (client: PoolClient) => Promise<T>,
  opts: {
    readonly site: LeaseFenceSite;
    /** Lock this run row BEFORE the lease row (see lock order). */
    readonly lockMissionRunId?: string;
  },
): Promise<LeaseFenceOutcome<T>> {
  const outcome = await withTransaction(
    async (client): Promise<LeaseFenceOutcome<T>> => {
      if (opts.lockMissionRunId !== undefined) {
        await queryOneWith(
          client,
          `SELECT 1 FROM mission_runs WHERE id = $1 FOR UPDATE`,
          [opts.lockMissionRunId],
        );
      }
      const state = await readLeaseFenceWith(client, fence);
      if (state === "taken_over") return { fenced: false, state };
      const value = await fn(client);
      return { fenced: true, state, value };
    },
  );
  if (!outcome.fenced) logFencedWriteRefused(fence, opts.site, "taken_over");
  return outcome;
}

/**
 * Plain (unlocked) read of the fence state, for the pre-dispatch check. It
 * decides whether a NEW tool call may start; it does not guard a write, so it
 * needs no transaction.
 */
export async function readLeaseFenceState(
  fence: LeaseFence,
): Promise<LeaseFenceState> {
  const { getPool } = await import("./client.js");
  const row = await queryOneWith<{ readonly held: boolean }>(
    getPool(),
    `SELECT (claim_token = $2) AS held
       FROM runner_leases
      WHERE session_id = $1`,
    [fence.sessionId, fence.claimToken],
  );
  if (row === null) return "released";
  return row.held ? "held" : "taken_over";
}
