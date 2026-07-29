/**
 * `token-history-db.ts` row → DTO mapping — split out (Card C5, move-only)
 * once the parent file crossed the repo's 500-line cap. See
 * `token-history-db.ts`'s own module doc (AMOUNT HONESTY / USD HONESTY
 * sections) for the full per-source amount/USD-resolution contract this
 * mapper implements.
 */

import type {
  AmountField,
  TokenHistoryEntry,
  UsdField,
} from "@shared/schemas/token-history.js";
import { sanitizeTokenSymbol } from "@shared/token-symbol-sanitizer.js";
import { coerceBridgeLegs } from "@shared/schemas/bridge-legs.js";
import {
  resolveAgentActivityAmount,
  resolveAmountWithEstimateBasis,
} from "./agent-activity-amount.js";
import { resolveChainIdFromDisplayChain } from "./token-history-db-query.js";
import type { PageRow } from "./token-history-db-types.js";

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toUsdStringOrNull(value: number | string | null): string | null {
  if (value === null) return null;
  return String(value);
}

/**
 * Wrap a leg's USD column with its provenance tag (C35). `provenance` is a
 * caller-supplied constant per arm — NEVER derived from `status` (see the
 * module header's USD HONESTY note: unlike the executed amount, there is no
 * settlement-time repricing to switch to).
 */
function usdField(value: number | string | null, provenance: "recorded" | "estimated"): UsdField {
  return { value: toUsdStringOrNull(value), usdProvenance: provenance };
}

/**
 * Unit provenance for a LEGACY (`proj_activity`) amount column, applying the
 * `amountDisplay` discipline of the retired MOVES block exactly: the engine recorded
 * HUMAN-readable amounts only for some captures (a dotted decimal that
 * parses to a finite positive number); anything else — including a raw
 * base-unit integer with no dot — is honestly `"unknown"` rather than
 * asserted as a specific-but-unrenderable unit (there is nothing display-side
 * to gain from distinguishing "atomic" from "unknown": both render the em
 * dash). `agent_activity` rows never call this — see
 * `agentActivityAmountField` below.
 */
function amountField(value: string | null): AmountField {
  if (value === null) return { value: null, unitProvenance: "unknown" };
  if (value.includes(".")) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return { value, unitProvenance: "human" };
  }
  return { value, unitProvenance: "unknown" };
}

/**
 * `wallet_intents.amount` is ALWAYS a human decimal the tool validated as
 * `Number.isFinite(...) > 0` at prepare time (`send/validation.ts`) — never
 * a raw atomic integer — so whole-number strings ("5") are still "human"
 * here, unlike `amountField`'s dotted-decimal requirement for activity rows.
 */
function humanAmountField(value: string | null): AmountField {
  if (value === null) return { value: null, unitProvenance: "unknown" };
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed) && parsed > 0) return { value, unitProvenance: "human" };
  return { value, unitProvenance: "unknown" };
}

const TOKEN_HISTORY_SWAP_STATUSES = ["pending", "confirmed", "failed"] as const;
type TokenHistorySwapStatus = (typeof TOKEN_HISTORY_SWAP_STATUSES)[number];

/**
 * Narrow the SQL-collapsed `agent_activity` status string to the DTO's closed
 * vocabulary. An unrecognized value fails closed to `null` rather than
 * risking an output-schema parse failure on a future enum drift.
 */
function toTokenHistorySwapStatus(value: string | null): TokenHistorySwapStatus | null {
  // Tolerate the raw DB value too — the SQL CASE collapses
  // `definitively_failed` → `failed`, but the mapper must not depend on it.
  if (value === "definitively_failed") return "failed";
  return value !== null &&
    (TOKEN_HISTORY_SWAP_STATUSES as readonly string[]).includes(value)
    ? (value as TokenHistorySwapStatus)
    : null;
}

/**
 * `agent_activity` amounts are ALREADY human decimals BY CONTRACT (plan
 * §4.1) — no dot-detection heuristic needed, unlike the legacy `amountField`
 * above (Codex final review finding 10 / contract C27: a whole-number
 * human value like "50" is a VALID result, not a rejection). WHICH value is
 * honest to show depends on the row's status — delegated to
 * `resolveAgentActivityAmount` (`./agent-activity-amount.js`, shared with
 * `agent-scan-db.ts` — contract C20): `confirmed` computes from the raw executed
 * leg + decimals; `pending` uses the requested echo; anything else is
 * `null`. Never a blind COALESCE of executed/requested in SQL.
 */
function agentActivityAmountField(
  status: TokenHistorySwapStatus | null,
  requestedHuman: string | null,
  executedRaw: string | null,
  decimals: number | null,
): AmountField {
  const value = resolveAgentActivityAmount(status, requestedHuman, executedRaw, decimals);
  return value === null
    ? { value: null, unitProvenance: "unknown" }
    : { value, unitProvenance: "human" };
}

/**
 * Wrap a BRIDGE amount value (already resolved via
 * `resolveAmountWithEstimateBasis` per BINDING Q2) as an `AmountField`. A
 * resolved value is ALWAYS a human decimal (executed truth or a labelled
 * quote estimate); the `estimated` vs `executed` distinction rides the
 * entry-level `amountBasis`, not the unit provenance (both are honest human
 * units, unlike a raw wei string).
 */
function bridgeAmountField(value: string | null): AmountField {
  return value === null
    ? { value: null, unitProvenance: "unknown" }
    : { value, unitProvenance: "human" };
}

export function mapEntry(row: PageRow): TokenHistoryEntry {
  // The tx hash always lives on the ORIGIN chain (`row.chain` — never
  // `dest_chain`), even for a row that matched via its destination leg —
  // resolve it from the row's OWN stored chain string, not the query's
  // input chainId, which can legitimately differ for a bridge.
  const txRefs = row.tx_ref !== null && row.chain !== null
    ? [{ chainId: resolveChainIdFromDisplayChain(row.chain), ref: row.tx_ref }]
    : [];

  if (row.source_kind === "intent") {
    return {
      kind: "transfer",
      id: row.source_id,
      createdAt: toIso(row.created_at),
      chain: row.chain,
      toAddress: row.to_address ?? "",
      amount: humanAmountField(row.output_amount),
      token: row.output_token_address,
      status: row.capture_status ?? "unknown",
      txRefs,
    };
  }

  if (row.source_kind === "agent_activity") {
    const status = toTokenHistorySwapStatus(row.status);

    // A bridge's LOGICAL row (`event_role = 'bridge_fill_expected'`, migration
    // 045) → a `kind: "bridge"` entry: from→to chains from the route endpoints
    // (`chain` = origin, `dest_chain` = destination — set in SQL), status
    // (`pending` = still settling, tracked; `bridge_refunded` distinguishes a
    // money-returned outcome), amounts per BINDING Q2, and `legs[]` carrying
    // every sibling leg's chain + hash (the renderer builds per-leg explorer
    // links from `legs`, NEVER truncated — OWNER RULE — so `txRefs` stays empty
    // for bridges; legacy `proj_activity` bridges keep using `txRefs`).
    if (row.product_type === "bridge") {
      const inRes = resolveAmountWithEstimateBasis(
        status,
        row.input_amount,
        row.executed_amount_in_raw,
        row.token_in_decimals,
      );
      const outRes = resolveAmountWithEstimateBasis(
        status,
        row.output_amount,
        row.executed_amount_out_raw,
        row.token_out_decimals,
      );
      return {
        kind: "bridge",
        id: row.source_id,
        createdAt: toIso(row.created_at),
        originChain: row.chain ?? "unknown",
        destinationChain: row.dest_chain,
        venue: row.namespace,
        input: {
          token: row.input_token_address,
          symbol: sanitizeTokenSymbol(row.input_token_symbol),
          localSymbol: null,
          amount: bridgeAmountField(inRes.value),
          valueUsd: usdField(row.input_value_usd, "estimated"),
        },
        output: {
          token: row.output_token_address,
          symbol: sanitizeTokenSymbol(row.output_token_symbol),
          localSymbol: null,
          amount: bridgeAmountField(outRes.value),
          valueUsd: usdField(row.output_value_usd, "estimated"),
        },
        captureStatus: null,
        txRefs: [],
        status,
        failureCode: row.failure_code,
        providerOrderId: row.provider_order_id ?? null,
        // executed_* are populated together (B4); prefer the output basis.
        amountBasis: outRes.basis ?? inRes.basis,
      // Canonical vocabulary (see `legacy-activity-kind.ts`): the real columns
      // on this arm, derived server-side on the legacy arm. Pure pass-through —
      // the SQL owns derivation and clamping, so the arms cannot disagree.
      activityKind: row.activity_kind ?? null,
      eventRole: row.event_role ?? null,
        legs: coerceBridgeLegs(row.legs),
        // R12: last successful sweep check — the renderer flags a stale pending
        // bridge "tracking delayed". `null` when never checked.
        lastCheckedAt: row.last_checked_at != null ? toIso(row.last_checked_at) : null,
      };
    }

    // event_role='swap' OR kind IN ('lend','prediction') (migration 049, W5)
    // → a `kind: "swap"` entry (the DTO's `kind` union stays swap/bridge/
    // transfer; `productType` — 'spot'/'lend'/'prediction' — is what
    // distinguishes them, mirroring `agent-scan-db-mappers.ts`). Amount
    // provenance is
    // status-dependent (C20 — see `agentActivityAmountField`); no
    // dot-detection heuristic gates a whole-number result (C27). NOTE
    // (deliberate scope limit, not an oversight): unlike the Agent Scan feed,
    // this entry has NO `amountBasis` field to carry an "estimated" label —
    // `swapEntrySchema` was never given one (only `bridgeEntrySchema` has
    // it), and `TokenHistoryScreen.tsx`'s own `amountBasis` read is
    // `entry.kind === "bridge"`-gated, so adding a dormant field here would
    // have no consumer. A confirmed lend/prediction row lacking
    // decoder-proven executed data therefore still renders a BLANK amount
    // (never a mislabelled one) via the unchanged `agentActivityAmountField`
    // below — see this card's delta log for the follow-up recommendation.
    // USD provenance is NOT status-dependent (C35 — see the module header's
    // USD HONESTY note): `usd_in/out_est` is always a quote-time estimate, so
    // both legs are tagged `"estimated"` regardless of `status`. `localSymbol`
    // fallback is unnecessary — `token_in/out_symbol` are authoritative
    // on-chain reads, not a legacy raw-address gap to fill.
    return {
      kind: "swap",
      id: row.source_id,
      createdAt: toIso(row.created_at),
      chain: row.chain ?? "unknown",
      venue: row.namespace,
      tradeSide: null,
      productType: row.product_type,
      input: {
        token: row.input_token_address,
        symbol: sanitizeTokenSymbol(row.input_token_symbol),
        localSymbol: null,
        amount: agentActivityAmountField(
          status,
          row.input_amount,
          row.executed_amount_in_raw,
          row.token_in_decimals,
        ),
        valueUsd: usdField(row.input_value_usd, "estimated"),
      },
      output: {
        token: row.output_token_address,
        symbol: sanitizeTokenSymbol(row.output_token_symbol),
        localSymbol: null,
        amount: agentActivityAmountField(
          status,
          row.output_amount,
          row.executed_amount_out_raw,
          row.token_out_decimals,
        ),
        valueUsd: usdField(row.output_value_usd, "estimated"),
      },
      unitPriceUsd: toUsdStringOrNull(row.unit_price_usd),
      captureStatus: null,
      status,
      failureCode: row.failure_code,
      // Canonical vocabulary (see `legacy-activity-kind.ts`): the real columns
      // on this arm, derived server-side on the legacy arm. Pure pass-through —
      // the SQL owns derivation and clamping, so the arms cannot disagree.
      activityKind: row.activity_kind ?? null,
      eventRole: row.event_role ?? null,
      txRefs,
    };
  }

  const input = {
    token: row.input_token_address,
    symbol: sanitizeTokenSymbol(row.input_token_symbol),
    localSymbol: sanitizeTokenSymbol(row.input_token_local_symbol),
    amount: amountField(row.input_amount),
    valueUsd: usdField(row.input_value_usd, "recorded"),
  };
  const output = {
    token: row.output_token_address,
    symbol: sanitizeTokenSymbol(row.output_token_symbol),
    localSymbol: sanitizeTokenSymbol(row.output_token_local_symbol),
    amount: amountField(row.output_amount),
    valueUsd: usdField(row.output_value_usd, "recorded"),
  };

  if (row.product_type === "bridge") {
    // Legacy `proj_activity` bridge (pre-migration-045, success-only): no
    // durable lifecycle, no provider order id, no per-leg breakdown — the new
    // agent_activity-only fields are null/empty here (the DTO defaults them so
    // pre-existing payloads still parse).
    return {
      kind: "bridge",
      id: row.source_id,
      createdAt: toIso(row.created_at),
      originChain: row.chain ?? "unknown",
      destinationChain: row.dest_chain,
      venue: row.namespace,
      input,
      output,
      captureStatus: row.capture_status,
    activityKind: row.activity_kind ?? null,
    eventRole: row.event_role ?? null,
      txRefs,
      status: null,
      failureCode: null,
      providerOrderId: null,
      amountBasis: null,
      legs: [],
      lastCheckedAt: null,
    };
  }

  return {
    kind: "swap",
    id: row.source_id,
    createdAt: toIso(row.created_at),
    chain: row.chain ?? "unknown",
    venue: row.namespace,
    tradeSide: row.trade_side,
    productType: row.product_type,
    input,
    output,
    unitPriceUsd: toUsdStringOrNull(row.unit_price_usd),
    captureStatus: row.capture_status,
    status: null,
    failureCode: null,
    activityKind: row.activity_kind ?? null,
    eventRole: row.event_role ?? null,
    txRefs,
  };
}

export function normalizeSourceRank(value: number): 0 | 1 | 2 {
  return value === 2 ? 2 : value === 1 ? 1 : 0;
}
