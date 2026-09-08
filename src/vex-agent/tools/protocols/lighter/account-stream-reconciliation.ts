import { confirmedLighterCloseDisposition } from "./close-position-confirmation.js";
import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
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
  lighterOrderIdFromTrade,
  lighterTradeEvidenceJson,
} from "./order-evidence.js";
import {
  defaultLighterFillObservationDeps,
  matchingLighterTrades,
  observeLighterFills,
  observeLighterFillsFromAccountTrades,
  type LighterFillObservationDeps,
} from "./fill-observation.js";
import { resolveLighterReadOnlyAccountAuth } from "./read-account-auth.js";
import {
  classifyLighterStreamOrderState,
  reconcileLighterOrderStreamMessage,
  type LighterOrderStreamReconciliationReport,
} from "./order-stream-reconciliation.js";
import logger from "@utils/logger.js";

export interface LighterAccountStreamReconciliationDeps {
  readonly client: Pick<LighterClient, "getNextNonce" | "getAccountTrades">;
  readonly orderIntents: Pick<
    typeof orderIntentsRepo,
    "listStreamWatchable" | "markStreamOutcome" | "markEvidenceConflict"
  >;
  readonly lifecycleIntents: Pick<typeof lifecycleIntentsRepo, "listStreamWatchable" | "markStreamEvidence">;
  readonly nonceState: Pick<typeof nonceStateRepo, "find" | "recordExecutionObserved">;
  readonly orderTransport?: "account_all_orders_stream" | "account_orders_resnapshot";
  /**
   * The fill observation boundary. Optional so a caller that assembles its own
   * deps neither reaches the provider nor writes the ledger by accident;
   * production always arrives through
   * {@link defaultLighterAccountStreamReconciliationDeps}, which wires it.
   */
  readonly fills?: LighterFillObservationDeps;
  /**
   * Mints the short-lived READ-ONLY account token the follow-up trades read
   * needs. Optional for the same reason `fills` is; production arrives through
   * {@link defaultLighterAccountStreamReconciliationDeps}, which wires the
   * process-wide resolver the main process installs. Without it an order frame
   * still advances the intent and simply records no follow-up fill.
   */
  readonly resolveAuth?: (
    environment: LighterOrderExecutionIntentRow["environment"],
    accountIndex: number,
  ) => Promise<LighterPrivilegedAccountAuth | null>;
}

export interface LighterAccountStreamReconciliationReport {
  readonly frameType: LighterAccountStreamMessage["type"];
  readonly createOrders: LighterOrderStreamReconciliationReport | null;
  readonly createTradeMatches: number;
  /** Fills OBSERVED in this frame, over every matched intent. */
  readonly fillsObserved: number;
  /** Ledger rows this frame inserted. Fewer than observed on a re-observation. */
  readonly fillsRecorded: number;
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
    fills: defaultLighterFillObservationDeps(),
    resolveAuth: resolveLighterReadOnlyAccountAuth,
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
  let fills = { observed: 0, recorded: 0 };
  if (message.type === "update/account_all_orders") {
    // The candidates are collected BEFORE the transition, because an intent
    // that reaches `filled` leaves the stream-watchable set and could not be
    // found afterwards.
    const candidates = await orderFrameFillCandidates(environment, accountIndex, message, deps);
    createOrders = await reconcileLighterOrderStreamMessage(environment, accountIndex, message, {
      client: deps.client,
      intents: deps.orderIntents,
      nonceState: deps.nonceState,
      transport: deps.orderTransport,
    });
    fills = await observeFillsBehindOrderFrame(environment, accountIndex, candidates, deps);
  } else if (
    message.type === "subscribed/account_all_trades"
    || message.type === "update/account_all_trades"
  ) {
    const outcome = await reconcileCreateOrderTrades(environment, accountIndex, message, deps);
    createTradeMatches = outcome.matched;
    fills = { observed: outcome.fillsObserved, recorded: outcome.fillsRecorded };
  }

  const lifecycle = await reconcileLifecycleFrame(environment, accountIndex, message, deps);
  return {
    frameType: message.type,
    createOrders,
    createTradeMatches,
    fillsObserved: fills.observed,
    fillsRecorded: fills.recorded,
    ...lifecycle,
  };
}

/**
 * THE ORDER-FRAME GAP, and the two functions that close it.
 *
 * An `update/account_all_orders` frame carries NO trades. Measured live on
 * 2026-09-08: an IOC buy settled from exactly such a frame (status filled)
 * before any trade frame was consumed, so the intent reached `filled`, the
 * execution returned, and not one row reached `lighter_fills`. An order row
 * says how much filled; only a trade record carries the identity, price, size
 * and fee ticks a ledger row is made of.
 *
 * The candidate scan below is PURE - it reads the frame and, only when the
 * frame actually names a fill, one local page of watchable intents. A frame
 * that fills nothing costs zero queries and zero provider requests.
 */
async function orderFrameFillCandidates(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountAllOrdersStreamMessage,
  deps: LighterAccountStreamReconciliationDeps,
): Promise<readonly LighterOrderExecutionIntentRow[]> {
  if (deps.fills === undefined || deps.resolveAuth === undefined) return [];
  const filledClientOrderIds = new Set<string>();
  for (const order of flattenOrders(message)) {
    if (order.owner_account_index !== accountIndex) continue;
    const state = classifyLighterStreamOrderState(order);
    if (state === "filled" || state === "partially_filled") {
      filledClientOrderIds.add(order.client_order_id);
    }
  }
  if (filledClientOrderIds.size === 0) return [];
  const intents = await deps.orderIntents.listStreamWatchable(environment, accountIndex, 500);
  return intents.filter((intent) =>
    intent.clientOrderIndex !== null && filledClientOrderIds.has(intent.clientOrderIndex));
}

/**
 * ONE bounded follow-up read per frame, after the transitions have committed.
 *
 * The trades page is ACCOUNT-scoped, so a single read serves every candidate
 * in the frame; a per-intent read would multiply provider requests for the
 * same bytes. Each candidate that already has a ledger row is skipped before
 * the read is made, which is what keeps a repeated `partially_filled` frame
 * from re-reading forever.
 *
 * The read never throws and never touches the durable outcome the reconciler
 * just committed: a failure is counted and the next frame reads again.
 */
async function observeFillsBehindOrderFrame(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  candidates: readonly LighterOrderExecutionIntentRow[],
  deps: LighterAccountStreamReconciliationDeps,
): Promise<{ readonly observed: number; readonly recorded: number }> {
  const fills = deps.fills;
  const resolveAuth = deps.resolveAuth;
  if (candidates.length === 0 || fills === undefined || resolveAuth === undefined) {
    return { observed: 0, recorded: 0 };
  }
  let auth: LighterPrivilegedAccountAuth | null;
  try {
    auth = await resolveAuth(environment, accountIndex);
  } catch {
    auth = null;
  }
  if (auth === null) return { observed: 0, recorded: 0 };

  let observed = 0;
  let recorded = 0;
  let failed = 0;
  for (const intent of candidates) {
    const report = await observeLighterFillsFromAccountTrades({
      intent: {
        intentId: intent.intentId,
        environment,
        accountIndex,
        marketIndex: intent.marketIndex,
        side: intent.side,
        clientOrderIndex: intent.clientOrderIndex,
      },
      authorizedFees: intent.integratorFees ?? null,
      deps: fills,
      read: {
        // Bound through a closure: the production client is a class instance
        // whose method needs its receiver.
        getAccountTrades: (tradeEnvironment, params, tradeAuth) =>
          deps.client.getAccountTrades(tradeEnvironment, params, tradeAuth),
        auth,
        submittedTxHash: intent.submittedTxHash ?? "__no_submitted_hash__",
      },
      onlyWhenLedgerAlreadyEmpty: true,
    });
    observed += report.observed;
    recorded += report.recorded;
    failed += report.failed;
  }
  if (observed > 0 || failed > 0) {
    logger.info("lighter.fill_observation.follow_up", {
      site: "account_stream_order_frame",
      environment,
      accountIndex,
      candidates: candidates.length,
      observed,
      recorded,
      failed,
    });
  }
  return { observed, recorded };
}

async function reconcileCreateOrderTrades(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountAllTradesStreamMessage,
  deps: LighterAccountStreamReconciliationDeps,
): Promise<{ readonly matched: number; readonly fillsObserved: number; readonly fillsRecorded: number }> {
  const trades = flattenTrades(message);
  if (trades.length === 0) return { matched: 0, fillsObserved: 0, fillsRecorded: 0 };
  const intents = await deps.orderIntents.listStreamWatchable(environment, accountIndex, 500);
  let matched = 0;
  let fillsObserved = 0;
  let fillsRecorded = 0;
  for (const intent of intents) {
    if (intent.clientOrderIndex === null) continue;
    const scope = { accountIndex, marketIndex: intent.marketIndex, side: intent.side };
    // EVERY matching trade in the frame, not the first one. A frame can carry
    // several fills of one order; the outcome below records ONE of them as its
    // evidence and deduplicates the rest away, so a ledger write that ran off
    // that evidence would lose the others permanently.
    const matches = matchingLighterTrades(
      trades,
      scope,
      intent.clientOrderIndex,
      intent.submittedTxHash ?? "__no_submitted_hash__",
    );
    const trade = matches[0];
    if (trade === undefined) continue;
    matched += 1;

    // THE OBSERVATION BOUNDARY, BEFORE THE DEDUPLICATION BELOW. The ledger is
    // idempotent by canonical identity, so a re-observed frame writes nothing
    // new; skipping it because the intent's mutable evidence already names one
    // of these trades is what would drop the others.
    if (deps.fills !== undefined) {
      const observation = await observeLighterFills({
        intent: {
          intentId: intent.intentId,
          environment,
          accountIndex,
          marketIndex: intent.marketIndex,
          side: intent.side,
          clientOrderIndex: intent.clientOrderIndex,
        },
        trades: matches,
        authorizedFees: intent.integratorFees ?? null,
        deps: deps.fills,
      });
      fillsObserved += observation.observed;
      fillsRecorded += observation.recorded;
    }

    if (
      intent.providerOutcomeSource === "account_trade"
      && intent.providerOutcomeJson?.tradeId === trade.trade_id_str
    ) continue;
    await deps.orderIntents.markStreamOutcome({
      intentId: intent.intentId,
      environment,
      state: "partially_filled",
      source: "account_trade",
      providerOrderId: lighterOrderIdFromTrade(trade, scope),
      providerOrderStatus: "trade_seen",
      providerOutcomeJson: {
        ...lighterTradeEvidenceJson(trade, scope, intent.clientOrderIndex),
        transport: "account_all_trades_stream",
        frameType: message.type,
      },
    });
  }
  return { matched, fillsObserved, fillsRecorded };
}

async function reconcileLifecycleFrame(
  environment: LighterOrderExecutionIntentRow["environment"],
  accountIndex: number,
  message: LighterAccountStreamMessage,
  deps: LighterAccountStreamReconciliationDeps,
): Promise<Omit<
  LighterAccountStreamReconciliationReport,
  "frameType" | "createOrders" | "createTradeMatches" | "fillsObserved" | "fillsRecorded"
>> {
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
    const retainedTrades = readEvidenceArray(previous.trades, "tradeId");
    const trades = [...retainedTrades.rows];
    let droppedTrades = readCount(previous.tradesDropped) + retainedTrades.dropped;
    let totalTrades = Math.max(readCount(previous.tradesTotal), trades.length + droppedTrades);
    if (!trades.some((entry) => entry.tradeId === trade.trade_id_str)) {
      trades.push({
        tradeId: trade.trade_id_str,
        orderId: intent.requestedSide === "buy" ? trade.bid_id_str : trade.ask_id_str,
        size: trade.size,
        price: trade.price,
        txHash: trade.tx_hash,
      });
      trades.sort((left, right) => compareIntegerStrings(String(left.tradeId), String(right.tradeId)));
      totalTrades += 1;
      // Bounded tail: the oldest rows go first and the drop is COUNTED, so a
      // reader can tell how many fills the retained evidence leaves out.
      while (trades.length > LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS) {
        trades.shift();
        droppedTrades += 1;
      }
    }
    return finishCloseOutcome(intent, {
      ...previous,
      trades,
      tradesRetained: trades.length,
      tradesTotal: totalTrades,
      tradesDropped: droppedTrades,
      tradesTruncated: droppedTrades > 0,
      lastFrameType: message.type,
    });
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
    const retainedTerminal = readEvidenceArray(previous.terminalOrders, "orderId");
    const terminal = new Map(retainedTerminal.rows.map((entry) => [String(entry.orderId), entry]));
    // The completion decision is made on the COMPLETE id set, never on the
    // bounded rich rows: a cancel-all with more targets than the evidence
    // bound must still be able to reach "completed".
    const confirmedIds = new Set<string>([
      ...readEvidenceIds(previous.terminalOrderIds),
      ...terminal.keys(),
    ]);
    let matched = false;
    for (const target of targets) {
      const order = orders.find((candidate) =>
        candidate.owner_account_index === intent.accountIndex
        && candidate.market_index === target.marketIndex
        && candidate.order_id === target.orderId);
      if (order === undefined || !isTerminalStatus(order.status)) continue;
      matched = true;
      terminal.set(order.order_id, orderEvidence(order));
      confirmedIds.add(order.order_id);
    }
    if (!matched) return null;
    const ordered = [...terminal.values()].sort((left, right) =>
      String(left.orderId).localeCompare(String(right.orderId)));
    const terminalOrders = ordered.slice(-LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS);
    const droppedTerminal = retainedTerminal.dropped + (ordered.length - terminalOrders.length);
    const evidence = lifecycleEvidence(intent, {
      ...previous,
      terminalOrders,
      terminalOrderIds: [...confirmedIds].sort(),
      terminalOrdersRetained: terminalOrders.length,
      terminalOrdersTotal: confirmedIds.size,
      terminalOrdersDropped: droppedTerminal,
      terminalOrdersTruncated: confirmedIds.size > terminalOrders.length,
      targetCount: targets.length,
      lastFrameType: message.type,
    });
    return {
      state: confirmedIds.size >= targets.length ? "completed" : "sequencer_pending",
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

/**
 * Rows of retained provider evidence kept inline on a lifecycle intent. The
 * bound is on the RICH rows only: identity sets that a state decision depends
 * on are kept complete (see terminalOrderIds).
 */
export const LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS = 100;

/**
 * Reads a retained evidence array and REPORTS what the bound left out, so a
 * caller never mistakes a bounded window for the whole record.
 */
function readEvidenceArray(
  value: unknown,
  requiredKey: string,
): { readonly rows: Record<string, unknown>[]; readonly dropped: number } {
  if (!Array.isArray(value)) return { rows: [], dropped: 0 };
  const rows = value.flatMap((entry) => {
    const record = asRecord(entry);
    return record !== null
      && typeof record[requiredKey] === "string"
      && /^\d+$/.test(record[requiredKey] as string)
      ? [{ ...record }]
      : [];
  });
  return {
    rows: rows.slice(0, LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS),
    dropped: Math.max(0, rows.length - LIGHTER_LIFECYCLE_EVIDENCE_MAX_ROWS),
  };
}

function readEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && /^\d+$/.test(entry));
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
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
