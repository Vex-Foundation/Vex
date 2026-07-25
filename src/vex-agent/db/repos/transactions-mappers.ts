/**
 * Transactions repo — row mapper (raw UNION ALL row → `TransactionRow`).
 *
 * `mapRow` and its private helpers implement FIX2-SPINE C20 (the SQL never
 * COALESCEs a display amount; this module derives `inputAmount`/
 * `outputAmount` from raw + decimals per the row's status), its W5/R5
 * correction (a `confirmed` non-bridge row is not guaranteed decoder-proven —
 * see `deriveDisplayAmounts`), and the BINDING Q2 bridge display-amount rule.
 * See `transactions.ts`'s module doc for the full three-half feed semantics
 * this mapping implements.
 */

import { formatUnits } from "viem";

import { FAILURE_TOOL_PRODUCTS } from "./transactions-failure-tools.js";
import type { BridgeLegRow, TransactionRow } from "./transactions-types.js";

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function str(value: unknown): string | null {
  return (value as string | null) ?? null;
}

/**
 * BigInt-safe raw→human conversion (FIX2-SPINE C20) — the ONLY place the
 * agent_activity half's display amount is computed; the SQL never does this
 * arithmetic (see module doc). Returns `null` when either input is
 * missing/malformed — a missing display amount is safer than a wrong one.
 */
function rawToHuman(raw: string | null, decimals: number | null): string | null {
  if (raw === null || decimals === null) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/**
 * Derive the agent_activity half's convenience amount fields from raw +
 * decimals per the row's status (FIX2-SPINE C20, corrected by W5/R5):
 *   - `confirmed` with decoder-proven executed legs → executed truth;
 *   - `confirmed` WITHOUT decoder-proven legs → the quoted amount, labelled
 *     `estimated` (R5: the "confirmed implies executed" assumption held for
 *     swaps only because the sweep never confirms a swap without both legs
 *     decoded — lend/prediction confirmations are not guaranteed
 *     decoder-proven, so falling through to a blank amount would hide an
 *     attempt that DID land on-chain; the quote is shown, explicitly marked
 *     as an estimate, never as settlement);
 *   - `pending` → the requested quote only (labelled `requested` — nothing
 *     has broadcast-confirmed yet, so showing the ask is honest, not a
 *     settlement claim);
 *   - anything else (`definitively_failed`) → no display amount — the
 *     attempt is over and nothing settled, so no value here would be honest.
 */
function deriveDisplayAmounts(
  status: string | null,
  requestedInRaw: string | null,
  requestedOutRaw: string | null,
  executedInRaw: string | null,
  executedOutRaw: string | null,
  tokenInDecimals: number | null,
  tokenOutDecimals: number | null,
): {
  inputAmount: string | null;
  outputAmount: string | null;
  amountBasis: "executed" | "requested" | "estimated" | null;
} {
  if (status === "confirmed") {
    const execIn = rawToHuman(executedInRaw, tokenInDecimals);
    const execOut = rawToHuman(executedOutRaw, tokenOutDecimals);
    if (execIn !== null || execOut !== null) {
      return { inputAmount: execIn, outputAmount: execOut, amountBasis: "executed" };
    }
    const reqIn = rawToHuman(requestedInRaw, tokenInDecimals);
    const reqOut = rawToHuman(requestedOutRaw, tokenOutDecimals);
    const amountBasis = reqIn !== null || reqOut !== null ? "estimated" : null;
    return { inputAmount: reqIn, outputAmount: reqOut, amountBasis };
  }
  if (status === "pending") {
    return {
      inputAmount: rawToHuman(requestedInRaw, tokenInDecimals),
      outputAmount: rawToHuman(requestedOutRaw, tokenOutDecimals),
      amountBasis: "requested",
    };
  }
  return { inputAmount: null, outputAmount: null, amountBasis: null };
}

/**
 * BRIDGE display-amount rule (Agent Scan Phase 2, BINDING Q2 — DISTINCT from
 * the swap rule above). A bridge's destination fill is solver-signed and
 * externally observed, so `executed_*` is populated ONLY when the sweep decoded
 * transfer/value evidence (migration-045 B4). Therefore:
 *   - an independently-verified executed amount → `executed`;
 *   - otherwise, while pending OR confirmed-without-a-decodable-amount, the
 *     QUOTED amount is shown, explicitly labelled `estimated` (a bridge never
 *     blanks a pending amount — "~X TOKEN est., still settling");
 *   - a `definitively_failed`/refunded attempt shows NOTHING (the requested
 *     amount would misrepresent it; the refund is carried as status, not as a
 *     fake amount).
 */
function deriveBridgeDisplayAmounts(
  status: string | null,
  requestedInRaw: string | null,
  requestedOutRaw: string | null,
  executedInRaw: string | null,
  executedOutRaw: string | null,
  tokenInDecimals: number | null,
  tokenOutDecimals: number | null,
): { inputAmount: string | null; outputAmount: string | null; amountBasis: "executed" | "estimated" | null } {
  const execIn = rawToHuman(executedInRaw, tokenInDecimals);
  const execOut = rawToHuman(executedOutRaw, tokenOutDecimals);
  if (execIn !== null || execOut !== null) {
    return { inputAmount: execIn, outputAmount: execOut, amountBasis: "executed" };
  }
  if (status === "definitively_failed") {
    return { inputAmount: null, outputAmount: null, amountBasis: null };
  }
  const reqIn = rawToHuman(requestedInRaw, tokenInDecimals);
  const reqOut = rawToHuman(requestedOutRaw, tokenOutDecimals);
  const amountBasis = reqIn !== null || reqOut !== null ? "estimated" : null;
  return { inputAmount: reqIn, outputAmount: reqOut, amountBasis };
}

/**
 * Coerce the `jsonb_agg(...)` bridge legs (already parsed to a JS array by the
 * pg driver) into typed `BridgeLegRow`s. Our own agent_activity rows, so the
 * shape is well-formed by construction; every leg is preserved (OWNER RULE —
 * no truncation). `null`/non-array (a swap row) → `null`.
 */
function coerceLegs(raw: unknown): BridgeLegRow[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      eventIndex: num(o.eventIndex),
      role: str(o.role),
      chainId: num(o.chainId),
      chainSlug: str(o.chainSlug),
      chainFamily: str(o.chainFamily),
      txHash: str(o.txHash),
      status: str(o.status),
      failureCode: str(o.failureCode),
    };
  });
}

export function mapRow(r: Record<string, unknown>): TransactionRow {
  const toolId = r.tool_id as string | null;

  if (r.source === "failure") {
    // Failure rows carry no per-leg economics. Derive the product from the
    // allowlist (current + legacy — matches what the success half stores /
    // what the tool used to store before deletion) so the model can group
    // both halves by the same productType. Unknown tools fall back to "unknown".
    const product = (toolId !== null && FAILURE_TOOL_PRODUCTS.get(toolId)) || "unknown";
    return {
      source: "failure",
      id: Number(r.id),
      namespace: r.namespace as string,
      productType: product,
      status: str(r.status) ?? "failed",
      toolId,
      durationMs: num(r.duration_ms),
      protocolExecutionId: num(r.protocol_execution_id),
      txHash: str(r.tx_hash),
      createdAt: toIso(r.created_at),
    };
  }

  if (r.source === "agent_activity") {
    const status = r.status as string | null;
    const isBridge = r.product_type === "bridge";
    // Swaps use the C20 rule (confirmed→executed, pending→requested); bridges
    // use the Q2 rule (executed-if-verified, else quoted-as-estimate).
    const { inputAmount, outputAmount, amountBasis } = isBridge
      ? deriveBridgeDisplayAmounts(
          status,
          str(r.amount_in_raw),
          str(r.amount_out_raw),
          str(r.executed_amount_in_raw),
          str(r.executed_amount_out_raw),
          num(r.token_in_decimals),
          num(r.token_out_decimals),
        )
      : deriveDisplayAmounts(
          status,
          str(r.amount_in_raw),
          str(r.amount_out_raw),
          str(r.executed_amount_in_raw),
          str(r.executed_amount_out_raw),
          num(r.token_in_decimals),
          num(r.token_out_decimals),
        );
    return {
      source: "agent_activity",
      id: Number(r.id),
      namespace: r.namespace as string,
      productType: r.product_type as string,
      chain: str(r.chain),
      inputToken: str(r.input_token),
      inputAmount,
      outputToken: str(r.output_token),
      outputAmount,
      amountBasis,
      valueUsd: num(r.value_usd),
      status,
      failureCode: str(r.failure_code),
      failureReason: str(r.failure_reason),
      chainId: num(r.chain_id),
      protocol: str(r.protocol),
      protocolExecutionId: num(r.protocol_execution_id),
      eventIndex: num(r.event_index),
      eventRole: str(r.event_role),
      tokenInAddress: str(r.token_in_address),
      tokenInSymbol: str(r.token_in_symbol),
      tokenInDecimals: num(r.token_in_decimals),
      tokenOutAddress: str(r.token_out_address),
      tokenOutSymbol: str(r.token_out_symbol),
      tokenOutDecimals: num(r.token_out_decimals),
      amountInHuman: str(r.amount_in_human),
      amountInRaw: str(r.amount_in_raw),
      amountOutHuman: str(r.amount_out_human),
      amountOutRaw: str(r.amount_out_raw),
      executedAmountInHuman: str(r.executed_amount_in_human),
      executedAmountInRaw: str(r.executed_amount_in_raw),
      executedAmountOutHuman: str(r.executed_amount_out_human),
      executedAmountOutRaw: str(r.executed_amount_out_raw),
      usdInEst: str(r.usd_in_est),
      usdOutEst: str(r.usd_out_est),
      usdFeeEst: str(r.usd_fee_est),
      usdSource: str(r.usd_source),
      fromChainId: isBridge ? num(r.from_chain_id) : null,
      fromChainSlug: isBridge ? str(r.from_chain_slug) : null,
      toChainId: isBridge ? num(r.to_chain_id) : null,
      toChainSlug: isBridge ? str(r.to_chain_slug) : null,
      // R5: surfaced for ANY agent_activity row, not bridge-only — a Solana
      // jupiter swap/lend/prediction row (kind='swap'|'lend'|'prediction',
      // chain_family='solana') needs this too once its write path populates
      // the column (K4/K5/K6); a route-endpoint concept (from/to chain) stays
      // bridge-only above, but "which family is THIS row's own chain" is not.
      chainFamily: str(r.chain_family),
      providerOrderId: isBridge ? str(r.provider_order_id) : null,
      providerStatus: isBridge ? str(r.provider_status) : null,
      legs: isBridge ? coerceLegs(r.legs) : null,
      txHash: str(r.tx_hash),
      createdAt: toIso(r.created_at),
    };
  }

  return {
    source: "success",
    id: Number(r.id),
    namespace: r.namespace as string,
    productType: r.product_type as string,
    tradeSide: str(r.trade_side),
    chain: str(r.chain),
    inputToken: str(r.input_token),
    inputAmount: str(r.input_amount),
    outputToken: str(r.output_token),
    outputAmount: str(r.output_amount),
    valueUsd: num(r.value_usd),
    captureStatus: str(r.capture_status),
    protocolExecutionId: num(r.protocol_execution_id),
    txHash: str(r.tx_hash),
    createdAt: toIso(r.created_at),
  };
}

// TIMESTAMPTZ comes back as a Date (node-postgres) or a string; normalise to ISO.
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
