/**
 * A refusal that happened BEFORE anything could be signed, recorded as a
 * hashless `definitively_failed` row in one step: there was never a payload to
 * broadcast, so there is nothing to stage and nothing for the sweep to resolve.
 *
 * ONE IMPLEMENTATION, TWO LANES. The vault lane refuses on a vault that does not
 * exist, a rejected bundle or an allowance disagreement; the Blue market lane
 * refuses on the market gate, the health-factor floor or an approval plan that
 * disagrees with its operation. The reasons differ entirely and the WRITE does
 * not, so the role is a parameter here rather than the body being copied - a
 * second copy of this would be the place a family or a chain slug quietly stops
 * being set (see `./protocol.ts` for why both are stated and not defaulted).
 *
 * DELIBERATELY FAIL-SOFT. The refusal itself is the product behavior and the
 * caller has already decided it; a bookkeeping error must not convert a clean,
 * funds-untouched refusal into an error the agent might read as something having
 * happened on-chain.
 */

import {
  createAgentActivityPreBroadcastFailure,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import {
  MORPHO_ACTIVITY_CHAIN_FAMILY,
  MORPHO_ACTIVITY_KIND,
  MORPHO_ACTIVITY_PROTOCOL,
  morphoActivityChainSlug,
  type MorphoActivityRole,
} from "./protocol.js";

/** What a durable refusal row needs, for a failure that happened before any plan existed. */
export interface MorphoRefusalRow {
  readonly toolId: string;
  readonly sessionId: string;
  readonly intentParams: Record<string, unknown>;
  /** Resolved from Vex's own registry or from the market identity. NEVER from model input. */
  readonly chainId: number;
  readonly walletAddress: string;
  readonly eventRole: MorphoActivityRole;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
}

export async function recordMorphoPreBroadcastRefusal(
  row: MorphoRefusalRow,
  failureCode: AgentActivityFailureCode,
  failureReason: string,
): Promise<number | null> {
  try {
    const chainSlug = morphoActivityChainSlug(row.chainId);
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId: row.toolId,
      namespace: MORPHO_ACTIVITY_PROTOCOL,
      intentParams: row.intentParams,
      event: {
        eventIndex: 0,
        eventRole: row.eventRole,
        kind: MORPHO_ACTIVITY_KIND,
        protocol: MORPHO_ACTIVITY_PROTOCOL,
        chainId: row.chainId,
        ...(chainSlug === undefined ? {} : { chainSlug }),
        chainFamily: MORPHO_ACTIVITY_CHAIN_FAMILY,
        walletAddress: row.walletAddress.toLowerCase(),
        sessionId: row.sessionId,
        ...(row.tokenIn ? { tokenIn: row.tokenIn } : {}),
        ...(row.tokenOut ? { tokenOut: row.tokenOut } : {}),
        failureCode,
        failureReason,
      },
    });
    return executionId;
  } catch (err) {
    logger.warn("morpho.activity.pre_broadcast_record_failed", {
      toolId: row.toolId,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}
