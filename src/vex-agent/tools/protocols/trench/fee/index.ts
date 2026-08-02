/**
 * The Vex fee leg for Trench Express, runtime side — public gate.
 *
 * The venue arithmetic, constants and disclosure live in
 * `src/tools/trench-express/fee/`; this module is what the HANDLERS use: it
 * turns a charge base into a planned leg (`plan.ts`) and runs that leg after the
 * action confirmed (`run.ts`).
 *
 * THE CONTRACT EVERY CALLER MUST HONOUR — trade and launch alike:
 *
 *   1. `planTrenchFeeLeg(...)`. `null` means no fee at this size: no leg, NO
 *      ROW, and the skipped disclosure.
 *   2. APPEND `plan.event` as the LAST event of `createAgentActivityIntent`, so
 *      the fee row exists before anything is broadcast.
 *   3. Run the action's own legs. Do NOT put the fee leg in that loop — a revert
 *      or an abort there must not be able to reach it.
 *   4. Only on a CONFIRMED action, call `runTrenchFeeLeg`. On a reverted,
 *      ambiguous, or refused action, finalize the fee row as never-attempted
 *      (`trenchFeeNotAttempted`) and never sign it.
 *   5. Never fail the action because the fee failed. `runTrenchFeeLeg` cannot
 *      throw, and its report is disclosure — not an error path.
 *
 * For a LAUNCH the fee is spent ON TOP of `msg.value`, so `plan.feeWei` must be
 * added to `msg.value` before the mission spend ceiling is checked: a ceiling
 * that ignored a charge Vex itself imposes would be a misleading ceiling. That
 * means the fee is PLANNED before the ceiling check even though the leg RUNS
 * last.
 */

export {
  planTrenchFeeLeg,
  type PlanTrenchFeeLegInput,
  type TrenchFeeLegPlan,
  type TrenchFeeParentKind,
} from "./plan.js";

export {
  runTrenchFeeLeg,
  trenchFeeNotAttempted,
  trenchFeeNotCharged,
  type RunTrenchFeeLegInput,
  type TrenchFeeCollection,
} from "./run.js";
