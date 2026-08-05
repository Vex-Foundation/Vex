/**
 * Stage 7 — execute-time prequote gate.
 *
 * Quote-before-transaction: a swap EXECUTE may broadcast ONLY when a fresh
 * matching `swap` prequote exists and that prequote is not a confirmed scam.
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
import { classifyGateBlockReason } from "./gate/decision.js";
import type { GateDecision } from "./gate/decision.js";
import { block } from "./gate/messages.js";
import { computeGateMatch } from "./gate/identity.js";
import {
  feePreviewFromSafetyDetail,
  maxFotTaxFromSafetyDetail,
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

    // Guardrail #1 — a fresh confirmed-scam row dominates everything else.
    if (await prequoteRepo.existsFreshFailByMatch(sessionId, matchHash, gateKind)) {
      return block("safety_fail", gateKind);
    }

    const latest = await prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, gateKind);
    if (!latest) return block("no_quote", gateKind);

    // Belt-and-suspenders: even though existsFreshFail already ruled out a fresh
    // fail, never allow a `fail` latest row (guardrail #1).
    if (latest.safetyVerdict === "fail") return block("safety_fail", gateKind);

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
    let allow: GateDecision = { kind: "allow", verdict: latest.safetyVerdict, prequoteId: latest.prequoteId };
    if (fotTax !== undefined) allow = { ...allow, fotTax };
    if (termLock !== undefined) allow = { ...allow, termLock };
    if (feePreview !== undefined) allow = { ...allow, feePreview };
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
 * Re-fetch the SAME fresh matched `swap` prequote row `evaluatePrequoteGate`
 * already validated exists, for the EXECUTE HANDLER's own trade-shape
 * revalidation (W5 design §6 R4) — the fee-policy/swap-mode checks must
 * run on EVERY execute, not only when restricted-mode approval fires (a
 * full/autonomous-permission session skips the approval gate entirely, but
 * never the revalidation). Reuses `computeGateMatch` so the identity is
 * computed IDENTICALLY to the gate's own — no duplicated hash logic. Returns
 * `null` when no fresh match exists or the tool is not a gated `swap`
 * execute (defensive; the gate already ran first in the normal call order,
 * so this should not observably differ, but the handler must never assume).
 */
export async function findFreshMatchedSwapPrequote(
  toolId: string,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<SwapPrequote | null> {
  const gated = EXECUTE_GATE_TOOLS[toolId];
  if (!gated || gated.kind !== "swap") return null;
  const { matchHash } = await computeGateMatch(gated, sessionId, params, context);
  return prequoteRepo.findLatestFreshByMatch(sessionId, matchHash, "swap");
}
