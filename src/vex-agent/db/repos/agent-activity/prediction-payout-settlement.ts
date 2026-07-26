/**
 * Agent Scan activity repo — the Jupiter Prediction PAYOUT settlement contract:
 * the per-row `prediction_order` provenance written at INTENT time, and the CAS
 * finalizer that merges chain-proven settlement evidence into it.
 *
 * WHY A SECOND FINALIZER EXISTS AT ALL. `confirmActivityEvent` (`./swap-lifecycle.js`)
 * finalizes a row from the transaction VEX BROADCAST. A Jupiter Prediction
 * sell/close is chain-proven to be THREE transactions:
 *   1. order create — OUR tx (the row's `tx_hash`), moving ZERO tokens;
 *   2. a keeper's fill — vault → an escrow ATA owned by the ORDER PDA;
 *   3. a keeper's settle, ~2s later — escrow → our wallet's JupUSD ATA.
 * The money is in (3), which Vex never signed and which no generic decoder can
 * attribute to this row. So the row needs a finalize whose evidence is a
 * DIFFERENT transaction than its own hash — and therefore a finalize that must
 * carry the provenance proving WHICH other transaction, or the number it writes
 * is unauditable. `tx_hash` is deliberately NEVER touched: the row keeps naming
 * the transaction Vex actually signed, and the keeper's settle signature lives
 * in `route_provenance.payout_settlement`.
 *
 * THE PER-ROW POSITION TRUTH (`prediction_order`). `closeAll` fans out into N
 * rows that share ONE `protocol_executions.params` echo, so the top-level
 * intent params cannot say which position each row closed — only the tool
 * RESULT ever knew, and results are not queryable evidence. Every payout-role
 * row therefore persists its OWN `route_provenance.prediction_order.positionPubkey`
 * at intent creation (`prediction-order-provenance.ts`'s
 * `buildPredictionOrderProvenance`), and this finalizer
 * MERGES settlement proof into that same object rather than replacing it. A
 * sweep that resolves the position from the row itself can never query, match,
 * or settle against a sibling's position.
 *
 * FAIL CLOSED ON IDENTITY. The out leg is relabelled to JupUSD only from the
 * COMPLETE legacy USDC tuple (address AND symbol AND decimals). An
 * already-JupUSD row needs no relabel. ANY other tuple means this row is not
 * the row this lane understands, so nothing is written at all — an unidentified
 * row is one we must not overwrite. The tuple predicate is repeated in the SQL
 * so a concurrent relabel between the read and the write cannot slip through.
 *
 * DELIBERATELY UNTOUCHED: `provider_order_id`, `provider_status` and
 * `evidence_source` — migration 049's `agent_activity_non_bridge_no_bridge_cols`
 * CHECK requires all three NULL on a non-bridge row, and a prediction row is
 * non-bridge. The settlement's externally-observed nature is expressed in
 * `route_provenance.payout_settlement.source` instead.
 *
 * The exact-decimal `executedAmountOutHuman` is supplied BY THE CALLER, from
 * the row's own persisted decimals — the same division of labour
 * `confirmActivityEvent` already has with `solana-executed-amount-human.ts`
 * ("the sweep holds the row and its persisted `token_*_decimals`, so the
 * conversion belongs there — between the decode and the confirm").
 */

import {
  JUPITER_PREDICTION_PAYOUT_DECIMALS,
  JUPITER_PREDICTION_PAYOUT_MINT,
  JUPITER_PREDICTION_PAYOUT_SYMBOL,
  JUPITER_PREDICTION_USDC_MINT,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";
import { PREDICTION_ORDER_PROVENANCE_KEY } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-order-provenance.js";

import { queryOne } from "../../client.js";
import { jsonb } from "../../params.js";

import { mapRow } from "./mappers.js";
import { getActivityEventById } from "./swap-lifecycle.js";
import type { AgentActivityEvent, CasResult } from "./types.js";

/** `route_provenance` key owning the keeper-settle evidence this finalizer proved. */
export const PAYOUT_SETTLEMENT_PROVENANCE_KEY = "payout_settlement";

/** The out-leg identity a payout row must carry before this lane may finalize it. */
const LEGACY_USDC_OUT_LEG = {
  address: JUPITER_PREDICTION_USDC_MINT,
  symbol: "USDC",
  decimals: 6,
} as const;

const JUPUSD_OUT_LEG = {
  address: JUPITER_PREDICTION_PAYOUT_MINT,
  symbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
  decimals: JUPITER_PREDICTION_PAYOUT_DECIMALS,
} as const;

export interface JupiterPredictionPayoutSettlementInput {
  /** The chain-proven JupUSD credit, in atomic units. Never a provider number. */
  readonly executedAmountOutRaw: string;
  /** Exact-decimal sibling of `executedAmountOutRaw`, rendered by the caller from the row's own decimals. */
  readonly executedAmountOutHuman?: string;
  /** The order PDA whose escrow paid out — the account the escrow ATA was derived from. */
  readonly orderPubkey: string;
  /** OUR create signature, i.e. the row's own `tx_hash`, echoed as the matched provider event's signature. */
  readonly createSignature: string;
  /** The provider history `eventType` that matched (`order_created`). */
  readonly matchedEventType: string;
  /** When the match was made (ISO-8601). */
  readonly matchedAt: string;
  /** The KEEPER's settle signature — evidence, never the row's `tx_hash`. */
  readonly settleSignature: string;
  /** The derived escrow ATA both legs were proven against. */
  readonly escrowAta: string;
}

/**
 * `pending -> confirmed` for a Jupiter Prediction sell/close whose payout was
 * proven in a keeper's settle transaction. CAS-guarded on status AND identity
 * (protocol/kind/role/out-leg tuple); returns `{applied,row}` exactly like
 * `confirmActivityEvent`, so a concurrent settle reads as `applied:false`
 * rather than a double count.
 */
export async function confirmJupiterPredictionPayoutSettlement(
  id: number,
  input: JupiterPredictionPayoutSettlementInput,
): Promise<CasResult> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(
      `agent_activity: confirmJupiterPredictionPayoutSettlement — row ${id} does not exist`,
    );
  }
  if (!hasSettleableOutLeg(current)) {
    // Not the row shape this lane can identify — write NOTHING and report the
    // current state. Overwriting a row whose out leg we cannot recognize would
    // be exactly the "confirm a number nobody can audit" failure this lane
    // exists to avoid.
    return { applied: false, row: current };
  }

  const row = await queryOne<Record<string, unknown>>(
    // The provenance keys are BOUND, not interpolated, so this SQL and the
    // protocol's own key constants can never drift apart.
    `UPDATE agent_activity
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(),
            executed_amount_out_raw = $2, executed_amount_out_human = $3,
            token_out_address = $4, token_out_symbol = $5, token_out_decimals = $6,
            route_provenance = COALESCE(route_provenance, '{}'::jsonb) || jsonb_build_object(
              $7::text, COALESCE(route_provenance -> $7::text, '{}'::jsonb) || $8::jsonb,
              $9::text, $10::jsonb
            )
      WHERE id = $1 AND status = 'pending'
        AND protocol = 'jupiter' AND kind = 'prediction'
        AND event_role IN ('predict_sell','predict_close')
        AND (
          (token_out_address = $11 AND token_out_symbol = $12 AND token_out_decimals = $13)
          OR (token_out_address = $4 AND token_out_symbol = $5 AND token_out_decimals = $6)
        )
      RETURNING *`,
    [
      id,
      input.executedAmountOutRaw,
      input.executedAmountOutHuman ?? null,
      JUPUSD_OUT_LEG.address,
      JUPUSD_OUT_LEG.symbol,
      JUPUSD_OUT_LEG.decimals,
      PREDICTION_ORDER_PROVENANCE_KEY,
      // JSONB serialization is centralized in db/params (jsonb-boundary test).
      jsonb({
        orderPubkey: input.orderPubkey,
        createSignature: input.createSignature,
        matchedEventType: input.matchedEventType,
        matchedAt: input.matchedAt,
      }),
      PAYOUT_SETTLEMENT_PROVENANCE_KEY,
      jsonb({
        settleSignature: input.settleSignature,
        escrowAta: input.escrowAta,
        source: "escrow_transfer_balance_delta",
        laneVersion: 1,
      }),
      LEGACY_USDC_OUT_LEG.address,
      LEGACY_USDC_OUT_LEG.symbol,
      LEGACY_USDC_OUT_LEG.decimals,
    ],
  );
  if (row) return { applied: true, row: mapRow(row) };

  const after = await getActivityEventById(id);
  if (!after) {
    throw new Error(
      `agent_activity: confirmJupiterPredictionPayoutSettlement — row ${id} does not exist`,
    );
  }
  return { applied: false, row: after };
}

/** The COMPLETE legacy USDC tuple (relabel) or the COMPLETE JupUSD tuple (already correct). Anything else is unidentifiable. */
function hasSettleableOutLeg(row: AgentActivityEvent): boolean {
  return matchesOutLeg(row, LEGACY_USDC_OUT_LEG) || matchesOutLeg(row, JUPUSD_OUT_LEG);
}

function matchesOutLeg(
  row: AgentActivityEvent,
  leg: { readonly address: string; readonly symbol: string; readonly decimals: number },
): boolean {
  return row.tokenOutAddress === leg.address
    && row.tokenOutSymbol === leg.symbol
    && row.tokenOutDecimals === leg.decimals;
}
