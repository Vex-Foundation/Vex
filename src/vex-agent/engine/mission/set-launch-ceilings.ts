/**
 * `mission.setLaunchCeilings` — the HOST-ONLY writer for the two autonomous
 * launch ceilings (§C6 / §C6b): `maxLaunchValueRaw` + `maxLaunchValueDecimals`
 * (the per-launch spend cap, in wei) and `maxLaunchCount` (how many tokens the
 * mission may create).
 *
 * This is the ONLY way either number is ever written. `patch-parser.ts` rejects
 * all three keys by name, so no model output can reach them — rule 90, "fee,
 * limit, and destination parameters must never originate from model input". A
 * cap the model can raise is not a cap, and it is worse than none because the
 * contract card would show the user a limit that does not bind.
 *
 * Two properties this writer must have, both enforced below:
 *
 * 1. **Writing a ceiling INVALIDATES acceptance.** Both ceilings are canonical
 *    contract-hash material (v5), so an edited ceiling no longer matches the
 *    accepted hash. The mission goes back through Accept before it can start —
 *    the user re-reads the limit they are authorizing.
 * 2. **Only an editable mission may be edited.** Once a run has started, its
 *    ceilings are frozen in `mission_runs.contract_snapshot_json` and
 *    `launch-ceiling.ts` reads them from there, so a late write would change
 *    what the card SHOWS without changing what the run ENFORCES. Refuse
 *    instead, and say which status blocked it.
 *
 * Identity → authorization → state → write all run inside ONE row-locked
 * transaction, serializing against the model's `mission_draft_update` merge
 * (`setup.ts`) so neither writer can lose the other's keys.
 *
 * NEVER starts a run.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";

import { REQUIRED_MAX_LAUNCH_VALUE_DECIMALS } from "./launch-ceiling.js";

export interface SetMissionLaunchCeilingsInput {
  readonly sessionId: string;
  readonly missionId: string;
  /** Raw integer wei string, or `null` to clear the ceiling (fails closed). */
  readonly maxLaunchValueRaw: string | null;
  /** Must be 18 when a raw amount is present — see `launch-ceiling.ts`. */
  readonly maxLaunchValueDecimals: number | null;
  /** Non-negative whole number of launches, or `null` to clear. */
  readonly maxLaunchCount: number | null;
}

export type SetMissionLaunchCeilingsOutcome =
  | {
    readonly outcome: "updated";
    readonly maxLaunchValueRaw: string | null;
    readonly maxLaunchValueDecimals: number | null;
    readonly maxLaunchCount: number | null;
    /** True when a prior acceptance was invalidated by this write. */
    readonly acceptanceCleared: boolean;
  }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "blocked_status"; readonly status: string }
  | { readonly outcome: "invalid"; readonly reason: string };

const EDITABLE_STATUSES = new Set<string>(["draft", "ready"]);

/**
 * Validate the pair + count the same way the enforcement side reads them, so a
 * value that could never bind is refused at the door rather than stored and
 * silently ignored later.
 */
function validate(input: SetMissionLaunchCeilingsInput): string | null {
  const { maxLaunchValueRaw: raw, maxLaunchValueDecimals: decimals } = input;

  if ((raw === null) !== (decimals === null)) {
    return "The launch value ceiling must be set as a pair: a raw amount and its decimals, or neither.";
  }
  if (raw !== null) {
    if (!/^\d+$/.test(raw)) {
      return "The launch value ceiling must be a raw non-negative integer amount in wei — no decimal point, sign, or exponent.";
    }
    if (decimals !== REQUIRED_MAX_LAUNCH_VALUE_DECIMALS) {
      return `The launch value ceiling must be authored with exactly ${REQUIRED_MAX_LAUNCH_VALUE_DECIMALS} decimals; it is compared against msg.value in wei and is never rescaled.`;
    }
  }
  if (input.maxLaunchCount !== null) {
    if (!Number.isInteger(input.maxLaunchCount) || input.maxLaunchCount < 0) {
      return "The launch count ceiling must be a non-negative whole number of launches.";
    }
  }
  return null;
}

export async function setMissionLaunchCeilings(
  input: SetMissionLaunchCeilingsInput,
): Promise<SetMissionLaunchCeilingsOutcome> {
  const invalid = validate(input);
  if (invalid !== null) return { outcome: "invalid", reason: invalid };

  return withTransaction(async (client) => {
    // Identity — lock the mission row and verify it belongs to this session.
    // A cross-session id collapses to `not_found` (no existence leak), the
    // same shape `setAutoRetry` uses.
    const mission = await missionsRepo.getMissionForUpdate(client, input.missionId);
    if (!mission || mission.rootSessionId !== input.sessionId) {
      return { outcome: "not_found" };
    }

    // State — a started mission's ceilings are already frozen into its run.
    if (!EDITABLE_STATUSES.has(mission.status)) {
      return { outcome: "blocked_status", status: mission.status };
    }

    await missionsRepo.mergeConstraintLaunchCeilings(client, input.missionId, {
      maxLaunchValueRaw: input.maxLaunchValueRaw,
      maxLaunchValueDecimals: input.maxLaunchValueDecimals,
      maxLaunchCount: input.maxLaunchCount,
    });

    // Contract-hash material changed, so a prior acceptance no longer covers
    // this contract. Same invariant the model draft path applies in `setup.ts`.
    const acceptanceCleared = mission.acceptedContractHash !== null;
    if (acceptanceCleared) {
      await missionsRepo.clearAcceptance(client, input.missionId);
    }

    return {
      outcome: "updated",
      maxLaunchValueRaw: input.maxLaunchValueRaw,
      maxLaunchValueDecimals: input.maxLaunchValueDecimals,
      maxLaunchCount: input.maxLaunchCount,
      acceptanceCleared,
    };
  });
}
