import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountOrder,
  LighterAccountPosition,
  LighterTrade,
} from "@tools/lighter/types.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import {
  classifyLighterStreamOrderState,
} from "./order-stream-reconciliation.js";
import {
  reconcileLighterAccountStreamMessage,
  type LighterAccountStreamReconciliationDeps,
  type LighterAccountStreamReconciliationReport,
} from "./account-stream-reconciliation.js";

/**
 * One authoritative account-order resnapshot after a stream connection opens.
 *
 * `account_all_orders` has no documented resumable cursor. A reconnect therefore
 * performs authenticated active/inactive order and trade reads plus a fresh
 * account-position read before trusting the new live lane. Absence is still not
 * evidence: only exact returned identities are fed into reconciliation.
 */

export interface LighterOrderStreamResnapshotDeps {
  readonly client: Pick<
    LighterClient,
    "getAccount" | "getAccountActiveOrders" | "getAccountInactiveOrders" | "getAccountTrades" | "getNextNonce"
  >;
  readonly reconciliation?: Omit<LighterAccountStreamReconciliationDeps, "client">;
}

export interface LighterOrderStreamResnapshotReport {
  readonly activeOrders: number;
  readonly inactiveOrders: number;
  readonly uniqueOrders: number;
  readonly trades: number;
  readonly positions: number;
  readonly reconciliation: LighterAccountStreamReconciliationReport;
  readonly tradeReconciliation: LighterAccountStreamReconciliationReport;
  readonly positionReconciliation: LighterAccountStreamReconciliationReport;
}

export async function resnapshotLighterOrderAccount(
  environment: LighterEnvironment,
  accountIndex: number,
  auth: LighterPrivilegedAccountAuth,
  deps: LighterOrderStreamResnapshotDeps = { client: getLighterClient() },
): Promise<LighterOrderStreamResnapshotReport> {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0) {
    throw new Error("Lighter order resnapshot requires a safe non-negative account index.");
  }
  if (auth.accountIndex !== accountIndex || auth.token.trim().length === 0) {
    throw new Error("Lighter order resnapshot auth does not match the requested account.");
  }

  const [active, inactive, trades, accountResponse] = await Promise.all([
    deps.client.getAccountActiveOrders(environment, {
      accountIndex,
      marketType: "all",
    }, auth),
    deps.client.getAccountInactiveOrders(environment, {
      accountIndex,
      marketType: "all",
      limit: 100,
    }, auth),
    deps.client.getAccountTrades(environment, {
      accountIndex,
      limit: 100,
      sortBy: "timestamp",
    }, auth),
    deps.client.getAccount(environment, {
      by: "index",
      value: String(accountIndex),
      activeOnly: false,
    }),
  ]);

  const accounts = accountResponse.accounts.filter((account) =>
    (account.index ?? account.account_index) === accountIndex);
  if (accounts.length !== 1) {
    throw new Error("Lighter order resnapshot could not resolve the exact account uniquely.");
  }

  const unique = new Map<string, LighterAccountOrder>();
  for (const order of active.orders) chooseMostAdvanced(unique, order);
  for (const order of inactive.orders) chooseMostAdvanced(unique, order);
  const message = toAccountAllOrdersMessage(accountIndex, unique.values());
  const reconciliationDeps = deps.reconciliation === undefined
    ? undefined
    : {
        ...deps.reconciliation,
        client: deps.client,
        orderTransport: "account_orders_resnapshot" as const,
      } satisfies LighterAccountStreamReconciliationDeps;
  const reconciliation = await reconcileLighterAccountStreamMessage(
    environment,
    accountIndex,
    message,
    reconciliationDeps,
  );
  const tradeReconciliation = await reconcileLighterAccountStreamMessage(
    environment,
    accountIndex,
    toAccountAllTradesMessage(accountIndex, trades.trades),
    reconciliationDeps,
  );
  const positions = accounts[0]?.positions ?? [];
  const positionReconciliation = await reconcileLighterAccountStreamMessage(
    environment,
    accountIndex,
    toAccountAllPositionsMessage(accountIndex, positions),
    reconciliationDeps,
  );
  return {
    activeOrders: active.orders.length,
    inactiveOrders: inactive.orders.length,
    uniqueOrders: unique.size,
    trades: trades.trades.length,
    positions: positions.length,
    reconciliation,
    tradeReconciliation,
    positionReconciliation,
  };
}

function chooseMostAdvanced(
  orders: Map<string, LighterAccountOrder>,
  candidate: LighterAccountOrder,
): void {
  const existing = orders.get(candidate.client_order_id);
  if (existing === undefined || stateRank(candidate) >= stateRank(existing)) {
    orders.set(candidate.client_order_id, candidate);
  }
}

function stateRank(order: LighterAccountOrder): number {
  const state = classifyLighterStreamOrderState(order);
  if (state === "filled" || state === "canceled" || state === "rejected") return 4;
  if (state === "partially_filled") return 3;
  if (state === "open") return 2;
  if (state === "sequencer_pending") return 1;
  return 0;
}

function toAccountAllOrdersMessage(
  accountIndex: number,
  orders: Iterable<LighterAccountOrder>,
): LighterAccountAllOrdersStreamMessage {
  const byMarket: Record<string, LighterAccountOrder[]> = {};
  for (const order of orders) {
    const market = String(order.market_index);
    (byMarket[market] ??= []).push(order);
  }
  return {
    type: "update/account_all_orders",
    channel: `account_all_orders:${accountIndex}`,
    orders: byMarket,
  };
}

function toAccountAllTradesMessage(
  accountIndex: number,
  trades: readonly LighterTrade[],
) {
  const byMarket: Record<string, LighterTrade[]> = {};
  for (const trade of trades) (byMarket[String(trade.market_id)] ??= []).push(trade);
  return {
    type: "update/account_all_trades" as const,
    channel: `account_all_trades:${accountIndex}`,
    trades: byMarket,
  };
}

function toAccountAllPositionsMessage(
  accountIndex: number,
  positions: readonly LighterAccountPosition[],
) {
  const byMarket: Record<string, LighterAccountPosition> = {};
  for (const position of positions) byMarket[String(position.market_id)] = position;
  return {
    type: "subscribed/account_all_positions" as const,
    channel: `account_all_positions:${accountIndex}`,
    positions: byMarket,
    shares: [],
  };
}
