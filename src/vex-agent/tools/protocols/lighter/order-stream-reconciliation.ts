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
  lighterDecimalGreaterThanZero,
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
    "listStreamWatchable" | "markStreamOutcome"
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

  for (const intent of intents) {
    if (intent.clientOrderIndex === null) continue;
    const order = ordersByClientId.get(intent.clientOrderIndex);
    if (order === undefined) continue;
    if (
      order.owner_account_index !== intent.accountIndex
      || order.market_index !== intent.marketIndex
    ) {
      continue;
    }
    matched += 1;
    const state = classifyLighterStreamOrderState(order);
    if (state === null) {
      unknownStatus += 1;
      continue;
    }
    const status = order.status ?? "";
    const source = isTerminalState(state) ? "inactive_order" : "active_order";
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
    nonceScopesRefreshed,
    nonceRefreshFailures,
  };
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
  if (status?.startsWith("canceled") === true) return "canceled";
  return null;
}

function flattenOrders(
  message: LighterAccountAllOrdersStreamMessage,
): ReadonlyMap<string, LighterAccountOrder> {
  const orders = new Map<string, LighterAccountOrder>();
  for (const marketOrders of Object.values(message.orders)) {
    for (const order of marketOrders) orders.set(order.client_order_id, order);
  }
  return orders;
}

function isTerminalState(state: LighterProviderOutcomeExecutionState): boolean {
  return state === "filled" || state === "canceled" || state === "rejected";
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
