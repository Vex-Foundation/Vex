/**
 * The gate's decision shape and the caught-failure → bounded-reason mapping.
 */

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { WalletPolicy } from "@vex-agent/engine/types.js";
import type { QuoteBindingPreview } from "../../quote-authority/restore.js";
import type { SpendabilityPreview } from "../../quote-authority/spendability-contract.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";

import { canonicalizeDebitPlan, type BoundDebitPlan } from "../../quote-authority/debit-plan.js";
import { GateIdentityError } from "../gate-errors.js";
import type { GateBlockReason } from "../gate-errors.js";

/**
 * Single gate decision. `allow` carries the matched prequote's verdict +
 * id (the verdict rides to the approval preview) and, when the matched quote
 * had a fee-on-transfer EVM leg, the bounded `fotTax` (max FoT tax percent
 * across the legs) so the restricted-mode approval preview can disclose it —
 * FoT is no longer a verdict `fail`, so without this a high-tax token would
 * read as a plain "pass". `block` carries a BOUNDED structural `reason` (for
 * the log) and an agent-facing `message`. No row contents, addresses, or raw
 * error text appear in any field.
 */
export type GateDecision =
  | {
      readonly kind: "allow";
      readonly verdict: SafetyVerdict;
      readonly prequoteId: string;
      readonly fotTax?: number;
      /**
       * Pendle term-lock (Wave 5). When a matched swap prequote's bounded
       * `safetyDetail` carries a `termLock`, the maturity date rides this TYPED
       * channel to the approval preview — it is sourced from the persisted
       * prequote, NEVER from raw args, so the LLM cannot inject or override it.
       */
      readonly termLock?: { readonly maturityIso: string };
      /**
       * Jupiter fee-bearing disclosure (W5 design §6 R4). When a matched
       * `solana.swap.execute` prequote's bounded `safetyDetail` carries a
       * `feePreview`, it rides this TYPED channel to the approval preview —
       * sourced from the persisted prequote, never raw args.
       */
      readonly feePreview?: JupiterFeePreview;
      /**
       * What the approval card states this proposal is bound to: the quoted
       * output, the floor the fill may not go below, the tolerance, the
       * snapshot digest and the row's own expiry. Read from the matched
       * prequote's stored snapshot, NEVER from raw args, so the model cannot
       * state a floor the store does not hold.
       */
      readonly quoteBinding?: QuoteBindingPreview;
      /**
       * What the wallet could pay when the matched quote was taken (WP2): the
       * source principal and the total native debit against the balances read
       * at that instant. Sourced from the matched row's persisted
       * `safetyDetail`, NEVER from raw args.
       *
       * DISCLOSURE, not authority. The card line says the numbers are
       * quote-time and re-read before signing; sign-time code must perform its
       * own authoritative read rather than consulting this.
       */
      readonly spendability?: SpendabilityPreview;
    }
  | { readonly kind: "block"; readonly reason: GateBlockReason; readonly message: string };

/**
 * Map a caught gate failure to a bounded block reason. Most throws are a genuine
 * fail-closed `gate_error`. A wallet-resolution VexError, however, means the
 * execute is CORRECTLY blocked (no usable signer / not authorized) yet the agent
 * must be told the ACCURATE cause — never the misleading "re-run the quote",
 * which sends it into a re-quote→re-execute loop. `resolveSelectedAddress`
 * (called at `computeGateMatch`, BEFORE any DB read) throws either
 * `WALLET_NOT_SELECTED` (no wallet for the family) or `WALLET_SCOPE_MISMATCH`
 * (invalid policy OR wallet-not-in-allowed-set); the latter splits on the
 * already-structured `walletPolicy` into the mission-SETUP case (a mission with
 * no active run) vs a contract-drift/scope case. Only the bounded reason class
 * flows onward — never raw wallet/DB/policy text — so the gate's no-leak doctrine
 * (and its fail-closed BLOCK outcome) are preserved; only the message becomes
 * truthful.
 */
export function classifyGateBlockReason(err: unknown, policy: WalletPolicy): GateBlockReason {
  if (err instanceof GateIdentityError) return err.gateReason;
  if (err instanceof VexError) {
    // No usable wallet for the family: none selected for the session, or none
    // configured at all (default resolution). Both → "select a wallet".
    if (
      err.code === ErrorCodes.WALLET_NOT_SELECTED ||
      err.code === ErrorCodes.WALLET_NOT_CONFIGURED
    ) {
      return "wallet_not_selected";
    }
    // WALLET_SCOPE_MISMATCH is overloaded: it is thrown for a mission-policy
    // rejection (assertWalletPolicy) AND for a selected-wallet drift/removal
    // (resolveSelectedEntry, which runs FIRST). We can only safely call it the
    // SETUP case when the policy itself is the invalid mission-setup one; every
    // other shape (active-run drift, wallet removed/changed, not-in-allowed-set,
    // or a non-mission session whose selected wallet drifted) maps to the
    // generic `wallet_scope`, whose message does NOT falsely assert a mission.
    if (err.code === ErrorCodes.WALLET_SCOPE_MISMATCH) {
      return policy.kind === "invalid" && policy.reason === "mission_without_active_run"
        ? "wallet_setup"
        : "wallet_scope";
    }
  }
  return "gate_error";
}

/**
 * Hold the plan the CARD would state against the plan the SNAPSHOT sealed.
 *
 * ## Why this check exists
 *
 * One row carries two independently written descriptions of the same set of
 * transactions. The spendability preview in `safety_detail` is what a person
 * READS on the approval card ("held 0.42 ETH covers this, and it will send
 * allowance -> swap"). The debit plan inside the route snapshot is what the
 * execute is HELD TO before signing (`compareDebitPlanRoles`). Nothing but this
 * comparison made the two agree, so a row whose card said one thing and whose
 * enforcement said another would have shown a human one plan and executed
 * against a different one. Rule 09 and rule 90 both put approval on the exact
 * proposal; two proposals in one row is not one proposal.
 *
 * ## The comparison
 *
 * Through {@link canonicalizeDebitPlan}, the same canonical form both venues
 * already digest their snapshots over, so the comparison is exactly the
 * equality the seal itself is built on - never a field-by-field re-derivation
 * that could drift from it.
 *
 * ## What is deliberately NOT refused
 *
 * A row that carries only ONE of the two artifacts passes through untouched.
 * Jupiter records no route snapshot at all (it has no claim lane), a venue that
 * measures no balances records no spendability preview, and a row written
 * before either lane existed carries neither. In every one of those cases there
 * is no second description to disagree with, and blocking would refuse quotes
 * that are perfectly consistent with themselves. This is a check for
 * CONTRADICTION, not a requirement that both artifacts exist.
 *
 * Returns the fail-closed block decision, or `null` when there is nothing to
 * refuse. The bounded `reason` is `card_plan_disagreement`, this class's own
 * member of the gate vocabulary, so the log line is as specific as the
 * message.
 */
export function checkSealedDebitPlanAgreement(
  cardPlan: BoundDebitPlan | undefined,
  sealedPlan: BoundDebitPlan | undefined,
): GateDecision | null {
  if (cardPlan === undefined || sealedPlan === undefined) return null;
  const card = canonicalizeDebitPlan(cardPlan);
  const sealed = canonicalizeDebitPlan(sealedPlan);
  if (card === sealed) return null;
  return {
    kind: "block",
    reason: "card_plan_disagreement",
    message:
      "Execute blocked: the card's plan and the sealed plan disagree - request a fresh quote."
      + ` The approval card would state the transaction plan recorded with this quote's spendability`
      + ` observation (${card}), while the execute would enforce the plan sealed into the quote's own`
      + ` route snapshot (${sealed}).`
      + " One of those two is not the thing you would be consenting to, so nothing was signed and"
      + " nothing was broadcast.",
  };
}
