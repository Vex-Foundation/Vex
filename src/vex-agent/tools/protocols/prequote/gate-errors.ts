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
  | "unbindable_param" // bridge execute carries an EXECUTE-ONLY param (routeId /
                       // depositMethod) the quote can never bind - fail-closed
  | "not_executable"   // the newest matching quote recorded an eligibility other
                       // than `executable` (unusable route, or the wallet could
                       // not pay for it), so that quote authorizes nothing
  | "card_plan_disagreement" // the row carries TWO descriptions of the same
                       // transactions - the plan the approval card would state
                       // and the plan its route snapshot sealed - and they are
                       // not the same plan, so consent and enforcement would
                       // describe different things
  | "fee_disclosure_missing" // a FEE-BEARING gated execute matched a quote row
                       // that carries no Vex fee statement, so what Vex takes
                       // could be neither shown before signing nor re-checked
                       // at signing time - fail closed rather than sign a fee
                       // nobody stated
  // ── Approval-resume binding. The three below can fire ONLY on a dispatch
  // that resumes a decided approval card (`context.approvalId` present); a
  // fresh, non-approved call never reaches them. ──
  | "approval_row_superseded" // a newer quote for this identity was recorded
                       // while the card waited, so the row the card named is no
                       // longer the current one - even when the newer row is
                       // itself executable
  | "approved_disclosure_changed" // the bound row is still current, but the
                       // disclosure it carries now (fee preview, native
                       // ceiling, spendability plan, quote binding) is not the
                       // disclosure the card stated
  | "approval_binding_missing"; // an approval resume whose stored envelope names
                       // no quote row, so no row can be PROVEN to be the
                       // approved one - fail closed rather than pick one

/** A thrown identity-build error that already names its block reason. */
export class GateIdentityError extends Error {
  constructor(readonly gateReason: GateBlockReason) {
    super(gateReason);
    this.name = "GateIdentityError";
  }
}
