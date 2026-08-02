/**
 * The Vex fee seam as the launch execute leg consumes it.
 *
 * This file WAS a standalone placeholder written while the fee lane was still
 * in flight. Now that `../../fee/` exists, it is a thin RE-EXPORT of the real
 * contract: keeping a parallel structural copy would let the two drift, and the
 * first symptom of that drift would be an unsafe cast on a signing path.
 *
 * The ordering contract the launch handler must honour is unchanged and lives
 * with the implementation (`../../fee/index.ts`):
 *
 *   1. plan the fee — `null` means no leg, NO ROW, and the skipped disclosure;
 *   2. append `plan.event` as the LAST event of the activity intent, so the row
 *      exists before anything is broadcast;
 *   3. run the launch's own legs — the fee leg is NOT in that loop;
 *   4. only on a CONFIRMED launch, run the fee; on reverted/ambiguous/refused,
 *      finalize the row as never-attempted and never sign it;
 *   5. never fail the launch because the fee failed.
 *
 * `runFeeLeg: null` still means "collector not wired" — a DISCLOSED state
 * (`fee_leg_not_wired`), never a silent skip: a launch that should have been
 * charged and was not is a fact the record must carry.
 */

import type { TrenchFeeLegPlan, PlanTrenchFeeLegInput } from "../../fee/index.js";
import type { runTrenchFeeLeg } from "../../fee/index.js";

export type { TrenchFeeLegPlan } from "../../fee/index.js";
export type { TrenchFeeCollection } from "../../fee/index.js";

/** The plan request, as the launch path expresses it (single-chain, msg.value base). */
export interface TrenchFeeLegPlanRequest {
  readonly basis: "launch_msg_value";
  readonly kind: "launch";
  readonly baseWei: bigint;
  readonly chainId: number;
  readonly walletAddress: PlanTrenchFeeLegInput["walletAddress"];
  readonly sessionId: string;
  readonly nativeAddress: PlanTrenchFeeLegInput["nativeAddress"];
  readonly usdVexFeeEst?: string | undefined;
}

export type PlanTrenchFeeLeg = (request: TrenchFeeLegPlanRequest) => TrenchFeeLegPlan | null;

/** Exactly the real runner's input minus the venue's fixed `chainId`, which the wiring supplies. */
export type RunTrenchFeeLeg = (
  input: Omit<Parameters<typeof runTrenchFeeLeg>[0], "chainId">,
) => ReturnType<typeof runTrenchFeeLeg>;

/** `runTrenchFeeLeg` reports its outcome on `collection`, not `status`. */
export type TrenchFeeCollectionStatus =
  Awaited<ReturnType<typeof runTrenchFeeLeg>>["collection"];

export interface LaunchExecuteDeps {
  readonly planFeeLeg: PlanTrenchFeeLeg;
  readonly runFeeLeg: RunTrenchFeeLeg | null;
}
