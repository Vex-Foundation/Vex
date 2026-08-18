import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import type {
  LighterAccountAllOrdersStreamMessage,
  LighterAccountOrder,
} from "@tools/lighter/types.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import {
  classifyLighterStreamOrderState,
  reconcileLighterOrderStreamMessage,
  type LighterOrderStreamReconciliationDeps,
  type LighterOrderStreamReconciliationReport,
} from "./order-stream-reconciliation.js";

/**
 * One authoritative account-order resnapshot after a stream connection opens.
 *
 * `account_all_orders` has no documented resumable cursor. A reconnect therefore
 * performs one authenticated active/inactive REST read for the account before
 * trusting the new live lane. Absence is still not evidence: only exact returned
 * orders are fed into the positive-evidence reconciler.
 */

export interface LighterOrderStreamResnapshotDeps {
  readonly client: Pick<
    LighterClient,
    "getAccountActiveOrders" | "getAccountInactiveOrders" | "getNextNonce"
  >;
  readonly reconciliation?: Omit<LighterOrderStreamReconciliationDeps, "client">;
}

export interface LighterOrderStreamResnapshotReport {
  readonly activeOrders: number;
  readonly inactiveOrders: number;
  readonly uniqueOrders: number;
  readonly reconciliation: LighterOrderStreamReconciliationReport;
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

  const [active, inactive] = await Promise.all([
    deps.client.getAccountActiveOrders(environment, {
      accountIndex,
      marketType: "all",
    }, auth),
    deps.client.getAccountInactiveOrders(environment, {
      accountIndex,
      marketType: "all",
      limit: 100,
    }, auth),
  ]);

  const unique = new Map<string, LighterAccountOrder>();
  for (const order of active.orders) chooseMostAdvanced(unique, order);
  for (const order of inactive.orders) chooseMostAdvanced(unique, order);
  const message = toAccountAllOrdersMessage(accountIndex, unique.values());
  const reconciliationDeps = deps.reconciliation === undefined
    ? undefined
    : {
        ...deps.reconciliation,
        client: deps.client,
        transport: "account_orders_resnapshot" as const,
      } satisfies LighterOrderStreamReconciliationDeps;
  const reconciliation = await reconcileLighterOrderStreamMessage(
    environment,
    accountIndex,
    message,
    reconciliationDeps,
  );
  return {
    activeOrders: active.orders.length,
    inactiveOrders: inactive.orders.length,
    uniqueOrders: unique.size,
    reconciliation,
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
