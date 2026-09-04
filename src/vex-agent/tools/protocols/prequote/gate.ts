/**
 * Stage 7 - execute-time prequote gate.
 *
 * Quote-before-transaction: a swap EXECUTE may broadcast ONLY when a fresh
 * matching `swap` prequote exists, that prequote is not a confirmed scam, and
 * that prequote actually AUTHORIZED an execute (its eligibility is
 * `executable`).
 * The gate is the INVERSE of the recorder: the recorder swallows its errors
 * (a missing prequote is safe), but the gate FAILS CLOSED - any error, a
 * missing session, or an un-gateable token identity → BLOCK. The gate runs
 * BEFORE the approval gate in `executeProtocolTool`; an allow carries the
 * matched verdict to the restricted-mode approval preview (R5).
 *
 * NEVER leaks raw provider/DB/wallet text - only a bounded structural reason
 * class reaches the log and the agent-facing message.
 *
 * This file is the public entry point and owns the decision FLOW; the pieces
 * live in the same-named sibling folder: `gate/decision.ts` (the decision shape
 * + failure classification), `gate/identity.ts` (execute-params → match-hash
 * extraction), `gate/safety-detail.ts` (approval-preview channels read out of
 * the matched row), and `gate/messages.ts` (agent-facing block rendering).
 */

import logger from "@utils/logger.js";

import { VexError } from "../../../../errors.js";
import type { ProtocolExecutionContext } from "../types.js";
import * as prequoteRepo from "@vex-agent/db/repos/swap-prequotes.js";
import type { PrequoteKind, SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";

import { EXECUTE_GATE_TOOLS } from "./registry.js";
import { checkSealedDebitPlanAgreement, classifyGateBlockReason } from "./gate/decision.js";
import type { GateDecision } from "./gate/decision.js";
import { block } from "./gate/messages.js";
import { computeGateMatch } from "./gate/identity.js";
import { readQuoteBindingPreview } from "../quote-authority/restore.js";
import type { QuoteBindingPreview } from "../quote-authority/restore.js";
import type { SpendabilityPreview } from "../quote-authority/spendability-contract.js";
import {
  approvedPrequoteAuthorityFrom,
  type ApprovedPrequoteAuthority,
} from "./approved-row-authority.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import {
  isFeeBearingGatedExecute,
  vexFeeFromSafetyDetail,
  type VexFeePreview,
} from "./fee-disclosure.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";
import {
  feePreviewFromSafetyDetail,
  sealedDebitPlanFromRouteRef,
  maxFotTaxFromSafetyDetail,
  spendabilityFromSafetyDetail,
  termLockFromSafetyDetail,
} from "./gate/safety-detail.js";

export type { GateDecision } from "./gate/decision.js";

/**
 * Evaluate the execute-time prequote gate for a gated EXECUTE (swap OR bridge).
 * Single decision; fail-closed to BLOCK on ANY failure. Guardrail #1: a fresh
 * `fail` row can never slip through - `existsFreshFailByMatch` (kind-scoped) is
 * checked FIRST (a later `pass`/`unknown` for the same identity cannot override
 * it), and the latest-row `fail` is re-checked as belt-and-suspenders. A bridge
 * prequote is always `unknown`, so the bridge path normally allows via the
 * unknown branch; the fail checks are kept for uniformity.
 */
export async function evaluatePrequoteGate(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<GateDecision> {
  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated) {
    // Defensive: callers only invoke for gated tools. Treat an unexpected tool
    // as a block rather than silently allowing an ungated execute. Default the
    // wording to the swap variant (the swap path is the historical caller).
    return block("gate_error", "swap");
  }
  const gateKind: PrequoteKind = gated.kind;

  try {
    const sessionId = context.sessionId;
    if (!sessionId) return block("no_session", gateKind);

    const { matchHash, family, bridgeRecipient } = await computeGateMatch(gated, sessionId, params, context);

    const selected = await selectAuthorizedRow(sessionId, matchHash, gateKind);
    if (!selected.ok) {
      if (selected.reason === "not_executable") {
        logger.info("protocol.prequote.gate.not_executable", {
          toolId,
          family,
          eligibilityKind: selected.eligibilityKind,
        });
        return block("not_executable", gateKind, `Recorded eligibility: ${selected.eligibilityKind}.`);
      }
      return block(selected.reason, gateKind);
    }
    const latest = selected.row;

    if (latest.safetyVerdict === "unknown") {
      // Surface that an un-audited identity is being allowed (preview/full-auto
      // see it downstream). Prefix only - never the full hash or any address.
      logger.warn("protocol.prequote.gate.unknown_allowed", {
        toolId,
        family,
        matchHashPrefix: matchHash.slice(0, 8),
      });
    }
    // Everything this row contributes to the approval card, read ONCE through
    // the one reader the resumed dispatch also uses - see `readRowDisclosure`.
    const { fotTax, termLock, feePreview, vexFee, quoteBinding, spendability } =
      readRowDisclosure(latest);
    // FAIL CLOSED ON A FEE NOBODY STATED. A fee-bearing execute whose matched
    // quote carries no Vex fee statement cannot show the human what Vex takes
    // and gives the executor nothing to be held to before signing. Rows written
    // by a build older than this lane land here, and the 15 minute freshness
    // window is what bounds that: one fresh quote and the row carries the block.
    if (vexFee === undefined && isFeeBearingGatedExecute(toolId)) {
      logger.warn("protocol.prequote.gate.fee_disclosure_missing", { toolId, family });
      return block("fee_disclosure_missing", gateKind);
    }
    // ONE ROW, TWO DESCRIPTIONS OF THE SAME TRANSACTIONS. The card states the
    // plan carried by the spendability preview; the execute is held to the plan
    // sealed inside the route snapshot. Nothing but this comparison made them
    // agree, so a row whose card said one thing and whose enforcement said
    // another would have shown a person one plan and executed a different one.
    // A row carrying only ONE of the two (Jupiter seals no snapshot; a venue
    // that measures no balances records no preview) has nothing to contradict
    // and passes through untouched - `checkSealedDebitPlanAgreement` owns that
    // rule. Fail closed on a real disagreement.
    const disagreement = checkSealedDebitPlanAgreement(
      spendability?.debitPlan,
      sealedDebitPlanFromRouteRef(latest.routeRef),
    );
    if (disagreement !== null && disagreement.kind === "block") {
      logger.warn("protocol.prequote.gate.card_plan_disagreement", { toolId, family });
      // The helper owns both the message and the reason class; nothing to restate.
      return disagreement;
    }
    // WHICH ROW, AND WHAT IT SAID. On a fresh call this only records the pair
    // the enqueue will store; on the resume of a decided approval it is also
    // the fence - the row the card named must still be the current one and must
    // still disclose what the card stated, or nothing executes.
    const prequoteAuthority = approvedPrequoteAuthorityFrom(latest.prequoteId, {
      verdict: latest.safetyVerdict,
      fotTax,
      termLock,
      feePreview,
      vexFee,
      quoteBinding,
      spendability,
    });
    const bindingFailure = approvedRowBindingFailure(context, prequoteAuthority);
    if (bindingFailure !== null) {
      logger.warn("protocol.prequote.gate.approval_binding_refused", {
        toolId,
        family,
        reason: bindingFailure,
      });
      return block(bindingFailure, gateKind);
    }
    let allow: GateDecision = {
      kind: "allow",
      verdict: latest.safetyVerdict,
      prequoteId: latest.prequoteId,
      prequoteAuthority,
    };
    if (fotTax !== undefined) allow = { ...allow, fotTax };
    if (termLock !== undefined) allow = { ...allow, termLock };
    if (feePreview !== undefined) allow = { ...allow, feePreview };
    if (vexFee !== undefined) allow = { ...allow, vexFee };
    if (bridgeRecipient !== undefined) allow = { ...allow, bridgeRecipient };
    if (quoteBinding !== undefined) allow = { ...allow, quoteBinding };
    if (spendability !== undefined) allow = { ...allow, spendability };
    return allow;
  } catch (err) {
    const reason = classifyGateBlockReason(err, context.walletPolicy);
    // Bounded structural log only - never raw provider/DB/wallet text. `reason`
    // now disambiguates the wallet cases (wallet_setup / wallet_scope /
    // wallet_not_selected) that previously all collapsed to `gate_error`.
    logger.warn("protocol.prequote.gate.error", {
      toolId,
      reason,
      errorClass:
        err instanceof VexError
          ? err.code
          : err instanceof Error
            ? err.constructor.name
            : "unknown",
    });
    return block(reason, gateKind);
  }
}

/**
 * Back-compat alias - the historical swap-only entry point. Delegates to the
 * kind-aware `evaluatePrequoteGate` (the gated registry now carries the kind).
 * Retained so existing swap callers/tests keep working unchanged.
 */
export async function evaluateSwapPrequoteGate(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<GateDecision> {
  return evaluatePrequoteGate(toolId, params, context);
}

/**
 * Why a re-read of the authorizing row found nothing it may execute on.
 *
 * `not_gated` is structural (the caller is not a gated execute at all) and can
 * never be produced by a race; the other three are the SAME three guardrails
 * the gate itself applies, restated by the second reader.
 */
export type MatchedPrequoteRefusal =
  | "not_gated"
  | "no_quote"
  | "safety_fail"
  | "not_executable"
  | ApprovalBindingRefusal;

/**
 * The three ways a dispatch that RESUMES a decided approval can fail to prove
 * that the row in front of it is the row the human approved.
 *
 * They are the gate's block reasons under their own name so the two readers -
 * the gate and the handler's re-read - refuse the same three states with the
 * same vocabulary rather than inventing a second one.
 */
export type ApprovalBindingRefusal =
  | "approval_row_superseded"
  | "approved_disclosure_changed"
  | "approval_binding_missing";

export type MatchedPrequote =
  | {
      readonly ok: true;
      readonly prequote: SwapPrequote;
      /**
       * The quote-time spendability facts the APPROVAL CARD carried, parsed by
       * the same owner the gate uses, so the handler binds its execution to the
       * numbers a person actually saw rather than re-deriving them. `undefined`
       * for a venue that measures no balances.
       */
      readonly spendability: SpendabilityPreview | undefined;
      /**
       * The Vex fee statement the matched row carries, parsed by the same owner
       * the gate and the card use. This is what an executor re-derives its own
       * disposition against before signing: the card stated THIS block, so a
       * fee that no longer matches it is a fee nobody consented to.
       *
       * `undefined` only for a venue that carries no Vex fee on this channel -
       * a fee-bearing execute never reaches an `ok: true` without one, because
       * the gate refuses it first.
       */
      readonly vexFee: VexFeePreview | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: MatchedPrequoteRefusal;
      /** The recorded eligibility, present only on `not_executable`. */
      readonly eligibilityKind?: string;
    };

/**
 * Re-read the authorizing prequote row for the EXECUTE HANDLER's own
 * trade-shape revalidation (W5 design §6 R4) - the fee-policy/swap-mode checks
 * must run on EVERY execute, not only when restricted-mode approval fires (a
 * full/autonomous-permission session skips the approval gate entirely, but
 * never the revalidation). Reuses `computeGateMatch` so the identity is
 * computed IDENTICALLY to the gate's own, and `selectAuthorizedRow` so the
 * guardrails cannot drift from the gate's. It serves EVERY gated kind, not only
 * swaps: a bridge executor needs the same re-read to hold its own fee leg to
 * the statement the card carried.
 *
 * THE RACE THIS CLOSES. `evaluatePrequoteGate` runs first, in
 * `executeProtocolTool`, and approves the row that was latest THEN. This read
 * happens later, in the handler, and asks the store again. Between the two, a
 * concurrent quote for the SAME identity can record a newer row - and until
 * this function applied the guardrails itself, a newer row that recorded
 * `insufficient_balance`, `balance_unavailable` or a confirmed-scam verdict
 * superseded the approved one silently and the execute carried on. The venues
 * that record a route snapshot are additionally protected by the atomic claim's
 * `eligibility_kind = 'executable'` predicate; Jupiter has no claim lane, so
 * for it this read WAS the only remaining reader and it validated nothing.
 *
 * WHEN NO APPROVAL IS IN PLAY it deliberately does NOT pin the gate's exact
 * `prequoteId`. A newer row for the same match hash describes the SAME request
 * (the hash binds every request parameter) and, once it passes the same three
 * guardrails, is an equally valid authorization; refusing it would fail an
 * execute whose newest quote is good. What must never survive is a newer row
 * that authorizes nothing, and that is exactly what the guardrails here reject.
 *
 * WHEN A DECIDED APPROVAL AUTHORIZED THIS DISPATCH the opposite is true, and
 * `approvedRowBindingFailure` applies: a person consented to ONE row and to the
 * fee preview and native-cost ceiling that row disclosed, so a newer row - even
 * an executable one - is `approval_row_superseded` rather than a substitute.
 */
export async function findFreshMatchedPrequote(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<MatchedPrequote> {
  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated) return { ok: false, reason: "not_gated" };
  const { matchHash } = await computeGateMatch(gated, sessionId, params, context);
  const selected = await selectAuthorizedRow(sessionId, matchHash, gated.kind);
  if (!selected.ok) return selected;
  // THE SECOND READER APPLIES THE SAME FENCE. The gate already refused a
  // resumed dispatch whose bound row moved, but the gate ran earlier and this
  // read asks the store again; a quote recorded in between would otherwise
  // become the row a Jupiter execute derives its fee policy and its approved
  // native ceiling from. Absent binding on a fresh (non-approval) call leaves
  // the historical newest-row behaviour untouched.
  const disclosure = readRowDisclosure(selected.row);
  const bindingFailure = approvedRowBindingFailure(
    context,
    approvedPrequoteAuthorityFrom(selected.row.prequoteId, {
      verdict: selected.row.safetyVerdict,
      ...disclosure,
    }),
  );
  if (bindingFailure !== null) return { ok: false, reason: bindingFailure };
  return {
    ok: true,
    prequote: selected.row,
    spendability: disclosure.spendability,
    vexFee: disclosure.vexFee,
  };
}

/**
 * Everything a matched row contributes to the approval card, read through the
 * row's OWN persisted evidence.
 *
 * One reader, because the digest computed at enqueue and the digest recomputed
 * at resume must be built from the same projection of the same row: two readers
 * that drifted would either wave through a changed disclosure or refuse an
 * unchanged one, and both failures are silent.
 */
function readRowDisclosure(row: SwapPrequote): {
  readonly fotTax: number | undefined;
  readonly termLock: { readonly maturityIso: string } | undefined;
  readonly feePreview: JupiterFeePreview | undefined;
  readonly vexFee: VexFeePreview | undefined;
  readonly quoteBinding: QuoteBindingPreview | undefined;
  readonly spendability: SpendabilityPreview | undefined;
} {
  return {
    // Fee-on-transfer tax, so the restricted-mode approval preview can disclose
    // it - FoT is no longer a verdict `fail` (only a confirmed honeypot
    // blocks), so without this a high-tax token reads as a plain "pass".
    // Sourced from the row's bounded `safetyDetail`, never raw args.
    // Bridge/Solana details have no FoT leg, so they yield undefined.
    fotTax: maxFotTaxFromSafetyDetail(row.safetyDetail),
    // Pendle term-lock (Wave 5), same typed channel, same source.
    termLock: termLockFromSafetyDetail(row.safetyDetail),
    // Jupiter fee-bearing disclosure (W5 design section 6 R4), same channel.
    feePreview: feePreviewFromSafetyDetail(row.safetyDetail),
    // The Vex fee statement the quote made (charged or skipped, the exact
    // atomic amount, the token, the treasury, and when it is collected). Same
    // channel, same source, re-parsed with the schema the recorder validated
    // against - never recomputed from args.
    vexFee: vexFeeFromSafetyDetail(row.safetyDetail),
    // The quote this execute would be bound to, for the approval card. Absent
    // when the row carries no readable executable snapshot - the venues that
    // record none keep their existing card exactly.
    quoteBinding: readQuoteBindingPreview(row.prequoteId, row.routeRef, row.expiresAt),
    // What the wallet could pay when this quote was taken (WP2). Quote-time
    // DISCLOSURE only - the authoritative debit read belongs to the pre-sign
    // window.
    spendability: spendabilityFromSafetyDetail(row.safetyDetail),
  };
}

/**
 * Does the row in front of this dispatch prove it is the row a human approved?
 *
 * Applies ONLY when `context.approvalId` says a decided approval card is what
 * authorized this call - the one host-side fact that can never be derived from
 * model input. A fresh call has no consent to contradict, so it keeps today's
 * newest-executable-row behaviour untouched.
 *
 * Three refusals, three genuinely different states (rule 04):
 *
 *   `approval_row_superseded`      - a newer quote for the same identity is now
 *      the current row. It may be perfectly executable; it is simply not the one
 *      that was shown, and substituting it is exactly the approve-Q1/execute-Q2
 *      window this fence exists to close.
 *   `approved_disclosure_changed`  - the bound row is still current but the
 *      disclosure it carries (fee preview, native ceiling, spendability plan,
 *      quote binding) is no longer the disclosure the card stated.
 *   `approval_binding_missing`     - the approval records no row at all, so no
 *      row can be PROVEN to be the approved one. Fail closed rather than pick,
 *      matching the claim lane's `unbound_approval` (`claim.ts`); the way out is
 *      a fresh quote, which does bind.
 */
function approvedRowBindingFailure(
  context: ProtocolExecutionContext,
  computed: ApprovedPrequoteAuthority,
): ApprovalBindingRefusal | null {
  if (typeof context.approvalId !== "string" || context.approvalId.length === 0) return null;
  const approved = context.approvedPrequoteAuthority ?? null;
  if (approved === null) return "approval_binding_missing";
  if (approved.prequoteId !== computed.prequoteId) return "approval_row_superseded";
  if (approved.disclosureDigest !== computed.disclosureDigest) return "approved_disclosure_changed";
  return null;
}

/**
 * The one place the three prequote guardrails are applied, so the gate and the
 * handler's re-read cannot disagree about what a row authorizes.
 *
 * Order is the contract:
 *
 *   1. a fresh confirmed-scam row for this identity dominates everything else
 *      (a later `pass`/`unknown` cannot override it);
 *   2. a `fail` latest row is refused as belt-and-suspenders;
 *   3. a row whose recorded eligibility is anything but `executable` authorized
 *      nothing - an unusable route, or (WP2) a wallet that could not pay.
 *
 * A bridge prequote is always `unknown`, so the bridge path normally reaches
 * the caller through the executable branch; the fail checks are kept for
 * uniformity.
 */
async function selectAuthorizedRow(
  sessionId: string,
  matchHash: string,
  kind: PrequoteKind,
): Promise<
  | { readonly ok: true; readonly row: SwapPrequote }
  | { readonly ok: false; readonly reason: "no_quote" | "safety_fail" }
  | { readonly ok: false; readonly reason: "not_executable"; readonly eligibilityKind: string }
> {
  if (await prequoteRepo.existsFreshFailByMatch(sessionId, matchHash, kind)) {
    return { ok: false, reason: "safety_fail" };
  }
  const latest = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, kind);
  if (!latest) return { ok: false, reason: "no_quote" };
  if (latest.safetyVerdict === "fail") return { ok: false, reason: "safety_fail" };
  if (latest.eligibilityKind !== "executable") {
    return { ok: false, reason: "not_executable", eligibilityKind: latest.eligibilityKind };
  }
  return { ok: true, row: latest };
}
