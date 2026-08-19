/**
 * Vex's Trench Express integrator fee — public gate.
 *
 * A uniform 25 bps cut of the ETH LEG of every Trench Express action, taken as
 * Vex's OWN native transfer that runs AFTER the trade or launch confirms:
 *
 *   BUY:    [buy(minOut) with value = amount − fee]  → [transfer(treasury, fee)]
 *   SELL:   [approve] → [sell(minOut)]               → [transfer(treasury, fee)]
 *   LAUNCH: [create with value = fee_c + prebuy]     → [transfer(treasury, fee)]
 *
 * Leg order is a product decision, not an implementation detail, and it is the
 * same one `src/tools/bridge-fee/index.ts` states: an action that fails at any
 * point NEVER charges a fee for something that did not happen. The worst case is
 * that Vex misses revenue — never that the user pays for nothing. Do not reorder
 * to fee-first, and never retry an ambiguous fee: a blind retry of an
 * unconfirmed transfer could charge the user twice.
 *
 * WHY THE BRIDGE MECHANISM AND NOT THE SWAP ONE. KyberSwap and Jupiter embed
 * the fee in a router/provider parameter. The Trench Diamond exposes no such
 * parameter, so a separate Vex-owned transfer leg is the only mechanism
 * available — which makes this module the bridge's sibling, not the swap
 * venues'.
 *
 * ON A BUY the curve is quoted for `amount − fee`, so the disclosed
 * `expectedOut`/`minOut` are post-fee and are what actually arrives. On a SELL
 * and a LAUNCH the fee does not reduce the principal: the sell's proceeds and
 * the launch's `msg.value` are what they are, and the fee is a separate later
 * transaction.
 *
 * Modules:
 *   - `constants.ts`       product-owner constants, the charge-base rationale,
 *                          and the recorded `trench_fee` event role
 *   - `venue.ts`           Trench as the SHARED native-fee lane sees it
 *   - `fee-amount.ts`      which ETH leg the fee applies to + the exact split
 *   - `fee-transfer.ts`    the native treasury transfer (no ERC-20 branch)
 *   - `fee-disclosure.ts`  the one agent-facing disclosure shape
 *
 * The MECHANISM behind the last three now lives in
 * `@tools/vex-fee/native-leg/`, shared with the other venues on this lane
 * (owner decision 2026-08-18, taken when pools.fun would have become the fourth
 * hand-written copy). What stayed here is what is genuinely Trench's: the rate,
 * the charge-base union and its reasoning, the recorded role, and the prose.
 */

export {
  TRENCH_FEE_ACTIVITY_EVENT_ROLE,
  TRENCH_FEE_BPS,
  TRENCH_FEE_RECEIVER_EVM,
  type TrenchFeeBasis,
} from "./constants.js";

export {
  splitTrenchEthForFee,
  trenchFeeBaseWei,
  type TrenchFeeBaseInput,
  type VexFeeBpsSplit,
} from "./fee-amount.js";

export { TRENCH_FEE_VENUE } from "./venue.js";

export { buildTrenchFeeTransfer, type TrenchFeeTransfer } from "./fee-transfer.js";

export {
  buildTrenchFeeDisclosure,
  buildTrenchFeeSkippedDisclosure,
  type TrenchFeeDisclosure,
} from "./fee-disclosure.js";
