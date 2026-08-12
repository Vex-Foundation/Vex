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
    // Option-C second leg (migration 053) — see `types.ts` for the role binding.
    tokenIn2Address: r.token_in2_address as string | null,
    tokenIn2Symbol: r.token_in2_symbol as string | null,
    tokenIn2Decimals: nullableInt(r.token_in2_decimals),
    amountIn2Human: r.amount_in2_human as string | null,
    amountIn2Raw: r.amount_in2_raw as string | null,
    executedAmountIn2Human: r.executed_amount_in2_human as string | null,
    executedAmountIn2Raw: r.executed_amount_in2_raw as string | null,
    tokenOut2Address: r.token_out2_address as string | null,
    tokenOut2Symbol: r.token_out2_symbol as string | null,
    tokenOut2Decimals: nullableInt(r.token_out2_decimals),
    amountOut2Human: r.amount_out2_human as string | null,
    amountOut2Raw: r.amount_out2_raw as string | null,
    executedAmountOut2Human: r.executed_amount_out2_human as string | null,
    executedAmountOut2Raw: r.executed_amount_out2_raw as string | null,
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
    // Migration 078 — chain block time, NULL on every row written before it.
    settledBlockTime: toIsoOrNull(r.settled_block_time),
    lastCheckedAt: toIsoOrNull(r.last_checked_at),
    verificationAttempts: Number(r.verification_attempts ?? 0),
    lastVerificationReason:
      typeof r.last_verification_reason === "string" ? r.last_verification_reason : null,
    // Migration 067 — tolerant reads, closed-union writes (`./provenance-vocabulary.js`).
    confirmationSource: typeof r.confirmation_source === "string" ? r.confirmation_source : null,
    settlementSource: typeof r.settlement_source === "string" ? r.settlement_source : null,
    pendingReason: typeof r.pending_reason === "string" ? r.pending_reason : null,
    providerStatusObservedAt: toIsoOrNull(r.provider_status_observed_at),
    // Migration 068 — the pending-fallback lane's own state. Read tolerantly:
    // every one of these is NULL on a row the lane has never touched, which is
    // every row written before 068.
    evmClaimLeaseUntil: toIsoOrNull(r.evm_claim_lease_until),
    evmClaimToken: typeof r.evm_claim_token === "string" ? r.evm_claim_token : null,
    lastVerificationIncrementAt: toIsoOrNull(r.last_verification_increment_at),
    firstNonInclusionObservedAt: toIsoOrNull(r.first_noninclusion_observed_at),
    settlementDecodeVersion:
      typeof r.settlement_decode_version === "string" ? r.settlement_decode_version : null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

/** A nullable SMALLINT/INT column — `Number(null)` is 0, which would silently invent 0 decimals. */
function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
