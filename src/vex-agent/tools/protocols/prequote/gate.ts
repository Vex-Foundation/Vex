/**
 * Stage 7 — execute-time prequote gate.
 *
 * Quote-before-transaction: a swap EXECUTE may broadcast ONLY when a fresh
 * matching `swap` prequote exists, that prequote is not a confirmed scam, and
 * that prequote actually AUTHORIZED an execute (its eligibility is
 * `executable`).
 * The gate is the INVERSE of the recorder: the recorder swallows its errors
 * (a missing prequote is safe), but the gate FAILS CLOSED — any error, a
 * missing session, or an un-gateable token identity → BLOCK. The gate runs
 * BEFORE the approval gate in `executeProtocolTool`; an allow carries the
 * matched verdict to the restricted-mode approval preview (R5).
 *
 * NEVER leaks raw provider/DB/wallet text — only a bounded structural reason
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
import type { SpendabilityPreview } from "../quote-authority/spendability-contract.js";
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
 * `fail` row can never slip through — `existsFreshFailByMatch` (kind-scoped) is
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

    const { matchHash, family } = await computeGateMatch(gated, sessionId, params, context);

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
      // see it downstream). Prefix only — never the full hash or any address.
      logger.warn("protocol.prequote.gate.unknown_allowed", {
        toolId,
        family,
        matchHashPrefix: matchHash.slice(0, 8),
      });
    }
    // Surface a fee-on-transfer tax (if any) so the restricted-mode approval
    // preview can disclose it — FoT is no longer a verdict `fail` (only a
    // confirmed honeypot blocks), so without this a high-tax token reads as a
    // plain "pass". Sourced from the matched row's bounded `safetyDetail`, not
    // raw args. Bridge/Solana details have no FoT leg → undefined (omitted).
    const fotTax = maxFotTaxFromSafetyDetail(latest.safetyDetail);
    // Pendle term-lock (Wave 5) — rides the same TYPED channel as FoT for the
    // approval preview; sourced from the persisted prequote, never raw args.
    const termLock = termLockFromSafetyDetail(latest.safetyDetail);
    // Jupiter fee-bearing disclosure (W5 design §6 R4) — same typed channel.
    const feePreview = feePreviewFromSafetyDetail(latest.safetyDetail);
    // The quote this execute would be bound to, for the approval card. Absent
    // when the row carries no readable executable snapshot - the venues that
    // record none keep their existing card exactly.
    const quoteBinding = readQuoteBindingPreview(latest.prequoteId, latest.routeRef, latest.expiresAt);
    // What the wallet could pay when this quote was taken (WP2). Restored from
    // the row's own bounded `safetyDetail`, so the card's Required/Current
    // figures are the store's figures. Quote-time DISCLOSURE only - the
    // authoritative debit read belongs to the pre-sign window.
    const spendability = spendabilityFromSafetyDetail(latest.safetyDetail);
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
    let allow: GateDecision = { kind: "allow", verdict: latest.safetyVerdict, prequoteId: latest.prequoteId };
    if (fotTax !== undefined) allow = { ...allow, fotTax };
    if (termLock !== undefined) allow = { ...allow, termLock };
    if (feePreview !== undefined) allow = { ...allow, feePreview };
    if (quoteBinding !== undefined) allow = { ...allow, quoteBinding };
    if (spendability !== undefined) allow = { ...allow, spendability };
    return allow;
  } catch (err) {
    const reason = classifyGateBlockReason(err, context.walletPolicy);
    // Bounded structural log only — never raw provider/DB/wallet text. `reason`
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
 * Back-compat alias — the historical swap-only entry point. Delegates to the
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
 * `not_gated` is structural (the caller is not a gated `swap` execute) and can
 * never be produced by a race; the other three are the SAME three guardrails
 * the gate itself applies, restated by the second reader.
 */
export type MatchedSwapPrequoteRefusal =
  | "not_gated"
  | "no_quote"
  | "safety_fail"
  | "not_executable";

export type MatchedSwapPrequote =
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
    }
  | {
      readonly ok: false;
      readonly reason: MatchedSwapPrequoteRefusal;
      /** The recorded eligibility, present only on `not_executable`. */
      readonly eligibilityKind?: string;
    };

/**
 * Re-read the authorizing `swap` prequote row for the EXECUTE HANDLER's own
 * trade-shape revalidation (W5 design §6 R4) - the fee-policy/swap-mode checks
 * must run on EVERY execute, not only when restricted-mode approval fires (a
 * full/autonomous-permission session skips the approval gate entirely, but
 * never the revalidation). Reuses `computeGateMatch` so the identity is
 * computed IDENTICALLY to the gate's own, and `selectAuthorizedRow` so the
 * guardrails cannot drift from the gate's.
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
 * It deliberately does NOT pin the gate's exact `prequoteId`. A newer row for
 * the same match hash describes the SAME request (the hash binds every request
 * parameter) and, once it passes the same three guardrails, is an equally valid
 * authorization; refusing it would fail an execute whose newest quote is good.
 * What must never survive is a newer row that authorizes nothing, and that is
 * exactly what the guardrails here reject.
 */
export async function findFreshMatchedSwapPrequote(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<MatchedSwapPrequote> {
  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated || gated.kind !== "swap") return { ok: false, reason: "not_gated" };
  const { matchHash } = await computeGateMatch(gated, sessionId, params, context);
  const selected = await selectAuthorizedRow(sessionId, matchHash, "swap");
  return selected.ok
    ? {
      ok: true,
      prequote: selected.row,
      spendability: spendabilityFromSafetyDetail(selected.row.safetyDetail),
    }
    : selected;
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
