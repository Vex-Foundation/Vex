/**
 * Agent Scan activity repo — row → domain mapping (`agent_activity` table,
 * migrations `044_agent_activity.sql` + `045_bridge_activity.sql`).
 *
 * `mapRow` is the ONE place a raw SQL row becomes an `AgentActivityEvent` —
 * both `./swap.js` and `./bridge.js` funnel every read/write RETURNING row
 * through it. Exported for sibling import — not part of the public façade
 * surface.
 */

import type {
  AgentActivityEvent,
  AgentActivityEventRole,
  AgentActivityKind,
  AgentActivityStatus,
  AgentActivityFailureCode,
  BridgeChainFamily,
} from "./types.js";

export function mapRow(r: Record<string, unknown>): AgentActivityEvent {
  return {
    id: Number(r.id),
    protocolExecutionId: Number(r.protocol_execution_id),
    eventIndex: Number(r.event_index),
    eventRole: r.event_role as AgentActivityEventRole,
    recordVersion: Number(r.record_version),
    kind: r.kind as AgentActivityKind,
    protocol: r.protocol as string,
    chainId: Number(r.chain_id),
    chainSlug: r.chain_slug as string | null,
    status: r.status as AgentActivityStatus,
    failureCode: r.failure_code as AgentActivityFailureCode | null,
    failureReason: r.failure_reason as string | null,
    tokenInAddress: r.token_in_address as string | null,
    tokenInSymbol: r.token_in_symbol as string | null,
    tokenInDecimals: r.token_in_decimals === null ? null : Number(r.token_in_decimals),
    amountInHuman: r.amount_in_human as string | null,
    amountInRaw: r.amount_in_raw as string | null,
    tokenOutAddress: r.token_out_address as string | null,
    tokenOutSymbol: r.token_out_symbol as string | null,
    tokenOutDecimals: r.token_out_decimals === null ? null : Number(r.token_out_decimals),
    amountOutHuman: r.amount_out_human as string | null,
    amountOutRaw: r.amount_out_raw as string | null,
    executedAmountInHuman: r.executed_amount_in_human as string | null,
    executedAmountInRaw: r.executed_amount_in_raw as string | null,
    executedAmountOutHuman: r.executed_amount_out_human as string | null,
    executedAmountOutRaw: r.executed_amount_out_raw as string | null,
    usdInEst: r.usd_in_est as string | null,
    usdOutEst: r.usd_out_est as string | null,
    usdFeeEst: r.usd_fee_est as string | null,
    usdNetworkGasEst: r.usd_network_gas_est as string | null,
    usdVenueFeeEst: r.usd_venue_fee_est as string | null,
    usdDestinationPrepayEst: r.usd_destination_prepay_est as string | null,
    usdVexFeeEst: r.usd_vex_fee_est as string | null,
    vexFeeTokenAddress: r.vex_fee_token_address as string | null,
    vexFeeTokenSymbol: r.vex_fee_token_symbol as string | null,
    vexFeeTokenDecimals:
      r.vex_fee_token_decimals === null || r.vex_fee_token_decimals === undefined
        ? null
        : Number(r.vex_fee_token_decimals),
    vexFeeAmountRaw: r.vex_fee_amount_raw as string | null,
    vexFeeAmountHuman: r.vex_fee_amount_human as string | null,
    usdSource: r.usd_source as string | null,
    txHash: r.tx_hash as string | null,
    fromAddress: r.from_address as string | null,
    nonce: r.nonce === null || r.nonce === undefined ? null : Number(r.nonce),
    walletAddress: r.wallet_address as string,
    sessionId: r.session_id as string | null,
    routeProvenance: r.route_provenance as Record<string, unknown> | null,
    fromChainId: r.from_chain_id === null || r.from_chain_id === undefined ? null : Number(r.from_chain_id),
    fromChainSlug: r.from_chain_slug as string | null,
    toChainId: r.to_chain_id === null || r.to_chain_id === undefined ? null : Number(r.to_chain_id),
    toChainSlug: r.to_chain_slug as string | null,
    chainFamily: r.chain_family as BridgeChainFamily,
    providerOrderId: r.provider_order_id as string | null,
    normalizedRoute: r.normalized_route as string | null,
    providerStatus: r.provider_status as string | null,
    evidenceSource: r.evidence_source as string | null,
    observedAt: toIsoOrNull(r.observed_at),
    lastAttemptedAt: toIsoOrNull(r.last_attempted_at),
    submitAttemptedAt: toIsoOrNull(r.submit_attempted_at),
    recentBlockhash: r.recent_blockhash as string | null,
    lastValidBlockHeight:
      r.last_valid_block_height === null || r.last_valid_block_height === undefined
        ? null
        : Number(r.last_valid_block_height),
    broadcastAt: toIsoOrNull(r.broadcast_at),
    confirmedAt: toIsoOrNull(r.confirmed_at),
    lastCheckedAt: toIsoOrNull(r.last_checked_at),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
