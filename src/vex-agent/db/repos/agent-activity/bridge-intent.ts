/**
 * Agent Scan activity repo — Bridge API (migration 045, Phase 2). Split out
 * of `agent-activity.ts` (move-only, W0-A) — the Vex-signed staging/CAS
 * primitives this section reuses ("above" in the section doc below) now live
 * in the sibling `./swap-lifecycle.js` module, imported below. Post-submit
 * evidence/attach functions (provider order id, fill/refund observation, the
 * in-flight pre-check) live in the sibling `./bridge-lifecycle.js`, which
 * imports `insertBridgeRow`/`findPendingLogicalRow` from here.
 */

// ══ Bridge (migration 045) ═══════════════════════════════════════════
//
// Bridges record into the SAME table as swaps (plan §2). The Vex-signed legs
// (allowances + `bridge_deposit`) reuse the swap staging primitives above
// (`markActivityBroadcast` / `markBroadcastAccepted` / `confirmActivityEvent` /
// `failActivityEvent` / `abortPlannedEvents`) verbatim (R4) — the functions
// below add only what a bridge needs that a swap does not: route-scoped intent
// creation with a logical expected-fill row (R2/R5), an in-flight DB guard (C2),
// provider-order-id attachment (B2/C4), externally-observed fill/refund evidence
// (B2/B4), and the R15/C1 pre-broadcast failure shape.
//
// The LOGICAL row is the `bridge_fill_expected` row (marker decision, migration
// 045 header + pinned in bridge int tests). Every feed/dedup/guard keys on it.

import type { PoolClient } from "pg";

import { queryOne, queryOneWith, withTransaction } from "../../client.js";
import { nullableJsonb } from "../../params.js";
import { createExecutionIntent } from "../executions.js";

import { assertFailureCode, sanitizeFailureReason } from "./validation.js";
import { mapRow } from "./mappers.js";
import type {
  AgentActivityEvent,
  AgentActivityEventRole,
  AgentActivityLegInput,
  AgentActivityFailureCode,
  AgentActivityStatus,
  BridgeChainFamily,
} from "./types.js";

/** Route endpoints — feeds the from/to columns AND the family-safe normalized route key. */
export interface BridgeRouteEndpoints {
  readonly fromChainId: number;
  readonly fromChainSlug?: string;
  readonly fromChainFamily: BridgeChainFamily;
  /** Source token — provider-native address/mint (canonicalized into the route key). */
  readonly fromToken: string;
  readonly toChainId: number;
  readonly toChainSlug?: string;
  readonly toChainFamily: BridgeChainFamily;
  /** Destination token — provider-native address/mint. */
  readonly toToken: string;
}

function canonRouteChain(family: BridgeChainFamily, chainId: number): string {
  // Solana's provider-native ids DIVERGE (Khalani 20011000000 vs Relay
  // 792703809) but denote the same chain — collapse to one canonical token so
  // Khalani and Relay collide on the same Solana route (Codex pin). EVM ids are
  // already provider-agnostic.
  return family === "solana" ? "solana" : `eip155:${chainId}`;
}

function canonRouteToken(family: BridgeChainFamily, token: string): string {
  const trimmed = token.trim();
  // EVM addresses are case-insensitive → lowercase; Solana mints are
  // case-SENSITIVE base58 → preserved (same mint across providers).
  return family === "eip155" ? trimmed.toLowerCase() : trimmed;
}

/**
 * The in-flight guard key (C2 + Codex GREEN-LIGHT pin): family-safe, NOT NULL on
 * logical rows, and EXCLUDING provider/protocol so Khalani and Relay cannot race
 * one route into two in-flight bridges. Exported + unit-pinned so the shape is
 * discoverable and cannot drift. Format:
 *   `<fromChainKey>:<fromToken>-><toChainKey>:<toToken>`
 */
export function buildNormalizedBridgeRoute(route: BridgeRouteEndpoints): string {
  return (
    `${canonRouteChain(route.fromChainFamily, route.fromChainId)}`
    + `:${canonRouteToken(route.fromChainFamily, route.fromToken)}`
    + `->${canonRouteChain(route.toChainFamily, route.toChainId)}`
    + `:${canonRouteToken(route.toChainFamily, route.toToken)}`
  );
}

/** A Vex-signed bridge leg (approvals, the origin deposit, the Vex fee transfer). Staged/broadcast via the swap CAS primitives (R4). */
export interface BridgeActivityLeg {
  readonly eventIndex: number;
  readonly eventRole: "allowance_reset" | "allowance" | "bridge_deposit" | "bridge_fee";
  /** The leg's OWN execution chain (origin for these Vex-signed legs). */
  readonly chainId: number;
  readonly chainSlug?: string;
  readonly chainFamily: BridgeChainFamily;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
  /**
   * Vex's own integrator fee in USD — set ONLY on the `bridge_fee` leg
   * (migration 050), never on the logical row. THIS row's status is what
   * decides whether the fee was actually collected (the fee transfer is the
   * final leg, after the deposit), so keeping the figure here makes
   * `SUM(usd_vex_fee_est) WHERE status='confirmed'` honest revenue instead of a
   * count of fees Vex merely planned to take. Omitted when the token has no
   * trustworthy USD price — the leg's real token and raw amount are recorded
   * regardless.
   */
  readonly usdVexFeeEst?: string;
  /** Provenance for `usdVexFeeEst` (the venue's own price marker, e.g. `khalani_token_price`). */
  readonly usdSource?: string;
}

/** The single planned logical row (R2). Carries the route amounts + USD estimates. */
export interface BridgeExpectedFill {
  readonly eventIndex: number;
  /** The fill executes on the DESTINATION chain. */
  readonly chainId: number;
  readonly chainSlug?: string;
  readonly chainFamily: BridgeChainFamily;
  /** Requested source leg (what leaves the origin) — quote echo, never a settlement claim. */
  readonly tokenIn?: AgentActivityLegInput;
  /** Requested destination leg (what should arrive) — quote echo. */
  readonly tokenOut?: AgentActivityLegInput;
  readonly usdInEst?: string;
  readonly usdOutEst?: string;
  readonly usdFeeEst?: string;
  readonly usdSource?: string;
}

export interface CreateBridgeActivityIntentInput {
  readonly toolId: string;
  readonly namespace: string;
  /** Provider column value — "khalani" | "relay". */
  readonly protocol: string;
  readonly intentParams: Record<string, unknown>;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly route: BridgeRouteEndpoints;
  /** Pre-sign correlation persisted on the logical row BEFORE any signing (R5) — quoteId/routeId/requestId. */
  readonly quoteRef?: Record<string, unknown>;
  /** Vex-signed legs (approvals + deposit). May be empty (native deposit, no approval). */
  readonly legs: ReadonlyArray<BridgeActivityLeg>;
  /** Exactly one planned logical row (R2). */
  readonly expectedFill: BridgeExpectedFill;
}

export type CreateBridgeActivityIntentResult =
  | {
      readonly outcome: "created";
      readonly executionId: number;
      readonly legs: AgentActivityEvent[];
      readonly expectedFill: AgentActivityEvent;
    }
  // The DB in-flight guard (C2) rejected a second concurrent execute for the
  // same wallet+session+route — NOTHING was persisted for this attempt. The
  // handler surfaces "a bridge is already in flight for this route".
  | {
      readonly outcome: "in_flight_conflict";
      readonly existing: AgentActivityEvent | null;
    };

const BRIDGE_INFLIGHT_INDEX = "idx_agent_activity_bridge_inflight";

function isUniqueViolation(err: unknown, indexName: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return record.code === "23505" && record.constraint === indexName;
}

/** Full-column bridge INSERT payload — one private entry point for every bridge row shape. */
export interface BridgeRowInsert {
  client: PoolClient;
  protocolExecutionId: number;
  eventIndex: number;
  eventRole: AgentActivityEventRole;
  protocol: string;
  chainId: number;
  chainSlug?: string;
  chainFamily: BridgeChainFamily;
  route: BridgeRouteEndpoints;
  walletAddress: string;
  sessionId: string;
  tokenIn?: AgentActivityLegInput;
  tokenOut?: AgentActivityLegInput;
  usdInEst?: string;
  usdOutEst?: string;
  /** DEPRECATED (migration 050) — the mixed-meaning column, dual-written verbatim. Use the four below. */
  usdFeeEst?: string;
  usdNetworkGasEst?: string;
  usdVenueFeeEst?: string;
  usdDestinationPrepayEst?: string;
  usdVexFeeEst?: string;
  usdSource?: string;
  providerOrderId?: string;
  /** Set ONLY on the logical row — the biconditional CHECK enforces this. */
  normalizedRoute?: string;
  providerStatus?: string;
  evidenceSource?: string;
  observedAt?: string;
  status: AgentActivityStatus;
  failureCode?: AgentActivityFailureCode;
  failureReason?: string;
  txHash?: string;
  executedAmountInHuman?: string;
  executedAmountInRaw?: string;
  executedAmountOutHuman?: string;
  executedAmountOutRaw?: string;
  /** Set together with a confirmed status. */
  confirmed?: boolean;
  routeProvenance?: Record<string, unknown>;
}

/**
 * The ONE place a bridge row is inserted. `kind` is always `'bridge'`; the
 * route endpoints are stamped on EVERY row (R1); local submit/broadcast fields
 * are NEVER written here (Vex-signed legs stage those later via
 * `markActivityBroadcast`, provider-observed rows must not have them at all —
 * the 045 observed-no-local-fields CHECK). `failure_reason` is sanitized
 * unconditionally (redact + cap), same repo-boundary contract as the swap path.
 *
 * Exported for sibling import (`./bridge-lifecycle.js`'s `markBridgeLegObserved`)
 * — not part of the public façade surface.
 */
export async function insertBridgeRow(input: BridgeRowInsert): Promise<AgentActivityEvent> {
  if (input.failureCode) assertFailureCode(input.failureCode);
  const confirmedAtExpr = input.confirmed ? "NOW()" : "NULL";
  const sql = `INSERT INTO agent_activity (
       protocol_execution_id, event_index, event_role, kind, protocol,
       chain_id, chain_slug, chain_family,
       from_chain_id, from_chain_slug, to_chain_id, to_chain_slug,
       wallet_address, session_id,
       token_in_address, token_in_symbol, token_in_decimals, amount_in_human, amount_in_raw,
       token_out_address, token_out_symbol, token_out_decimals, amount_out_human, amount_out_raw,
       usd_in_est, usd_out_est, usd_fee_est,
       usd_network_gas_est, usd_venue_fee_est, usd_destination_prepay_est, usd_vex_fee_est,
       usd_source,
       provider_order_id, normalized_route, provider_status, evidence_source, observed_at,
       status, failure_code, failure_reason,
       tx_hash,
       executed_amount_in_human, executed_amount_in_raw,
       executed_amount_out_human, executed_amount_out_raw,
       confirmed_at, route_provenance
     ) VALUES (
       $1, $2, $3, 'bridge', $4,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13,
       $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23,
       $24::numeric, $25::numeric, $26::numeric,
       $27::numeric, $28::numeric, $29::numeric, $30::numeric,
       $31,
       $32, $33, $34, $35, $36::timestamptz,
       $37, $38, $39,
       $40,
       $41, $42,
       $43, $44,
       ${confirmedAtExpr}, $45::jsonb
     ) RETURNING *`;
  const bindParams = [
    input.protocolExecutionId,
    input.eventIndex,
    input.eventRole,
    input.protocol,
    input.chainId,
    input.chainSlug ?? null,
    input.chainFamily,
    input.route.fromChainId,
    input.route.fromChainSlug ?? null,
    input.route.toChainId,
    input.route.toChainSlug ?? null,
    input.walletAddress,
    input.sessionId,
    input.tokenIn?.tokenAddress ?? null,
    input.tokenIn?.tokenSymbol ?? null,
    input.tokenIn?.tokenDecimals ?? null,
    input.tokenIn?.amountHuman ?? null,
    input.tokenIn?.amountRaw ?? null,
    input.tokenOut?.tokenAddress ?? null,
    input.tokenOut?.tokenSymbol ?? null,
    input.tokenOut?.tokenDecimals ?? null,
    input.tokenOut?.amountHuman ?? null,
    input.tokenOut?.amountRaw ?? null,
    input.usdInEst ?? null,
    input.usdOutEst ?? null,
    input.usdFeeEst ?? null,
    input.usdNetworkGasEst ?? null,
    input.usdVenueFeeEst ?? null,
    input.usdDestinationPrepayEst ?? null,
    input.usdVexFeeEst ?? null,
    input.usdSource ?? null,
    input.providerOrderId ?? null,
    input.normalizedRoute ?? null,
    input.providerStatus ?? null,
    input.evidenceSource ?? null,
    input.observedAt ?? null,
    input.status,
    input.failureCode ?? null,
    input.failureReason === undefined ? null : sanitizeFailureReason(input.failureReason),
    input.txHash ?? null,
    input.executedAmountInHuman ?? null,
    input.executedAmountInRaw ?? null,
    input.executedAmountOutHuman ?? null,
    input.executedAmountOutRaw ?? null,
    nullableJsonb(input.routeProvenance ?? null),
  ];
  const row = await queryOneWith<Record<string, unknown>>(input.client, sql, bindParams);
  if (!row) throw new Error("agent_activity: bridge insert returned no row");
  return mapRow(row);
}

/**
 * Atomically create the `protocol_executions` intent + every Vex-signed leg
 * (pending, hashless — staged later) + EXACTLY ONE planned `bridge_fill_expected`
 * logical row (R2/R5), all BEFORE any signing. The logical row carries the route
 * endpoints, requested amounts, USD estimates, the `normalized_route` in-flight
 * key, and `quoteRef` (quoteId/routeId/requestId) as `route_provenance`.
 *
 * The DB in-flight guard (C2) makes a second concurrent execute for the same
 * wallet+session+route fail-closed: exactly one caller gets `outcome:"created"`,
 * the other gets `outcome:"in_flight_conflict"` with NOTHING persisted (the
 * transaction rolled back) — no duplicate broadcast is possible. Callers SHOULD
 * still call `checkBridgeInFlight` first for a friendly pre-check, but this is
 * the authoritative gate.
 */
export async function createBridgeActivityIntent(
  input: CreateBridgeActivityIntentInput,
): Promise<CreateBridgeActivityIntentResult> {
  const normalizedRoute = buildNormalizedBridgeRoute(input.route);
  try {
    return await withTransaction(async (client) => {
      const executionId = await createExecutionIntent(
        input.toolId, input.namespace, input.sessionId, input.intentParams, client,
      );
      if (executionId <= 0) {
        throw new Error("agent_activity: bridge intent insert returned no execution id");
      }
      const legs: AgentActivityEvent[] = [];
      for (const leg of input.legs) {
        legs.push(await insertBridgeRow({
          client,
          protocolExecutionId: executionId,
          eventIndex: leg.eventIndex,
          eventRole: leg.eventRole,
          protocol: input.protocol,
          chainId: leg.chainId,
          chainSlug: leg.chainSlug,
          chainFamily: leg.chainFamily,
          route: input.route,
          walletAddress: input.walletAddress,
          sessionId: input.sessionId,
          tokenIn: leg.tokenIn,
          tokenOut: leg.tokenOut,
          // Set only on the `bridge_fee` leg (migration 050) — see
          // `BridgeActivityLeg.usdVexFeeEst` for why the figure lives on the
          // leg whose own status proves collection, not on the logical row.
          usdVexFeeEst: leg.usdVexFeeEst,
          usdSource: leg.usdSource,
          status: "pending",
        }));
      }
      const expectedFill = await insertBridgeRow({
        client,
        protocolExecutionId: executionId,
        eventIndex: input.expectedFill.eventIndex,
        eventRole: "bridge_fill_expected",
        protocol: input.protocol,
        chainId: input.expectedFill.chainId,
        chainSlug: input.expectedFill.chainSlug,
        chainFamily: input.expectedFill.chainFamily,
        route: input.route,
        walletAddress: input.walletAddress,
        sessionId: input.sessionId,
        tokenIn: input.expectedFill.tokenIn,
        tokenOut: input.expectedFill.tokenOut,
        usdInEst: input.expectedFill.usdInEst,
        usdOutEst: input.expectedFill.usdOutEst,
        usdFeeEst: input.expectedFill.usdFeeEst,
        usdSource: input.expectedFill.usdSource,
        normalizedRoute,
        status: "pending",
        routeProvenance: input.quoteRef,
      });
      return { outcome: "created" as const, executionId, legs, expectedFill };
    });
  } catch (err) {
    if (isUniqueViolation(err, BRIDGE_INFLIGHT_INDEX)) {
      const existing = await findPendingLogicalRow(
        input.walletAddress, input.sessionId, normalizedRoute,
      );
      return { outcome: "in_flight_conflict" as const, existing };
    }
    throw err;
  }
}

/**
 * R15/C1 — a bridge attempt that fails BEFORE anything could be signed (empty
 * routes, an unsupported/rejected Relay step set, a pre-sign validation error):
 * atomically create the intent + a SINGLE hashless, already-`definitively_failed`
 * logical row (no pending legs — no pending artifacts from a rejected plan). A
 * read-only quote miss creates NO row (the handler simply does not call this).
 */
export async function createBridgePreBroadcastFailure(input: {
  readonly toolId: string;
  readonly namespace: string;
  readonly protocol: string;
  readonly intentParams: Record<string, unknown>;
  readonly walletAddress: string;
  readonly sessionId: string;
  readonly route: BridgeRouteEndpoints;
  readonly eventIndex?: number;
  readonly tokenIn?: AgentActivityLegInput;
  readonly tokenOut?: AgentActivityLegInput;
  readonly failureCode: AgentActivityFailureCode;
  readonly failureReason: string;
}): Promise<{ executionId: number; expectedFill: AgentActivityEvent }> {
  assertFailureCode(input.failureCode);
  const normalizedRoute = buildNormalizedBridgeRoute(input.route);
  return withTransaction(async (client) => {
    const executionId = await createExecutionIntent(
      input.toolId, input.namespace, input.sessionId, input.intentParams, client,
    );
    if (executionId <= 0) {
      throw new Error("agent_activity: bridge pre-broadcast intent returned no execution id");
    }
    const expectedFill = await insertBridgeRow({
      client,
      protocolExecutionId: executionId,
      eventIndex: input.eventIndex ?? 0,
      eventRole: "bridge_fill_expected",
      protocol: input.protocol,
      chainId: input.route.toChainId,
      chainSlug: input.route.toChainSlug,
      chainFamily: input.route.toChainFamily,
      route: input.route,
      walletAddress: input.walletAddress,
      sessionId: input.sessionId,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      normalizedRoute,
      status: "definitively_failed",
      failureCode: input.failureCode,
      failureReason: input.failureReason,
    });
    return { executionId, expectedFill };
  });
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * The pending logical row occupying a wallet+session+route in-flight slot, or
 * null. Exported for sibling import (`./bridge-lifecycle.js`'s
 * `checkBridgeInFlight`) — not part of the public façade surface.
 */
export async function findPendingLogicalRow(
  walletAddress: string,
  sessionId: string,
  normalizedRoute: string,
): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE event_role = 'bridge_fill_expected' AND status = 'pending'
        AND wallet_address = $1 AND session_id = $2 AND normalized_route = $3
      LIMIT 1`,
    [walletAddress, sessionId, normalizedRoute],
  );
  return row ? mapRow(row) : null;
}
