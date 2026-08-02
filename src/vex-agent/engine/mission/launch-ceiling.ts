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

import { getMission } from "../../db/repos/missions.js";
import { missionToDraft } from "./mapper.js";

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
 * NOT YET ON THE MISSION CONTRACT (2026-08-02). `MissionDraft` carries the value
 * pair but has no `maxLaunchCount` field, and `contract-hash.ts` v4 does not
 * cover one — Lane F owns adding all three. Declared here as a local contract
 * per the plan's "define it locally and tell the coordinator" rule, so this
 * module can enforce the complete C6b rule the moment the field exists. Until
 * then it reads `null` for every mission and Path 2 refuses, which IS the
 * intended fail-closed behavior.
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

/**
 * Read both ceilings off the mission that authorized this run.
 *
 * RESIDUAL RISK, accepted and recorded (coordinator, 2026-08-02): this reads the
 * CURRENT mission row, because that is the only wired path — `getMission` returns
 * the live row, and although `mission_runs.contract_snapshot_json` exists, no
 * code reads a ceiling out of it. So a mission edited mid-run can move its own
 * ceiling. Reading the frozen per-run snapshot instead is the correct long-term
 * fix and belongs with the lane that owns the mission contract, not here.
 *
 * `maxLaunchCount` is not on `MissionDraft` yet (see {@link MaxLaunchCountContract}),
 * so it resolves to `null` today and every autonomous launch refuses.
 */
export async function readMissionLaunchCeilings(
  missionId: string,
): Promise<AutonomousLaunchCeilings | null> {
  const mission = await getMission(missionId);
  if (mission === null) return null;

  const draft = missionToDraft(mission);
  const withCount = draft as Partial<MaxLaunchCountContract>;
  return {
    maxLaunchValueRaw: draft.maxLaunchValueRaw,
    maxLaunchValueDecimals: draft.maxLaunchValueDecimals,
    maxLaunchCount: withCount.maxLaunchCount ?? null,
  };
}
