/**
 * The shared NATIVE Vex-fee leg - public gate for the pure half.
 *
 * A uniform bps cut of the native leg of an action, taken as Vex's OWN native
 * transfer that runs AFTER the action confirms:
 *
 *   BUY:    [buy(minOut) with value = amount - fee]  -> [transfer(treasury, fee)]
 *   SELL:   [approve] -> [sell(minOut)]              -> [transfer(treasury, fee)]
 *   LAUNCH: [launch with value = fee_c + prebuy]     -> [transfer(treasury, fee)]
 *
 * Leg order is a product decision, not an implementation detail, and it is the
 * same one `src/tools/bridge-fee/index.ts` states: an action that fails at any
 * point NEVER charges a fee for something that did not happen. The worst case is
 * that Vex misses revenue - never that the user pays for nothing. Do not reorder
 * to fee-first, and never retry an ambiguous fee: a blind retry of an
 * unconfirmed transfer could charge the user twice.
 *
 * WHY THIS MECHANISM. KyberSwap and Jupiter embed the fee in a router parameter.
 * The venues on this lane expose no such parameter, so a separate Vex-owned
 * transfer leg is the only mechanism available - which makes this the bridge's
 * sibling, not the aggregator swaps'.
 *
 * Modules:
 *   - `venue.ts`       what differs per venue (rate, treasury, role, prose)
 *   - `transfer.ts`    the native treasury transfer (no ERC-20 branch)
 *   - `disclosure.ts`  the one agent-facing disclosure shape
 *
 * The RUNTIME half (planning the activity row, signing the leg after the action
 * confirms) lives in `src/vex-agent/tools/protocols/shared/native-fee-leg/`,
 * because it touches the database and the broadcaster; this half is pure.
 */

export type { NativeFeeVenue, NativeFeeVenueNotes } from "./venue.js";
export { buildNativeFeeTransfer, type NativeFeeTransfer } from "./transfer.js";
export {
  buildNativeFeeDisclosure,
  buildNativeFeeSkippedDisclosure,
  type BuildNativeFeeDisclosureInput,
  type NativeFeeDisclosure,
} from "./disclosure.js";
