import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountOrder,
} from "@tools/lighter/types.js";
import * as lighterNonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type {
  LighterOrderExecutionIntentRow,
  LighterProviderOutcomeExecutionState,
} from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import {
  buildLighterOrderEvidenceScope,
  lighterDecimalGreaterThanZero,
  lighterOrderMatchesEvidenceScope,
  lighterOrderEvidenceJson,
} from "./order-evidence.js";

/**
 * Positive-evidence-only reconciliation for authenticated order-stream frames.
 *
 * The Lighter account-all-orders channel does not document a cursor or an
 * absence/deletion contract. Consequently this consumer advances only an exact
 * `client_order_id` present in a validated frame. A missing order never means
 * canceled, rejected, or filled.
 */

export interface LighterOrderStreamReconciliationDeps {
  readonly client: Pick<LighterClient, "getNextNonce">;
  readonly intents: Pick<
    typeof lighterOrderExecutionIntentsRepo,
    "listStreamWatchable" | "markStreamOutcome" | "markEvidenceConflict"
  >;
  readonly nonceState: Pick<
    typeof lighterNonceStateRepo,
    "find" | "recordExecutionObserved"
  >;
  readonly transport?: "account_all_orders_stream" | "account_orders_resnapshot";
}

export interface LighterOrderStreamReconciliationReport {
  readonly examined: number;
  readonly matched: number;
  readonly advanced: number;
  readonly deduplicated: number;
  readonly unknownStatus: number;
  readonly raced: number;
  readonly evidenceConflicts: number;
  readonly nonceScopesRefreshed: number;
  readonly nonceRefreshFailures: number;
}

export function defaultLighterOrderStreamReconciliationDeps(): LighterOrderStreamReconciliationDeps {
  return {
    client: getLighterClient(),
    intents: lighterOrderExecutionIntentsRepo,
    nonceState: lighterNonceStateRepo,
  };
}

export async function reconcileLighterOrderStreamMessage(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountAllOrdersStreamMessage,
  deps: LighterOrderStreamReconciliationDeps = defaultLighterOrderStreamReconciliationDeps(),
): Promise<LighterOrderStreamReconciliationReport> {
  const intents = await deps.intents.listStreamWatchable(environment, accountIndex, 500);
  const ordersByClientId = flattenOrders(message);
  const transport = deps.transport ?? "account_all_orders_stream";
  const nonceScopes = new Map<string, LighterOrderExecutionIntentRow>();
  let matched = 0;
  let advanced = 0;
  let deduplicated = 0;
  let unknownStatus = 0;
  let raced = 0;
  let evidenceConflicts = 0;

  for (const intent of intents) {
    if (intent.clientOrderIndex === null) continue;
    const order = ordersByClientId.get(intent.clientOrderIndex);
    if (order === undefined) continue;
    if (order === null) {
      evidenceConflicts += 1;
      const persisted = await deps.intents.markEvidenceConflict({
        intentId: intent.intentId,
        environment,
        reason: "provider_order_duplicate_identity_conflict",
      });
      if (persisted === null) raced += 1;
      continue;
    }
    const evidenceScope = exactEvidenceScopeFromIntent(intent);
    if (evidenceScope === null) {
      continue;
    }
    if (
      order.owner_account_index !== intent.accountIndex
      || order.market_index !== intent.marketIndex
      || !lighterOrderMatchesEvidenceScope(order, evidenceScope)
    ) {
      evidenceConflicts += 1;
      const persisted = await deps.intents.markEvidenceConflict({
        intentId: intent.intentId,
        environment,
        reason: "provider_order_semantic_conflict",
      });
      if (persisted === null) raced += 1;
      continue;
    }
    matched += 1;
    const state = classifyLighterStreamOrderState(order);
    if (state === null) {
      unknownStatus += 1;
      continue;
    }
    const status = order.status ?? "";
    const source = isTerminalOrder(state, status) ? "inactive_order" : "active_order";
    const evidence = {
      ...lighterOrderEvidenceJson(source, order, intent.clientOrderIndex),
      transport,
      frameType: message.type,
    };
    if (sameOrderEvidence(intent, state, status, order.order_id, evidence, transport)) {
      deduplicated += 1;
      continue;
    }
    const persisted = await deps.intents.markStreamOutcome({
      intentId: intent.intentId,
      environment,
      state,
      source,
      providerOrderId: order.order_id,
      providerOrderStatus: status,
      providerOutcomeJson: evidence,
    });
    if (persisted === null) {
      raced += 1;
      continue;
    }
    advanced += 1;
    nonceScopes.set(`${intent.environment}:${intent.accountIndex}:${intent.apiKeyIndex}`, intent);
  }

  let nonceScopesRefreshed = 0;
  let nonceRefreshFailures = 0;
  for (const intent of nonceScopes.values()) {
    try {
      const next = await deps.client.getNextNonce(intent.environment, {
        accountIndex: intent.accountIndex,
        apiKeyIndex: intent.apiKeyIndex,
      });
      const nonce = await deps.nonceState.find(
        intent.environment,
        intent.accountIndex,
        intent.apiKeyIndex,
      );
      if (nonce !== null && nonce.status !== "observed") {
        await deps.nonceState.recordExecutionObserved({
          environment: intent.environment,
          accountIndex: intent.accountIndex,
          apiKeyIndex: intent.apiKeyIndex,
          nonce: next.nonce,
          publicKey: nonce.publicKey,
          transactionTime: null,
        });
      }
      nonceScopesRefreshed += 1;
    } catch {
      // The durable order evidence remains valid. A failed public nonce refresh
      // leaves the reservation in place for the existing fallback repair lane.
      nonceRefreshFailures += 1;
    }
  }

  return {
    examined: intents.length,
    matched,
    advanced,
    deduplicated,
    unknownStatus,
    raced,
    evidenceConflicts,
    nonceScopesRefreshed,
    nonceRefreshFailures,
  };
}

function exactEvidenceScopeFromIntent(
  intent: LighterOrderExecutionIntentRow,
): ReturnType<typeof buildLighterOrderEvidenceScope> | null {
  const baseDecimals = intent.preSubmitRevalidationJson?.baseDecimals;
  const priceDecimals = intent.preSubmitRevalidationJson?.priceDecimals;
  if (!Number.isInteger(baseDecimals) || !Number.isInteger(priceDecimals)) return null;
  const ordinaryIoc = intent.timeInForce === "immediate-or-cancel"
    && intent.orderType !== "stop-loss"
    && intent.orderType !== "stop-loss-limit"
    && intent.orderType !== "take-profit"
    && intent.orderType !== "take-profit-limit";
  return buildLighterOrderEvidenceScope({
    approved: intent,
    baseDecimals: baseDecimals as number,
    priceDecimals: priceDecimals as number,
    signedOrderExpiryMs: ordinaryIoc ? 0 : intent.orderExpiryMs,
  });
}

export function classifyLighterStreamOrderState(
  order: LighterAccountOrder,
): LighterProviderOutcomeExecutionState | null {
  const status = order.status?.trim().toLowerCase();
  if (status === "pending" || status === "in-progress") return "sequencer_pending";
  if (status === "open") {
    return lighterDecimalGreaterThanZero(order.filled_base_amount)
      ? "partially_filled"
      : "open";
  }
  if (status === "filled") return "filled";
  if (isCanceledOrExpiredStatus(status)) {
    return lighterDecimalGreaterThanZero(order.filled_base_amount)
      ? "partially_filled"
      : "canceled";
  }
  return null;
}

function flattenOrders(
  message: LighterAccountAllOrdersStreamMessage,
): ReadonlyMap<string, LighterAccountOrder | null> {
  const orders = new Map<string, LighterAccountOrder | null>();
  for (const marketOrders of Object.values(message.orders)) {
    for (const order of marketOrders) {
      orders.set(
        order.client_order_id,
        orders.has(order.client_order_id) ? null : order,
      );
    }
  }
  return orders;
}

function isTerminalOrder(
  state: LighterProviderOutcomeExecutionState,
  providerStatus: string,
): boolean {
  return state === "filled"
    || state === "canceled"
    || state === "rejected"
    || isCanceledOrExpiredStatus(providerStatus);
}

function isCanceledOrExpiredStatus(status: string | undefined): boolean {
  return status?.startsWith("canceled") === true || status?.includes("expire") === true;
}

function sameOrderEvidence(
  intent: LighterOrderExecutionIntentRow,
  state: LighterProviderOutcomeExecutionState,
  status: string,
  orderId: string,
  evidence: Record<string, unknown>,
  transport: NonNullable<LighterOrderStreamReconciliationDeps["transport"]>,
): boolean {
  if (
    intent.executionState !== state
    || intent.providerOrderId !== orderId
    || intent.providerOrderStatus !== status
    || intent.providerOutcomeJson?.transport !== transport
  ) {
    return false;
  }
  return (
    intent.providerOutcomeJson.remainingBaseAmount === evidence.remainingBaseAmount
    && intent.providerOutcomeJson.filledBaseAmount === evidence.filledBaseAmount
    && intent.providerOutcomeJson.filledQuoteAmount === evidence.filledQuoteAmount
  );
}
