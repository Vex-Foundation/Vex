/** Versioned correction of native v4 interpretations, never a fee retry. */
import { formatUnits } from "viem";
import { getPool, queryOne } from "../../client.js";
import { mapRow } from "./mappers.js";
import { readSettlementDecodeHint } from "./settlement-decode.js";
import { V4_NATIVE_DECODER_VERSION } from "@tools/uniswap/v4-native-types.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import type { AgentActivityEvent } from "./types.js";

const native = (value: string | null): boolean => value === null
  || ["0x0000000000000000000000000000000000000000", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"].includes(value.toLowerCase());
const raw = (value: string): bigint => {
  if (!/^\d+$/.test(value)) throw new Error("Native settlement requires unsigned atomic units");
  return BigInt(value);
};
export function needsV4NativeRevalidation(row: AgentActivityEvent, version: string): boolean {
  const hint = readSettlementDecodeHint(row.routeProvenance);
  return row.protocol === "uniswap" && row.eventRole === "swap" && row.chainFamily === "eip155"
    && hint?.decoder === "uniswap" && hint.v4 !== undefined
    && (native(row.tokenInAddress) || native(row.tokenOutAddress)) && row.settlementDecodeVersion !== version;
}

export async function recordV4NativeSettlement(input: {
  readonly id: number; readonly chainId: number; readonly txHash: string; readonly poolId: string;
  readonly amountInRaw: string; readonly amountOutRaw?: string;
  readonly inputIsBound: boolean; readonly outputUnproven: boolean;
  readonly poolOutputEstimateRaw?: string;
}): Promise<AgentActivityEvent> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM agent_activity WHERE id = $1 FOR UPDATE", [input.id]);
    const stored = result.rows[0];
    if (!stored) throw new Error("Native settlement activity is missing");
    const row = mapRow(stored);
    const hint = readSettlementDecodeHint(row.routeProvenance);
    if (!["pending", "confirmed"].includes(row.status) || row.protocol !== "uniswap" || row.eventRole !== "swap"
      || row.chainFamily !== "eip155" || row.chainId !== input.chainId || row.txHash !== input.txHash
      || hint?.decoder !== "uniswap" || hint.chainId !== row.chainId || hint.v4?.poolId.toLowerCase() !== input.poolId.toLowerCase()
      || row.settlementSource === "conflict_quarantined"
      || input.inputIsBound !== native(row.tokenInAddress)
      || (input.outputUnproven && !native(row.tokenOutAddress))
      || (!input.inputIsBound && !input.outputUnproven)) throw new Error("Native settlement identity or role mismatch");
    const deployment = getUniswapDeployment(row.chainId);
    if (!deployment || !hint.v4) throw new Error("Native settlement deployment is missing");
    const { assertV4Binding } = await import("@tools/uniswap/v4-pool.js");
    assertV4Binding(deployment, hint.v4);
    let amountIn = raw(input.amountInRaw);
    if (input.inputIsBound) {
      // A bound can only move down. Retain even a prior smaller observation.
      if (row.executedAmountInRaw !== null && raw(row.executedAmountInRaw) < amountIn) amountIn = raw(row.executedAmountInRaw);
      const revision = row.routeProvenance?.nativeAmountRevision;
      if (revision && typeof revision === "object" && "previousInputRaw" in revision
        && typeof revision.previousInputRaw === "string" && /^\d+$/.test(revision.previousInputRaw)
        && BigInt(revision.previousInputRaw) < amountIn) amountIn = BigInt(revision.previousInputRaw);
    } else if (row.executedAmountInRaw !== null && raw(row.executedAmountInRaw) !== amountIn) {
      throw new Error("ERC-20 input conflicts with the existing settlement");
    }
    const amountOut = input.outputUnproven ? null : input.amountOutRaw;
    if (amountOut === undefined) throw new Error("Native input settlement needs proven token output");
    if (amountOut !== null) {
      raw(amountOut);
      if (row.executedAmountOutRaw !== null && row.executedAmountOutRaw !== amountOut) throw new Error("ERC-20 output conflicts with the existing settlement");
    }
    if (row.tokenInDecimals === null || row.tokenOutDecimals === null) throw new Error("Native settlement decimals are missing");
    if ((input.inputIsBound && row.tokenInDecimals !== 18) || (input.outputUnproven && row.tokenOutDecimals !== 18)) throw new Error("Native settlement decimals changed");
    const estimate = input.outputUnproven && input.poolOutputEstimateRaw !== undefined ? raw(input.poolOutputEstimateRaw).toString() : null;
    const updated = await client.query(
      `UPDATE agent_activity SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, NOW()),
         confirmation_source = COALESCE(confirmation_source, 'tool_response'),
         executed_amount_in_raw = $2, executed_amount_in_human = $3,
         executed_amount_out_raw = $4, executed_amount_out_human = $5,
         evidence_source = CASE WHEN $6 THEN 'native_balance_delta_bound' ELSE evidence_source END,
         settlement_source = CASE WHEN $6 THEN 'native_balance_delta_bound' ELSE 'native_output_unproven_hooked' END,
         pending_reason = CASE WHEN $7 THEN 'native_output_unproven_hooked' ELSE NULL END,
         settlement_decode_version = $8,
         amount_out_raw = CASE WHEN $7 THEN $9 ELSE amount_out_raw END,
         amount_out_human = CASE WHEN $7 THEN $10 ELSE amount_out_human END,
         route_provenance = COALESCE(route_provenance, '{}'::jsonb) || jsonb_build_object(
           'nativeAmountRevision', COALESCE(route_provenance->'nativeAmountRevision', jsonb_build_object(
             'previousInputRaw', executed_amount_in_raw, 'previousOutputRaw', executed_amount_out_raw,
             'previousEstimateOutRaw', amount_out_raw, 'decoderVersion', $8::text))),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [input.id, amountIn.toString(), formatUnits(amountIn, row.tokenInDecimals), amountOut,
        amountOut === null ? null : formatUnits(BigInt(amountOut), row.tokenOutDecimals),
        input.inputIsBound, input.outputUnproven, V4_NATIVE_DECODER_VERSION,
        estimate, estimate === null ? null : formatUnits(BigInt(estimate), row.tokenOutDecimals)],
    );
    await client.query("COMMIT");
    return mapRow(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Withdraw only the superseded event-only claim; keep it in revision history. */
export async function invalidateOldHookedNativeInput(row: AgentActivityEvent): Promise<void> {
  const hint = readSettlementDecodeHint(row.routeProvenance);
  if (row.protocol !== "uniswap" || row.eventRole !== "swap" || row.status !== "confirmed" || row.chainFamily !== "eip155"
    || !native(row.tokenInAddress) || row.evidenceSource !== null || row.executedAmountInRaw === null
    || hint?.decoder !== "uniswap" || !hint.v4
    || hint.v4.poolKey.hooks.toLowerCase() === "0x0000000000000000000000000000000000000000") return;
  const deployment = getUniswapDeployment(row.chainId);
  if (!deployment || hint.chainId !== row.chainId) return;
  try {
    const { assertV4Binding } = await import("@tools/uniswap/v4-pool.js");
    assertV4Binding(deployment, hint.v4);
  } catch { return; }
  await queryOne(
    `UPDATE agent_activity SET executed_amount_in_raw = NULL, executed_amount_in_human = NULL,
       settlement_source = 'amounts_incomplete',
       route_provenance = COALESCE(route_provenance, '{}'::jsonb) || jsonb_build_object(
         'nativeAmountRevision', COALESCE(route_provenance->'nativeAmountRevision', jsonb_build_object(
           'previousInputRaw', executed_amount_in_raw, 'previousOutputRaw', executed_amount_out_raw, 'decoderVersion', $5::text))),
       updated_at = NOW()
     WHERE id = $1 AND status = 'confirmed' AND tx_hash = $2 AND chain_id = $3
       AND evidence_source IS NULL AND executed_amount_in_raw = $4
       AND settlement_decode_version IS DISTINCT FROM $5
       AND route_provenance->'settlementDecode'->'v4'->>'poolId' = $6 RETURNING id`,
    [row.id, row.txHash, row.chainId, row.executedAmountInRaw, V4_NATIVE_DECODER_VERSION, hint.v4.poolId],
  );
}

/** Resize only this unsigned fee plan, before nonce acquisition. */
export async function reduceUniswapNativeFee(id: number, ceiling: bigint, fee: bigint, decimals: number): Promise<void> {
  if (fee < 0n || fee > ceiling) throw new Error("Native fee cannot exceed its approval");
  const row = await queryOne(
    `UPDATE agent_activity SET amount_in_raw = $3, amount_in_human = $4, updated_at = NOW()
     WHERE id = $1 AND protocol = 'uniswap' AND event_role = 'swap_fee'
       AND status = 'pending' AND tx_hash IS NULL AND nonce IS NULL AND nonce_reservation_token IS NULL
       AND amount_in_raw = $2
       AND lower(token_in_address) IN ('0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
     RETURNING id`, [id, ceiling.toString(), fee.toString(), formatUnits(fee, decimals)],
  );
  if (!row) throw new Error("Native fee plan changed before its reduction could be recorded");
}
