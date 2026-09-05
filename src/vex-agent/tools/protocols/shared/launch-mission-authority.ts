/**
 * May THIS mission run authorize ONE more launch, right now?
 *
 * EXTRACTED FROM THE FIRST LAUNCH AUTHORIZE STEP, unchanged in behaviour, because
 * pools.fun launches ask the identical question and a second copy of a spending
 * gate is a second place for it to be got wrong. Both callers run it inside the
 * transaction that already holds the session control lock and that CAS-consumes
 * the intent, which is the whole point: an unlocked check anywhere earlier
 * reopens the window it exists to close.
 *
 * TWO QUESTIONS, DELIBERATELY SEPARATE:
 *
 *   LIVENESS. The frozen ceilings read at plan time cannot drift, so this is not
 *   a second ceilings read - it asks the one thing that IS time-sensitive: may
 *   this run still authorize new spending AT ALL? A user Stop landing during a
 *   long launch call stopped the runner but never the signature, because nothing
 *   in the tool path re-checked run status before signing.
 *
 *   COUNT. The plan-time ceiling check ran on a pool-level read, outside any
 *   lock. A loose read followed by an unlocked authorize lets two concurrent
 *   launches both pass an `n-1` check and mint one token too many. Counting
 *   inside the SAME transaction that consumes the intent is the difference
 *   between a cap and a suggestion.
 */

import type { PoolClient } from "pg";

import {
  countMissionRunLaunches,
  type AutonomousLaunchCeilings,
} from "@vex-agent/engine/mission/launch-ceiling.js";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "@vex-agent/engine/types.js";

export type MissionLaunchAuthority =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface MissionLaunchAuthorityInput {
  readonly missionRunId: string;
  /** The frozen contract in force. `null` is not "unlimited" - the count gate refuses it. */
  readonly ceilings: AutonomousLaunchCeilings | null;
}

export async function checkMissionLaunchAuthority(
  client: PoolClient,
  input: MissionLaunchAuthorityInput,
): Promise<MissionLaunchAuthority> {
  const refusal = await readRunAuthorityRefusal(client, input.missionRunId);
  if (refusal !== null) {
    return {
      ok: false,
      reason:
        `Refusing to launch: mission run ${input.missionRunId} ${refusal} - it stopped, finished, or `
        + "disappeared while this launch was being prepared, and only a live run can authorize new "
        + "spending. Nothing was signed.",
    };
  }

  if (input.ceilings === null) return { ok: true };

  const cap = input.ceilings.maxLaunchCount;
  const used = await countMissionRunLaunches(client, input.missionRunId);
  if (cap === null || used >= cap) {
    return {
      ok: false,
      reason:
        cap === null
          ? "Refusing to launch: this mission has no maxLaunchCount set, and an absent cap is zero "
            + "authority, not unlimited. Nothing was signed."
          : `Refusing to launch: this mission has already used ${used} of its ${cap} authorized `
            + "launches (launches still settling count too). Nothing was signed.",
    };
  }
  return { ok: true };
}

/**
 * Why this run may not authorize new spending, or `null` when it may.
 *
 * A VANISHED ROW FAILS CLOSED. The gate is not deciding whether the run
 * finished - it is deciding whether an authorizing contract is PRESENT at the
 * moment of signing, and a missing row is not an ambiguous status, it is the
 * absence of the thing that grants authority. "Not terminal" would be the
 * permissive reading of no evidence, which is exactly what a decoder that cannot
 * prove what it is looking at must never choose (rule 90).
 *
 * It also keeps the two checkpoints in agreement: the plan-time ceilings read
 * (`readMissionLaunchCeilings`) already refuses a nonexistent run, so treating
 * absence as passable HERE would make a row that disappeared BETWEEN the two
 * checks more trustworthy than one that was already gone at the first. There is
 * no `DELETE FROM mission_runs` and no cascade onto it in the repository, so
 * this branch is reachable only when something is already broken - which is
 * precisely the branch that should refuse rather than sign.
 */
async function readRunAuthorityRefusal(
  client: PoolClient,
  missionRunId: string,
): Promise<string | null> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM mission_runs WHERE id = $1`,
    [missionRunId],
  );
  const status = result.rows[0]?.status ?? null;
  if (status === null) return "no longer exists";
  // ALLOWLIST, not denylist: only an ACTIVE run may authorize a signature. A
  // paused run must stop spending at the next safe checkpoint - pre-sign IS that
  // checkpoint - and an unknown/corrupt status string is no evidence of
  // authority. The DB value is untrusted text, so the sets are consulted as
  // string sets rather than asserted into the union.
  if ((TERMINAL_RUN_STATUSES as ReadonlySet<string>).has(status)) return `is ${status}`;
  return (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(status) ? null : `is ${status}, not running`;
}
