/**
 * C6 — the enforceable autonomous-launch spend ceiling.
 *
 * `iteration-budget.ts` says in its own words that it is NOT a spend cap, and
 * no session spend gate exists. With Path 2 able to spend unattended, free text
 * in a mission goal constrains nothing at the signing boundary. So the mission
 * contract carries a hard number, and this module owns the ONLY place it is
 * read and compared.
 *
 * Three rules, all of them rule-90 money-path discipline:
 *
 * 1. **No ceiling ⇒ REFUSE.** `null` is not "unlimited"; a mission that never
 *    had a ceiling authored cannot launch autonomously. Fail closed.
 * 2. **Decimals must be 18.** `maxLaunchValueRaw` is compared against
 *    `msg.value` in WEI on chain 4663 (native ETH). Any other decimals value
 *    is REFUSED BY NAME. We never rescale: a silent 10^n slip is exactly the
 *    thousandfold error the rule exists to prevent.
 * 3. **Exceeding it refuses with BOTH numbers, never clamps.** Silently
 *    lowering the amount would hide from the user that the agent tried to
 *    spend more than they authorized.
 *
 * The ceiling is compared against the FULL `msg.value` — creation fee PLUS
 * prebuy — plus Vex's own 25 bps fee, and NOT against the prebuy alone. Every
 * one of those is a real, irreversible spend. See {@link launchChargeableWei}.
 *
 * WHY THE COUNT QUERY LIVES HERE AND NOT IN `db/repos` (deliberate rule-04
 * deviation, coordinator-ratified 2026-08-02). Repo law puts SQL in
 * `db/repos/*`, and `countMissionRunLaunches` below plainly belongs there by
 * that rule. It is here anyway, on purpose: this module is the SINGLE
 * enforcement point for autonomous launch spending, and a spend gate whose
 * policy lives in one file and whose evidence-gathering lives in another is a
 * gate with two places to get it wrong. Splitting them would let a future caller
 * count with a different predicate than the one the policy documents — which is
 * precisely the race the status list below exists to close.
 *
 * **Do not "helpfully" move the query into `db/repos/token-launch-intents`.**
 * If you do, move the policy with it; never separate them.
 */

import type { PoolClient } from "pg";

import { getRun } from "../../db/repos/mission-runs.js";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "../types.js";

/** Decimals the ceiling must be authored in to be comparable with wei. */
export const REQUIRED_MAX_LAUNCH_VALUE_DECIMALS = 18;

/** The ceiling as authored on the mission contract. */
export interface MaxLaunchValueContract {
  readonly maxLaunchValueRaw: string | null;
  readonly maxLaunchValueDecimals: number | null;
}

/**
 * §C6b — the SECOND ceiling: how many tokens the agent may create in THIS
 * mission.
 *
 * `maxLaunchValueRaw` alone is not enough. A loop that stays under the
 * per-launch value cap could still mint dozens of tokens, each one a permanent
 * artifact on a public launchpad with the user's wallet as its creator. The
 * count cap is what makes "launch a token" a bounded instruction.
 *
 * Authored on the mission contract beside the value pair (`MissionDraft.
 * maxLaunchCount`, canonical since contract-hash v5) and HOST-ONLY, exactly
 * like the value ceiling — `patch-parser.ts` rejects it by name.
 */
export interface MaxLaunchCountContract {
  readonly maxLaunchCount: number | null;
}

/** Both ceilings, as an autonomous launch must see them. */
export type AutonomousLaunchCeilings = MaxLaunchValueContract & MaxLaunchCountContract;

/**
 * The intent statuses that consume a slot against {@link MaxLaunchCountContract}.
 *
 * IN-FLIGHT ROWS COUNT. `confirmed` alone would let two concurrent launches both
 * read zero and both sign, walking straight past a cap of one — the count is a
 * money gate, so it must see money that is committed but not yet settled.
 *
 * `cancelled` and `expired` never spent and never minted. `terminal_failure` may
 * have burned gas, but it produced no token, and the cap counts TOKENS THE
 * MISSION CREATED, not attempts it paid for. A user who set "launch at most 3"
 * means three tokens.
 */
export const LAUNCH_COUNT_CEILING_STATUSES = [
  "authorized",
  "consuming",
  "broadcast_pending",
  "confirmed",
] as const;

/**
 * The figure the value ceiling actually compares — `msg.value` PLUS Vex's own
 * 25 bps fee (§C7), EXCLUDING network gas.
 *
 * The fee is included because the mission ceiling is the user saying "do not
 * spend more than X on a launch", and a ceiling that ignored a charge VEX ITSELF
 * imposes would be misleading about the very thing it exists to bound. It is
 * counted here even though the fee leg is BROADCAST LAST: the caller must plan
 * the fee before this check, or the number checked is not the number spent.
 *
 * Gas is excluded because it is the network's, not ours, and it is an ESTIMATE —
 * a ceiling that moved with a gas estimate would refuse or permit a launch for a
 * reason the user never authored.
 *
 * @param vexFeeWei `0n` when the fee floored to dust and no fee leg is charged.
 */
export function launchChargeableWei(msgValueWei: bigint, vexFeeWei: bigint): bigint {
  return msgValueWei + vexFeeWei;
}

export type LaunchCeilingCheck =
  | { readonly ok: true; readonly ceilingWei: bigint }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the ceiling to a wei bigint, or refuse by name.
 *
 * Separate from {@link enforceLaunchValueCeiling} so a caller can refuse EARLY
 * — before building calldata or reading a fee — when the mission simply has no
 * usable ceiling.
 */
export function resolveLaunchValueCeilingWei(
  contract: MaxLaunchValueContract,
): LaunchCeilingCheck {
  const raw = contract.maxLaunchValueRaw;
  const decimals = contract.maxLaunchValueDecimals;

  if (raw === null || raw.trim().length === 0 || decimals === null) {
    return {
      ok: false,
      reason:
        "Refusing to launch autonomously: this mission has no maxLaunchValue ceiling set. " +
        "An unattended launch spends real funds, so an absent ceiling is treated as zero authority, not unlimited.",
    };
  }

  if (decimals !== REQUIRED_MAX_LAUNCH_VALUE_DECIMALS) {
    return {
      ok: false,
      reason:
        `Refusing to launch: maxLaunchValueDecimals is ${decimals}, but the launch value is ` +
        `compared in wei and this check requires exactly ${REQUIRED_MAX_LAUNCH_VALUE_DECIMALS}. ` +
        "The ceiling is NOT rescaled — a silent decimals conversion is how a thousandfold spend error happens.",
    };
  }

  if (!/^\d+$/.test(raw.trim())) {
    return {
      ok: false,
      reason:
        `Refusing to launch: maxLaunchValueRaw ("${raw.trim()}") is not a raw non-negative integer amount. ` +
        "It must be the ceiling in wei with no decimal point, sign, or exponent.",
    };
  }

  return { ok: true, ceilingWei: BigInt(raw.trim()) };
}

/** The shape every ceiling check returns. */
export type LaunchCeilingVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Enforce the VALUE ceiling.
 *
 * @param chargeableWei what the launch actually costs the user, from
 *   {@link launchChargeableWei}: creation fee + prebuy + Vex's fee. Pass the
 *   raw `msg.value` only when no fee leg is charged.
 */
export function enforceLaunchValueCeiling(
  contract: MaxLaunchValueContract,
  chargeableWei: bigint,
): LaunchCeilingVerdict {
  const resolved = resolveLaunchValueCeilingWei(contract);
  if (!resolved.ok) return resolved;

  if (chargeableWei > resolved.ceilingWei) {
    return {
      ok: false,
      reason:
        `Refusing to launch: this launch would cost ${chargeableWei.toString()} wei ` +
        `(creation fee + prebuy + the Vex fee; network gas excluded), which exceeds the ` +
        `mission's authorized ceiling of ${resolved.ceilingWei.toString()} wei. ` +
        "Lower the prebuy and try again — the amount is NOT clamped for you.",
    };
  }

  return { ok: true };
}

/**
 * Enforce the COUNT ceiling (§C6b).
 *
 * @param usedCount launches already made by this mission run, counted over
 *   {@link LAUNCH_COUNT_CEILING_STATUSES}. The caller MUST take this count
 *   inside the same locked transaction that consumes the intent — a loose read
 *   followed by an unlocked authorize lets two concurrent launches both pass an
 *   `n-1` check and mint one token too many.
 */
export function enforceLaunchCountCeiling(
  contract: MaxLaunchCountContract,
  usedCount: number,
): LaunchCeilingVerdict {
  const cap = contract.maxLaunchCount;

  if (cap === null) {
    return {
      ok: false,
      reason:
        "Refusing to launch autonomously: this mission has no maxLaunchCount set. " +
        "Absent is treated as zero authority, not unlimited — a mission that was never " +
        "set up to create tokens cannot create one unattended.",
    };
  }

  if (!Number.isInteger(cap) || cap < 0) {
    return {
      ok: false,
      reason:
        `Refusing to launch: maxLaunchCount is ${String(cap)}, which is not a non-negative ` +
        "whole number of launches. It is NOT coerced — a cap nobody can read is not a cap.",
    };
  }

  if (usedCount >= cap) {
    return {
      ok: false,
      reason:
        `Refusing to launch: this mission has already used ${usedCount} of its ${cap} ` +
        "authorized launches (launches still settling count too). " +
        "Raise the mission's maxLaunchCount if you want more — it is NOT raised for you.",
    };
  }

  return { ok: true };
}

/**
 * The complete C6b gate: BOTH ceilings, both required.
 *
 * Value is reported first when both are breached — the money is the headline,
 * and a user reading one refusal should hear the larger fact.
 */
export function enforceAutonomousLaunchCeilings(
  contract: AutonomousLaunchCeilings,
  chargeableWei: bigint,
  usedCount: number,
): LaunchCeilingVerdict {
  const value = enforceLaunchValueCeiling(contract, chargeableWei);
  if (!value.ok) return value;
  return enforceLaunchCountCeiling(contract, usedCount);
}

// ── Evidence: how many launches this mission run has already committed to ────

/**
 * Count the mission run's own launches over {@link LAUNCH_COUNT_CEILING_STATUSES}.
 *
 * CLIENT-BOUND, deliberately, and the one place this SQL exists (see the module
 * header for why it is not in `db/repos`). It takes the CALLER'S transaction so
 * the count and the CAS consume that acts on it are the same serialized unit;
 * a pool-level read here would reintroduce exactly the race
 * {@link LAUNCH_COUNT_CEILING_STATUSES} is written to close.
 */
export async function countMissionRunLaunches(
  client: PoolClient,
  missionRunId: string,
): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM token_launch_intents
      WHERE mission_run_id = $1
        AND status = ANY($2::text[])`,
    [missionRunId, [...LAUNCH_COUNT_CEILING_STATUSES]],
  );
  return Number(res.rows[0]?.count ?? "0");
}

/** What an autonomous ceiling read yields: the frozen numbers, or a refusal. */
export type LaunchCeilingsRead =
  | { readonly ok: true; readonly ceilings: AutonomousLaunchCeilings }
  | { readonly ok: false; readonly reason: string };

/**
 * Read both ceilings for an AUTONOMOUS launch — from the EXACT provenance run's
 * frozen contract snapshot, and from nothing else.
 *
 * `commit-start.ts` freezes the accepted draft into
 * `mission_runs.contract_snapshot_json` at start, and the engine treats that
 * snapshot as the contract the run executes under precisely because the mission
 * row stays editable afterwards. So:
 *
 *  - **There is NO live-mission-row fallback.** A ceiling read off the mutable
 *    row would let a mid-run edit move the spend gate the user accepted — the
 *    money equivalent of editing a contract after signing it.
 *  - **There is NO active-run fallback either.** "The mission's active run" is a
 *    guess about which run is spending; a launch that cannot name the run whose
 *    contract authorizes it has no authorization to point at. An earlier version
 *    of this function guessed, and that is the hole this signature closes.
 *  - **Identity is verified, not assumed.** The run must exist, belong to the
 *    given mission, and still be live. A run id that names another mission's run
 *    would otherwise import a different user's ceilings into this launch.
 *  - **A terminal run cannot spend.** Its contract is settled; a launch arriving
 *    against a stopped, failed, or completed run is a bug or a replay, and both
 *    must refuse rather than sign against a dead run's limits.
 *
 * Every refusal names what failed, because the reason is handed to the agent and
 * shown to the user; "could not be read" for four distinct faults would make a
 * replay indistinguishable from a missing snapshot.
 *
 * @param missionRunId the run from the execution provenance. `null` means the
 *   caller could not establish which run is launching — which is itself a
 *   refusal, never an invitation to look one up.
 */
export async function readMissionLaunchCeilings(
  missionId: string,
  missionRunId: string | null,
): Promise<LaunchCeilingsRead> {
  if (missionRunId === null || missionRunId.trim().length === 0) {
    return {
      ok: false,
      reason:
        "Refusing to launch autonomously: this execution carries no mission run id, so there is no "
        + "frozen contract to read its spend ceilings from. The ceilings are NEVER taken from the live "
        + "mission row — that row can be edited while the run is spending.",
    };
  }

  const run = await getRun(missionRunId);
  if (run === null) {
    return {
      ok: false,
      reason:
        `Refusing to launch: mission run ${missionRunId} does not exist, so the contract that would `
        + "authorize this launch cannot be read. Nothing was signed.",
    };
  }
  if (run.missionId !== missionId) {
    return {
      ok: false,
      reason:
        `Refusing to launch: mission run ${missionRunId} belongs to a different mission than the one `
        + "authorizing this launch. Ceilings are never read across that boundary. Nothing was signed.",
    };
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return {
      ok: false,
      reason:
        `Refusing to launch: mission run ${missionRunId} is already ${run.status}. A finished run's `
        + "contract cannot authorize new spending. Nothing was signed.",
    };
  }
  // ALLOWLIST, not denylist (Codex final-arc round 5): only an ACTIVE run may
  // authorize. A paused run must stop spending at the next safe checkpoint —
  // this read is one — and an unknown status string is no evidence of
  // authority. Terminal keeps its own message above; this arm covers paused
  // and unrecognized values.
  if (!ACTIVE_RUN_STATUSES.has(run.status)) {
    return {
      ok: false,
      reason:
        `Refusing to launch: mission run ${missionRunId} is ${run.status}, not running. Only a `
        + "running mission run's contract can authorize new spending. Nothing was signed.",
    };
  }

  const ceilings = readCeilingsFromSnapshot(run.contractSnapshotJson);
  if (ceilings === null) {
    return {
      ok: false,
      reason:
        `Refusing to launch: mission run ${missionRunId} has no readable frozen contract snapshot, so `
        + "its spend ceilings are unknown. An unattended launch with unknown limits is never signed.",
    };
  }
  return { ok: true, ceilings };
}

/**
 * Project the frozen snapshot's draft onto the ceilings.
 *
 * The snapshot is JSONB written by an earlier build, so it is treated as
 * untrusted input: anything that is not the exact expected shape reads as "no
 * ceilings frozen", and the pair/count rules below then refuse. Only the two
 * value fields are read as a PAIR (a raw amount with no decimals is
 * unreadable); the count stands alone.
 */
function readCeilingsFromSnapshot(
  snapshot: Record<string, unknown> | null,
): AutonomousLaunchCeilings | null {
  if (snapshot === null) return null;
  const frozen = snapshot["frozenMission"];
  if (typeof frozen !== "object" || frozen === null) return null;
  const draft = (frozen as Record<string, unknown>)["draft"];
  if (typeof draft !== "object" || draft === null) return null;
  const rec = draft as Record<string, unknown>;

  const pairPresent =
    typeof rec["maxLaunchValueRaw"] === "string"
    && typeof rec["maxLaunchValueDecimals"] === "number";
  return {
    maxLaunchValueRaw: pairPresent ? (rec["maxLaunchValueRaw"] as string) : null,
    maxLaunchValueDecimals: pairPresent ? (rec["maxLaunchValueDecimals"] as number) : null,
    maxLaunchCount:
      typeof rec["maxLaunchCount"] === "number"
      && Number.isInteger(rec["maxLaunchCount"])
      && (rec["maxLaunchCount"] as number) >= 0
        ? (rec["maxLaunchCount"] as number)
        : null,
  };
}
