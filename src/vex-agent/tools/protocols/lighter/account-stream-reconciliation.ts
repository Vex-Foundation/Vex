import { confirmedLighterCloseDisposition } from "./close-position-confirmation.js";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import { decimalToLighterInteger } from "@tools/lighter/order-preview.js";
import { deriveVexAssignedClientOrderIndex } from "@tools/lighter/signer-order.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllPositionsStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountOrder,
  LighterAccountPosition,
  LighterAccountStreamMessage,
  LighterTrade,
} from "@tools/lighter/types.js";
import * as lifecycleIntentsRepo from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import * as nonceStateRepo from "@vex-agent/db/repos/lighter-nonce-state.js";
import * as orderIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import {
  findMatchingLighterTrade,
  lighterOrderIdFromTrade,
  lighterTradeEvidenceJson,
} from "./order-evidence.js";
import {
  reconcileLighterOrderStreamMessage,
  type LighterOrderStreamReconciliationReport,
} from "./order-stream-reconciliation.js";

export interface LighterAccountStreamReconciliationDeps {
  readonly client: Pick<LighterClient, "getNextNonce">;
  readonly orderIntents: Pick<
    typeof orderIntentsRepo,
    "listStreamWatchable" | "markStreamOutcome" | "markEvidenceConflict"
  >;
  readonly lifecycleIntents: Pick<typeof lifecycleIntentsRepo, "listStreamWatchable" | "markStreamEvidence">;
  readonly nonceState: Pick<typeof nonceStateRepo, "find" | "recordExecutionObserved">;
  readonly orderTransport?: "account_all_orders_stream" | "account_orders_resnapshot";
}

export interface LighterAccountStreamReconciliationReport {
  readonly frameType: LighterAccountStreamMessage["type"];
  readonly createOrders: LighterOrderStreamReconciliationReport | null;
  readonly createTradeMatches: number;
  readonly lifecycleExamined: number;
  readonly lifecycleMatched: number;
  readonly lifecycleAdvanced: number;
  readonly lifecycleDeduplicated: number;
  readonly nonceScopesRefreshed: number;
  readonly nonceRefreshFailures: number;
}

export function defaultLighterAccountStreamReconciliationDeps(): LighterAccountStreamReconciliationDeps {
  return {
    client: getLighterClient(),
    orderIntents: orderIntentsRepo,
    lifecycleIntents: lifecycleIntentsRepo,
    nonceState: nonceStateRepo,
  };
}

/**
 * Reconcile one already-validated account-scoped frame. No absence inference is
 * performed: only exact order, client-order, trade, or position identities can
 * advance durable state.
 */
export async function reconcileLighterAccountStreamMessage(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountStreamMessage,
  deps: LighterAccountStreamReconciliationDeps = defaultLighterAccountStreamReconciliationDeps(),
): Promise<LighterAccountStreamReconciliationReport> {
  let createOrders: LighterOrderStreamReconciliationReport | null = null;
  let createTradeMatches = 0;
  if (message.type === "update/account_all_orders") {
    createOrders = await reconcileLighterOrderStreamMessage(environment, accountIndex, message, {
      client: deps.client,
      intents: deps.orderIntents,
      nonceState: deps.nonceState,
      transport: deps.orderTransport,
    });
  } else if (
    message.type === "subscribed/account_all_trades"
    || message.type === "update/account_all_trades"
  ) {
    createTradeMatches = await reconcileCreateOrderTrades(environment, accountIndex, message, deps);
  }

  const lifecycle = await reconcileLifecycleFrame(environment, accountIndex, message, deps);
  return {
    frameType: message.type,
    createOrders,
    createTradeMatches,
    ...lifecycle,
  };
}

async function reconcileCreateOrderTrades(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountAllTradesStreamMessage,
  deps: LighterAccountStreamReconciliationDeps,
): Promise<number> {
  const trades = flattenTrades(message);
  if (trades.length === 0) return 0;
  const intents = await deps.orderIntents.listStreamWatchable(environment, accountIndex, 500);
  let matched = 0;
  for (const intent of intents) {
    if (intent.clientOrderIndex === null) continue;
    const trade = findMatchingLighterTrade(trades, {
      accountIndex,
      marketIndex: intent.marketIndex,
      side: intent.side,
    }, intent.clientOrderIndex, intent.submittedTxHash ?? "__no_submitted_hash__");
    if (trade === null) continue;
    matched += 1;
    if (
      intent.providerOutcomeSource === "account_trade"
      && intent.providerOutcomeJson?.tradeId === trade.trade_id_str
    ) continue;
    await deps.orderIntents.markStreamOutcome({
      intentId: intent.intentId,
      environment,
      state: "partially_filled",
      source: "account_trade",
      providerOrderId: lighterOrderIdFromTrade(trade, {
        accountIndex,
        marketIndex: intent.marketIndex,
        side: intent.side,
      }),
      providerOrderStatus: "trade_seen",
      providerOutcomeJson: {
        ...lighterTradeEvidenceJson(trade, {
          accountIndex,
          marketIndex: intent.marketIndex,
          side: intent.side,
        }, intent.clientOrderIndex),
        transport: "account_all_trades_stream",
        frameType: message.type,
      },
    });
  }
  return matched;
}

async function reconcileLifecycleFrame(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountStreamMessage,
  deps: LighterAccountStreamReconciliationDeps,
): Promise<Omit<LighterAccountStreamReconciliationReport, "frameType" | "createOrders" | "createTradeMatches">> {
  const intents = await deps.lifecycleIntents.listStreamWatchable(environment, accountIndex, 500);
  const nonceScopes = new Map<string, LighterOrderLifecycleIntentRow>();
  let lifecycleMatched = 0;
  let lifecycleAdvanced = 0;
  let lifecycleDeduplicated = 0;

  for (const intent of intents) {
    const outcome = lifecycleOutcome(intent, message);
    if (outcome === null) continue;
    lifecycleMatched += 1;
    if (sameJson(intent.providerOutcomeJson, outcome.evidence) && intent.executionState === outcome.state) {
      lifecycleDeduplicated += 1;
      continue;
    }
    const persisted = await deps.lifecycleIntents.markStreamEvidence({
      intentId: intent.intentId,
      environment,
      accountIndex,
      state: outcome.state,
      evidence: outcome.evidence,
    });
    if (persisted === null) continue;
    lifecycleAdvanced += 1;
    nonceScopes.set(`${intent.environment}:${intent.accountIndex}:${intent.apiKeyIndex}`, intent);
  }

  let nonceScopesRefreshed = 0;
  let nonceRefreshFailures = 0;
  for (const intent of nonceScopes.values()) {
    try {
      await refreshNonce(intent, deps);
      nonceScopesRefreshed += 1;
    } catch {
      nonceRefreshFailures += 1;
    }
  }
  return {
    lifecycleExamined: intents.length,
    lifecycleMatched,
    lifecycleAdvanced,
    lifecycleDeduplicated,
    nonceScopesRefreshed,
    nonceRefreshFailures,
  };
}

function lifecycleOutcome(
  intent: LighterOrderLifecycleIntentRow,
  message: LighterAccountStreamMessage,
): { readonly state: "sequencer_pending" | "completed" | "rejected"; readonly evidence: Record<string, unknown> } | null {
  const previous = previousLifecycleEvidence(intent);
  if (message.type === "update/account_all_orders") {
    return lifecycleOrderOutcome(intent, message, previous);
  }
  if (message.type === "subscribed/account_all_trades" || message.type === "update/account_all_trades") {
    if (intent.actionType !== "close_position") return null;
    const trade = matchingCloseTrade(intent, flattenTrades(message));
    if (trade === null) return null;
    const trades = readEvidenceArray(previous.trades, "tradeId");
    if (!trades.some((entry) => entry.tradeId === trade.trade_id_str)) {
      trades.push({
        tradeId: trade.trade_id_str,
        orderId: intent.requestedSide === "buy" ? trade.bid_id_str : trade.ask_id_str,
        size: trade.size,
        price: trade.price,
        txHash: trade.tx_hash,
      });
      trades.sort((left, right) => compareIntegerStrings(String(left.tradeId), String(right.tradeId)));
      while (trades.length > 100) trades.shift();
    }
    return finishCloseOutcome(intent, { ...previous, trades, lastFrameType: message.type });
  }
  if (intent.actionType !== "close_position" || intent.marketIndex === null) return null;
  const positionMessage = message as LighterAccountAllPositionsStreamMessage;
  const position = positionMessage.positions[String(intent.marketIndex)];
  if (position === undefined) return null;
  return finishCloseOutcome(intent, {
    ...previous,
    resultingPosition: positionEvidence(position),
    lastFrameType: message.type,
  });
}

function lifecycleOrderOutcome(
  intent: LighterOrderLifecycleIntentRow,
  message: LighterAccountAllOrdersStreamMessage,
  previous: Record<string, unknown>,
): { readonly state: "sequencer_pending" | "completed" | "rejected"; readonly evidence: Record<string, unknown> } | null {
  const orders = flattenOrders(message);
  if (intent.actionType === "cancel_all") {
    const targets = approvedCancelAllTargets(intent);
    const terminal = new Map(readEvidenceArray(previous.terminalOrders, "orderId")
      .map((entry) => [String(entry.orderId), entry]));
    let matched = false;
    for (const target of targets) {
      const order = orders.find((candidate) =>
        candidate.owner_account_index === intent.accountIndex
        && candidate.market_index === target.marketIndex
        && candidate.order_id === target.orderId);
      if (order === undefined || !isTerminalStatus(order.status)) continue;
      matched = true;
      terminal.set(order.order_id, orderEvidence(order));
    }
    if (!matched) return null;
    const terminalOrders = [...terminal.values()].sort((left, right) =>
      String(left.orderId).localeCompare(String(right.orderId)));
    const evidence = lifecycleEvidence(intent, {
      ...previous,
      terminalOrders,
      targetCount: targets.length,
      lastFrameType: message.type,
    });
    return {
      state: terminal.size === targets.length ? "completed" : "sequencer_pending",
      evidence,
    };
  }

  if (intent.marketIndex === null) return null;
  const order = intent.actionType === "close_position"
    ? orders.find((candidate) =>
        candidate.owner_account_index === intent.accountIndex
        && candidate.market_index === intent.marketIndex
        && candidate.client_order_id === deriveVexAssignedClientOrderIndex(intent.matchHash))
    : orders.find((candidate) =>
        candidate.owner_account_index === intent.accountIndex
        && candidate.market_index === intent.marketIndex
        && candidate.order_id === intent.providerOrderId);
  if (order === undefined) return null;

  if (intent.actionType === "cancel_one") {
    if (!isTerminalStatus(order.status)) return null;
    return {
      state: "completed",
      evidence: lifecycleEvidence(intent, {
        ...previous,
        terminalOrder: orderEvidence(order),
        disposition: isCanceledStatus(order.status) ? "canceled" : "target_already_terminal",
        lastFrameType: message.type,
      }),
    };
  }
  if (intent.actionType === "modify") {
    if (!matchesRequestedModification(intent, order)) return null;
    return {
      state: "completed",
      evidence: lifecycleEvidence(intent, {
        ...previous,
        modifiedOrder: orderEvidence(order),
        disposition: "modified",
        lastFrameType: message.type,
      }),
    };
  }
  if (intent.actionType === "close_position") {
    if (!isTerminalStatus(order.status)) return null;
    return finishCloseOutcome(intent, {
      ...previous,
      closeOrder: orderEvidence(order),
      lastFrameType: message.type,
    });
  }
  return null;
}

function finishCloseOutcome(
  intent: LighterOrderLifecycleIntentRow,
  detail: Record<string, unknown>,
): { readonly state: "sequencer_pending" | "completed"; readonly evidence: Record<string, unknown> } {
  const closeOrder = asRecord(detail.closeOrder);
  const resultingPosition = asRecord(detail.resultingPosition);
  const initialPosition = asRecord(intent.providerSnapshotJson.position);
  const disposition = confirmedLighterCloseDisposition({
    initialPosition: initialPosition?.position, initialSign: initialPosition?.sign,
    filledAmount: closeOrder?.filledBaseAmount,
    resultingPosition: resultingPosition?.position, resultingSign: resultingPosition?.sign,
    sizeDecimals: intent.providerSnapshotJson.marketSizeDecimals,
  });
  return {
    state: disposition === null ? "sequencer_pending" : "completed",
    evidence: lifecycleEvidence(intent, {
      ...detail,
      disposition: disposition ?? "awaiting_correlated_order_and_position",
    }),
  };
}

function lifecycleEvidence(
  intent: LighterOrderLifecycleIntentRow,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "lighter_lifecycle_stream_evidence",
    actionType: intent.actionType,
    accountIndex: intent.accountIndex,
    marketIndex: intent.marketIndex,
    transport: "lighter_account_stream",
    ...detail,
  };
}

function previousLifecycleEvidence(intent: LighterOrderLifecycleIntentRow): Record<string, unknown> {
  return intent.providerOutcomeJson?.kind === "lighter_lifecycle_stream_evidence"
    ? { ...intent.providerOutcomeJson }
    : {};
}

function approvedCancelAllTargets(intent: LighterOrderLifecycleIntentRow): Array<{ orderId: string; marketIndex: number }> {
  if (!Array.isArray(intent.providerSnapshotJson.orders)) return [];
  return intent.providerSnapshotJson.orders.flatMap((value) => {
    const row = asRecord(value);
    return row !== null && typeof row.orderId === "string" && Number.isInteger(row.marketIndex)
      ? [{ orderId: row.orderId, marketIndex: row.marketIndex as number }]
      : [];
  });
}

function matchesRequestedModification(intent: LighterOrderLifecycleIntentRow, order: LighterAccountOrder): boolean {
  const sizeDecimals = intent.providerSnapshotJson.marketSizeDecimals;
  const priceDecimals = intent.providerSnapshotJson.marketPriceDecimals;
  if (!Number.isInteger(sizeDecimals) || !Number.isInteger(priceDecimals)) return false;
  try {
    return decimalToLighterInteger(order.initial_base_amount, sizeDecimals as number, "stream order amount").toString()
      === intent.requestedBaseAmountInteger
      && decimalToLighterInteger(order.price, priceDecimals as number, "stream order price").toString()
      === intent.requestedPriceInteger;
  } catch {
    return false;
  }
}

function matchingCloseTrade(
  intent: LighterOrderLifecycleIntentRow,
  trades: readonly LighterTrade[],
): LighterTrade | null {
  if (intent.marketIndex === null || intent.requestedSide === null) return null;
  const clientOrderId = deriveVexAssignedClientOrderIndex(intent.matchHash);
  return trades.find((trade) => {
    if (trade.market_id !== intent.marketIndex) return false;
    return intent.requestedSide === "buy"
      ? trade.bid_account_id === intent.accountIndex && trade.bid_client_id_str === clientOrderId
      : trade.ask_account_id === intent.accountIndex && trade.ask_client_id_str === clientOrderId;
  }) ?? null;
}

function flattenOrders(message: LighterAccountAllOrdersStreamMessage): LighterAccountOrder[] {
  return Object.values(message.orders).flatMap((orders) => [...orders]);
}

function flattenTrades(message: LighterAccountAllTradesStreamMessage): LighterTrade[] {
  return Array.isArray(message.trades)
    ? [...message.trades]
    : Object.values(message.trades).flatMap((trades) => [...trades]);
}

function orderEvidence(order: LighterAccountOrder): Record<string, unknown> {
  return {
    orderId: order.order_id,
    clientOrderId: order.client_order_id,
    marketIndex: order.market_index,
    status: order.status ?? "",
    initialBaseAmount: order.initial_base_amount,
    remainingBaseAmount: order.remaining_base_amount ?? "0",
    filledBaseAmount: order.filled_base_amount ?? "0",
    filledQuoteAmount: order.filled_quote_amount ?? "0",
    price: order.price,
  };
}

function positionEvidence(position: LighterAccountPosition): Record<string, unknown> {
  return {
    marketIndex: position.market_id,
    symbol: position.symbol,
    sign: position.sign,
    position: position.position,
    averageEntryPrice: position.avg_entry_price,
    positionValue: position.position_value,
    unrealizedPnl: position.unrealized_pnl,
    realizedPnl: position.realized_pnl,
    liquidationPrice: position.liquidation_price,
  };
}

function isTerminalStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "filled" || isCanceledStatus(normalized);
}

function isCanceledStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized?.startsWith("canceled") === true || normalized?.includes("expire") === true;
}

function isZeroDecimal(value: string): boolean {
  return /^0(?:\.0+)?$/.test(value);
}

function compareIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readEvidenceArray(value: unknown, requiredKey: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record !== null
      && typeof record[requiredKey] === "string"
      && /^\d+$/.test(record[requiredKey] as string)
      ? [{ ...record }]
      : [];
  }).slice(0, 100);
}

function sameJson(left: Record<string, unknown> | null, right: Record<string, unknown>): boolean {
  return left !== null && stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (record !== null) {
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function refreshNonce(
  intent: LighterOrderLifecycleIntentRow,
  deps: LighterAccountStreamReconciliationDeps,
): Promise<void> {
  const next = await deps.client.getNextNonce(intent.environment, {
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
  });
  const nonce = await deps.nonceState.find(intent.environment, intent.accountIndex, intent.apiKeyIndex);
  if (nonce === null || nonce.status === "observed") return;
  await deps.nonceState.recordExecutionObserved({
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    nonce: next.nonce,
    publicKey: nonce.publicKey,
    transactionTime: null,
  });
}
