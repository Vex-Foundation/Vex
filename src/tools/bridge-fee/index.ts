/**
 * Vex bridge integrator fee — public gate.
 *
 * A uniform 25 bps cut of the INPUT token, taken as Vex's OWN transfer leg
 * that runs AFTER the bridge deposit, on every bridge in both directions and
 * at every venue. Venue-independent, route-independent, and exactly computable
 * before any quote exists.
 *
 * Leg order is a product decision, not an implementation detail:
 *
 *   EVM:    [approve(spender, amount − fee)] → [deposit(amount − fee)] → [transfer(treasury, fee)]
 *   Solana: [bridge deposit of (amount − fee)]                         → [SPL transfer(treasuryAta, fee)]
 *
 * The user's `amount` stays the TOTAL debited (matching the `currency_in`
 * semantics KyberSwap and Jupiter already use), and a bridge that fails at any
 * point NEVER charges a fee for a bridge that did not happen. The worst case is
 * that Vex misses revenue — never that the user pays for nothing. Do not
 * reorder to fee-first.
 *
 * Modules:
 *   - `constants.ts`           product-owner constants + the recorded event role
 *   - `fee-amount.ts`          exact bigint split of `amount` into fee + bridged
 *   - `fee-eligibility.ts`     which tokens Vex will skim (fee-on-transfer guard)
 *   - `evm-fee-transfer.ts`    ERC-20 `transfer` / native value transfer
 *   - `solana-fee-transfer.ts` SPL transfer to the treasury ATA (Token-2022 aware)
 *   - `fee-disclosure.ts`      the one agent-facing disclosure shape
 */

export {
  BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
  BRIDGE_FEE_BPS,
  BRIDGE_FEE_CHARGE_BY,
  BRIDGE_FEE_RECEIVER_EVM,
  BRIDGE_FEE_RECEIVER_SOLANA,
} from "./constants.js";

export { splitBridgeAmountForFee, type BridgeFeeSplit } from "./fee-amount.js";

export {
  buildEvmBridgeFeeTransfer,
  isNativeEvmFeeToken,
  type EvmBridgeFeeTransfer,
} from "./evm-fee-transfer.js";

export {
  buildSolanaBridgeFeeTransfer,
  type SolanaBridgeFeeTransfer,
} from "./solana-fee-transfer.js";

export {
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  type BridgeFeeDisclosure,
} from "./fee-disclosure.js";

export {
  evaluateEvmBridgeFeeEligibility,
  type BridgeFeeEligibility,
} from "./fee-eligibility.js";
