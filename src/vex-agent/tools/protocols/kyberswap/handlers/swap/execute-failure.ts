/**
 * What `kyberswap.swap.execute` tells the agent — and writes to
 * `agent_activity` — when the staged broadcast loop throws AFTER the intent
 * already exists.
 *
 * Three outcomes, in the order they are decided:
 *   1. `DependentLegGasEstimateError` — a leg refused after a leg THIS plan
 *      already confirmed (its own wording, plus the one pool-state narrowing).
 *   2. a classified PRE-SIGN revert with nothing broadcast — a refusal.
 *   3. anything else — the honest "interrupted after it was recorded" wording,
 *      which must never be claimed for the first two.
 *
 * The distinction that decides 2 is `legBroadcastAttempted`, never "was there
 * an allowance leg": a leg whose hash was staged can no longer claim pre-sign
 * safety, whatever its error looks like.
 */

import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  classifyDependentLegPoolStateRevert,
  classifyPreSignRevert,
  dependentLegPoolStateRefusalGuidance,
  preSignRefusalGuidance,
} from "@tools/evm-chains/pre-sign-revert-refusal.js";
import { KYBERSWAP_MAX_SLIPPAGE_BPS } from "@tools/kyberswap/constants.js";
import { effectiveMaxSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../../types.js";
import { abortRemainingPlans, failRefusedLeg } from "./activity-recording.js";
import { kyberFailureMessage } from "./error-output.js";
import type { SwapEventPlan } from "./execute-plan.js";
import { revealOnPreSignRevert } from "./reveal-messaging.js";

export interface PostIntentFailureInput {
  readonly err: unknown;
  readonly toolId: string;
  readonly sessionId: string;
  readonly executionId: number;
  readonly currentIndex: number;
  /** True once THIS leg's hash was staged — past that point pre-sign safety can no longer be claimed. */
  readonly legBroadcastAttempted: boolean;
  readonly plans: readonly SwapEventPlan[];
  readonly events: readonly AgentActivityEvent[];
  readonly slippage: number;
  /**
   * The price impact of the build this execution was signing, as a FRACTION
   * (KyberSwap's own convention — `helpers.ts`), so a slippage refusal can put
   * the observed impact next to the tolerance that was applied. `null` when the
   * build carried no usable USD legs.
   */
  readonly observedPriceImpactFraction: number | null;
}

export async function buildPostIntentFailureResult(input: PostIntentFailureInput): Promise<ToolResult> {
  const { err, toolId, sessionId, executionId, currentIndex, legBroadcastAttempted, plans, events, slippage } = input;
  const slippageBounds = {
    appliedBps: slippage,
    maxBps: effectiveMaxSlippageBps(KYBERSWAP_MAX_SLIPPAGE_BPS),
    observedPriceImpactFraction: input.observedPriceImpactFraction,
  };

  // C18: the intent already exists — never call failPreBroadcast (that
  // would create a SECOND execution). Abort every planned row from the
  // CURRENT index onward (it never got a hash persisted either, whether
  // this is a CAS-miss throw or any other unexpected failure) and return
  // with the SAME `_executionId`.
  const safeMessage = kyberFailureMessage(toolId, err);
  const refusedRole = plans[currentIndex]?.eventRole ?? "swap";
  // The chain refused this leg's PRE-SIGN estimate and nothing of ours
  // went to the wire: a refusal, not an interruption of unknown scope.
  // Reporting it as "already recorded, check the record" stranded a live
  // autonomous mission on 2026-07-25 (`evm-chains/pre-sign-revert-refusal.ts`
  // carries the full incident). Classified BEFORE the abort sweep so the
  // row can keep its real code; `null` for a `DependentLegGasEstimateError`
  // (its own branch below) and for any error we cannot place.
  const preSignRevert = legBroadcastAttempted ? null : classifyPreSignRevert(err);
  // The DECODED reason, not viem's verbose message — but still through
  // this venue's single scrub boundary (C37), because the string is chosen
  // by the contract, not by us. Same treatment `uniswap.swap.execute`
  // gives its own classified reason.
  const safeRevertReason = preSignRevert
    ? kyberFailureMessage(toolId, preSignRevert.revertReason)
    : "";
  if (preSignRevert) {
    await failRefusedLeg(events[currentIndex], preSignRevert.failureCode, safeRevertReason);
  }
  await abortRemainingPlans(executionId, currentIndex, safeMessage);
  logger.warn("kyberswap.swap.execute.post_intent_failure", { executionId, index: currentIndex, error: safeMessage });
  // A leg refused because its estimate never succeeded after an allowance
  // this same execute confirmed is NOT the same event as an internal
  // interruption of unknown scope: nothing was signed for it, the planned
  // rows are finalized "not attempted", and re-running is safe. Saying
  // otherwise is what made a transient RPC lag permanent for an agent
  // (live 2026-07-24/25 — `dependent-leg-gas-estimate.ts`).
  if (err instanceof DependentLegGasEstimateError) {
    // ERC-20 input (the common USDC→X shape): with an allowance leg in
    // front, a genuine price-guard refusal can only reach the agent HERE,
    // and the RPC-lag wording — actionable, but naming no parameter — left
    // it unable to fix the one thing that was wrong. A POOL-STATE reason
    // that survived every retry is admissible evidence (the narrowing and
    // its two arguments live in `pre-sign-revert-refusal.ts`); every other
    // reason keeps the branch below, unchanged.
    const poolState = classifyDependentLegPoolStateRevert(err);
    if (poolState) {
      return {
        success: false,
        output: `${toolId}: the ${refusedRole} step was refused before signing. ${dependentLegPoolStateRefusalGuidance({
          error: err,
          // Chain-controlled text through this venue's single scrub boundary (C37).
          revertReason: kyberFailureMessage(toolId, poolState.revertReason),
          failureCode: poolState.failureCode,
          slippage: slippageBounds,
        })} Recorded as execution ${executionId}.`,
        data: { _executionId: executionId, status: "not_attempted", retryable: true, failureCode: poolState.failureCode },
      };
    }
    return {
      success: false,
      output: `${toolId}: the ${refusedRole} step could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} Recorded as execution ${executionId}; the node reported: ${safeMessage}`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true },
    };
  }
  if (preSignRevert) {
    // The refusal's own remedy already tells the agent to try another venue
    // when it knows of no better move — so the venue has to actually be
    // reachable. Appended, never substituted: the chain's reason and the
    // remedy remain the primary content of the message.
    const revealSuffix = revealOnPreSignRevert({
      eventRole: refusedRole,
      legBroadcastAttempted,
      failureCode: preSignRevert.failureCode,
      sessionId,
    });
    return {
      success: false,
      output: `${toolId}: the ${refusedRole} step was refused before signing. ${preSignRefusalGuidance({
        revertReason: safeRevertReason,
        failureCode: preSignRevert.failureCode,
        slippage: slippageBounds,
      })} Recorded as execution ${executionId}.${revealSuffix}`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true, failureCode: preSignRevert.failureCode },
    };
  }
  return {
    success: false,
    output: `${toolId}: an internal error interrupted the swap after it was already recorded — ${safeMessage}. Check the record (execution ${executionId}) before taking any further action.`,
    data: { _executionId: executionId, status: "pending" },
  };
}
