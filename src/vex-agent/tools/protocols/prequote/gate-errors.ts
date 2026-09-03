/**
 * Bounded gate block reasons + the identity-build error that names its reason.
 *
 * Kept in its own module so BOTH the gate (`gate.ts`) and the shared bridge
 * identity builder (`identity/bridge.ts`) can throw/catch `GateIdentityError`
 * without a circular import (the bridge builder is imported BY the gate, so it
 * cannot import the gate back). Pure types + a tiny error class - no IO.
 */

/** Bounded reason class for a gate block - never raw provider/DB/wallet text. */
export type GateBlockReason =
  | "gate_error"        // any thrown failure (DB / chain parse / resolve) - fail-closed
  | "no_session"        // missing sessionId on the execution context
  | "unresolved_token"  // EVM bare-symbol leg at execute (un-gateable identity)
  | "no_quote"          // no fresh matching prequote for these exact params
  | "safety_fail"       // a fresh prequote flagged the trade as a confirmed scam
  | "wallet_setup"      // mission SETUP - a mission exists with no active run yet, so
                        // the fail-closed resolver rejects (a broadcast needs a run)
  | "wallet_scope"      // selected wallet can't be used: drift/removal, or - when a
                        // mission is active - not in the accepted allowed set
  | "wallet_not_selected" // no wallet selected for the required chain family
  | "unbindable_param"; // bridge execute carries an EXECUTE-ONLY param (routeId /
                        // depositMethod) the quote can never bind - fail-closed

/** A thrown identity-build error that already names its block reason. */
export class GateIdentityError extends Error {
  constructor(readonly gateReason: GateBlockReason) {
    super(gateReason);
    this.name = "GateIdentityError";
  }
}
