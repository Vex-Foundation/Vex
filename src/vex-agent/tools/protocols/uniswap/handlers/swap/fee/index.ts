/**
 * The Vex fee leg for Uniswap, runtime side - public gate.
 *
 * The venue arithmetic, constants and disclosure live in `@tools/uniswap/fee`;
 * this module is what the HANDLER uses: it turns a resolved charge into a
 * planned leg (`plan.ts`) and runs that leg after the swap confirmed
 * (`run.ts`).
 *
 * THE CONTRACT THE CALLER MUST HONOUR:
 *
 *   1. `resolveUniswapFeeCharge(...)` BEFORE quoting - the route is priced for
 *      `amountIn − fee`, so the fee decision cannot come after the quote.
 *   2. `planUniswapFeeLeg(...)`. `null` means no fee at this size: no leg, NO
 *      ROW, and the skipped disclosure.
 *   3. APPEND `plan.event` as the LAST event of `createAgentActivityIntent`, so
 *      the fee row exists before anything is broadcast.
 *   4. Run the swap's own legs. Do NOT put the fee leg in that loop - a revert
 *      or an abort there must not be able to reach it.
 *   5. Only on a CONFIRMED swap, call `runUniswapFeeLeg`. On a reverted,
 *      ambiguous, or refused swap, the never-signed rows (the fee row among
 *      them) are finalized through `abortPlannedEvents` and the fee is never
 *      signed.
 *   6. Never fail the swap because the fee failed. `runUniswapFeeLeg` cannot
 *      throw, and its report is disclosure - not an error path.
 *
 * The balance guard must require the FULL `amountIn` (net + fee), not the net:
 * the user is debited both legs.
 */

export { planUniswapFeeLeg, type UniswapFeeLegPlan } from "./plan.js";

export { withFeeDisclosure } from "./attach.js";

export {
  runUniswapFeeLeg,
  uniswapFeeNotAttempted,
  uniswapFeeNotCharged,
  type RunUniswapFeeLegInput,
  type UniswapFeeCollection,
} from "./run.js";
