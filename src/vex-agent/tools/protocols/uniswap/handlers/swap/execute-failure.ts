/**
 * How a Uniswap execute that got past the intent tells the agent what happened.
 *
 * Wording is the safety surface here: a sign-time refusal (no bytes, no gas, no
 * possible duplicate) must never be described in the same words as a MINED
 * revert, and an AMBIGUOUS broadcast must never invite a retry.
 */

import { DependentLegGasEstimateError, dependentLegEstimateGuidance } from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import {
  classifyDependentLegPoolStateRevert,
  dependentLegPoolStateRefusalGuidance,
  preSignRefusalGuidance,
} from "@tools/evm-chains/pre-sign-revert-refusal.js";
import { effectiveMaxSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../../../types.js";
import { TOOL_ID } from "./protocol-id.js";
import { uniswapFailureMessage } from "./error-output.js";
import { abortRemainingPlans } from "./activity-recording.js";
import type { Classification, PreBroadcastClassification } from "./execute-broadcast.js";

export function ambiguousBroadcastResult(input: {
  readonly eventRole: AgentActivityEvent["eventRole"];
  readonly txHash: string;
  readonly executionId: number;
  readonly chainId: number;
}): ToolResult {
  return {
    success: false,
    // "Do not retry" is the safety-critical half and never moves. The
    // second half gives the agent a READ it can perform itself instead
    // of waiting on the sweep — the alternative to waiting must never
    // be a re-broadcast.
    output: `${TOOL_ID}: broadcast of the ${input.eventRole} transaction (${input.txHash}) could not be confirmed yet — it may still settle on-chain. Do not retry; this attempt is recorded as pending and will resolve automatically. You can verify it now yourself with chain_read (action tx_receipt, chain=${input.chainId}, txHash=${input.txHash}).`,
    data: { _executionId: input.executionId, txHash: input.txHash, status: "pending" },
  };
}

/**
 * A sign-time refusal never reached the network — no bytes, no gas, no
 * possible duplicate. Calling it a transaction that "failed" made the agent
 * read a routine, recoverable slippage refusal as a lost trade, with no remedy
 * named (`evm-chains/pre-sign-revert-refusal.ts` carries the incident).
 */
export function preSignRefusalResult(input: {
  readonly eventRole: AgentActivityEvent["eventRole"];
  readonly classification: PreBroadcastClassification;
  readonly slippageBps: number;
  readonly executionId: number;
}): ToolResult {
  return {
    success: false,
    output: `${TOOL_ID}: the ${input.eventRole} step was refused before signing. ${preSignRefusalGuidance({
      // Already through this venue's single scrub boundary (C37).
      revertReason: input.classification.failureReason,
      failureCode: input.classification.failureCode,
      slippage: { appliedBps: input.slippageBps, maxBps: effectiveMaxSlippageBps() },
    })} Recorded as execution ${input.executionId}.`,
    data: {
      _executionId: input.executionId, status: "not_attempted", retryable: true,
      failureCode: input.classification.failureCode,
    },
  };
}

/**
 * Only a MINED revert reaches here, so the reason is one of
 * `mined-revert-reason.ts`'s self-terminating sentences — no sentence period is
 * added after it.
 */
export function minedRevertResult(input: {
  readonly eventRole: AgentActivityEvent["eventRole"];
  readonly classification: Classification;
  readonly executionId: number;
}): ToolResult {
  return {
    success: false,
    output: `${TOOL_ID}: the ${input.eventRole} transaction failed (${input.classification.failureCode}): ${input.classification.failureReason} No further steps were attempted.`,
    data: { _executionId: input.executionId, status: "failed" },
  };
}

/**
 * C18 (Codex final-review round 1, finding 3): the intent already exists —
 * finalize what's left, SAME `_executionId`, never a second execution (never
 * `failPreBroadcast` here).
 */
export async function postIntentFailureResult(input: {
  readonly executionId: number;
  readonly refusedRole: AgentActivityEvent["eventRole"];
  readonly slippageBps: number;
  readonly error: unknown;
}): Promise<ToolResult> {
  const { executionId, error: err } = input;
  await abortRemainingPlans(executionId, 0, `execute aborted: ${uniswapFailureMessage(err)}`);
  logger.warn("uniswap.swap.execute.unexpected_error", {
    executionId, error: uniswapFailureMessage(err),
  });
  // A leg refused because its estimate never succeeded after an allowance
  // this same execute confirmed is not an unexpected internal failure:
  // nothing was signed for it, the never-signed rows are finalized "not
  // attempted" (the confirmed approval row is untouched — it has a hash),
  // and re-running is safe.
  if (err instanceof DependentLegGasEstimateError) {
    // ERC-20 input — the common shape, and the one the native-input fix did
    // not reach: with an approval leg in front, a genuine price-guard refusal
    // arrives ONLY here, and the RPC-lag wording named no parameter the agent
    // could change. A POOL-STATE reason that survived every retry is
    // admissible evidence (the narrowing and its two arguments live in
    // `pre-sign-revert-refusal.ts`); every other reason keeps the wording below.
    const poolState = classifyDependentLegPoolStateRevert(err);
    if (poolState) {
      return {
        success: false,
        output: `${TOOL_ID}: the ${input.refusedRole} step was refused before signing. ${dependentLegPoolStateRefusalGuidance({
          error: err,
          // Chain-controlled text through this venue's single scrub boundary (C37).
          revertReason: uniswapFailureMessage(poolState.revertReason),
          failureCode: poolState.failureCode,
          slippage: { appliedBps: input.slippageBps, maxBps: effectiveMaxSlippageBps() },
        })} Recorded as execution ${executionId}.`,
        data: {
          _executionId: executionId, status: "not_attempted", retryable: true,
          failureCode: poolState.failureCode,
        },
      };
    }
    return {
      success: false,
      output: `${TOOL_ID}: the ${input.refusedRole} step could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} Recorded as execution ${executionId}; the node reported: ${uniswapFailureMessage(err)}`,
      data: { _executionId: executionId, status: "not_attempted", retryable: true },
    };
  }
  return {
    success: false,
    output: `${TOOL_ID} failed unexpectedly: ${uniswapFailureMessage(err)}`,
    data: { _executionId: executionId },
  };
}
