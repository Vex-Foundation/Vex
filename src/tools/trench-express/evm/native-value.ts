/**
 * Native-value proof for a payable Trench Express curve BUY.
 *
 * A curve `buy` is payable: the entire `tx.value` is the user's OWN ETH
 * principal being spent on the curve (the 1% fee is taken INSIDE the contract,
 * out of that principal — it is not an extra debit). Vex builds this value from
 * its own arithmetic, so it is attributed as a `vex_constructed` native
 * principal. The classifier then requires every wei of `tx.value` to be that
 * principal; any unattributed remainder is refused by
 * `checkNativeValueAuthorizedForCall` — see `native-value-authorization`.
 */

import type { ProvenComponent } from "@tools/evm-chains/native-value-authorization/index.js";

/** The user's own ETH principal for a curve buy, as a proven component. */
export function curveBuyNativePrincipal(valueWei: bigint): ProvenComponent {
  return {
    amountWei: valueWei,
    recipient: null,
    refund: "spent_not_recoverable",
    evidence: { source: "vex_constructed", detail: "trench curve buy ETH principal" },
  };
}
