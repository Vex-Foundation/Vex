/**
 * Indexify account handlers — auth-gated reads over the linked custodial
 * account: balances, per-stack holdings, orders, and transaction history.
 *
 * The `requiresEnv` gate has already run by the time these execute, so the
 * client's own INDEXIFY_AUTH_REQUIRED throw is defense-in-depth, not the
 * primary gate.
 */

import { getIndexifyClient } from "@tools/indexify/client.js";
import type { IndexifyOrderStatus } from "@tools/indexify/constants.js";
import {
  INDEXIFY_HISTORY_LIMIT_CAP,
  INDEXIFY_HISTORY_LIMIT_DEFAULT,
  INDEXIFY_ORDER_STATUSES,
} from "@tools/indexify/constants.js";
import { ok, fail, num, str } from "../../handler-helpers.js";
import { readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { indexifyFailureDetail } from "./failure.js";

const PAGE_NUMERIC_PARAMS: NumericParamSpecs = {
  limit: { domain: "nonNegative", integer: true, min: 1, max: INDEXIFY_HISTORY_LIMIT_CAP },
  offset: { domain: "nonNegative", integer: true },
  stackId: { domain: "nonNegative", integer: true },
};

export async function indexifyPortfolioHandler(
  _p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  try {
    const portfolio = await getIndexifyClient().portfolio({ signal: context.abortSignal });
    return ok({
      account: "linked Indexify account (custodial venue balance, not a Vex session wallet)",
      usdcBalance: portfolio.usdcBalance,
      usdcReserved: portfolio.usdcReserved,
      totalBalanceUsdc: portfolio.totalBalanceUsdc,
      // The embedded wallet address doubles as the USDC deposit address.
      // USDC on Solana ONLY — the venue holds nothing else.
      walletAddress: portfolio.walletAddress,
      depositNote: "Deposit USDC on Solana only to this address; the venue trades nothing else and sponsors gas.",
    });
  } catch (err) {
    return fail(`Indexify portfolio unavailable (${indexifyFailureDetail("indexify__portfolio_get", err)})`);
  }
}

export async function indexifyHoldingsHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const stackId = num(p, "stackId");
  if (stackId === undefined || !Number.isInteger(stackId) || stackId <= 0) {
    return fail("Missing or invalid required: stackId (a positive integer stack id).");
  }
  try {
    const holdings = await getIndexifyClient().stackHoldings(stackId, { signal: context.abortSignal });
    const isEmpty = holdings.total_usdc === 0 && holdings.total_invested === 0;
    return ok({
      stackId: holdings.stack_id,
      currentValueUsdc: holdings.total_usdc,
      totalInvestedUsdc: holdings.total_invested,
      costBasisUsdc: holdings.total_cost_basis,
      pnl: {
        total: holdings.pnl.profit_loss ?? null,
        realized: holdings.pnl.realized_pnl ?? null,
        unrealized: holdings.pnl.unrealized_pnl ?? null,
        totalPercent: holdings.pnl.profit_loss_percent ?? null,
        unrealizedPercent: holdings.pnl.unrealized_pnl_percent ?? null,
      },
      ...(isEmpty
        ? {
          note: "Zeros mean the account holds nothing in this stack. If a buy was just placed, "
              + "the order may not have settled yet — check it with indexify__orders_list.",
        }
        : {}),
    });
  } catch (err) {
    return fail(`Indexify holdings unavailable (${indexifyFailureDetail("indexify__stack_holdings_get", err)})`);
  }
}

export async function indexifyOrdersHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const orderId = str(p, "orderId").trim();
  const client = getIndexifyClient();

  if (orderId) {
    try {
      const details = await client.orderDetails(orderId, { signal: context.abortSignal });
      const isPartial = details.order.status === "PARTIAL";
      // The partial breakdown is only meaningful — and only offered — on a
      // PARTIAL order; fetching it on every order would double the read.
      let partial: Record<string, unknown> | undefined;
      if (isPartial) {
        try {
          const breakdown = await client.partialDetails(orderId, { signal: context.abortSignal });
          partial = {
            summary: breakdown.summary ?? null,
            availableResolutions: breakdown.available_actions ?? null,
            successfulTokenCount: breakdown.successful_tokens.length,
            failedTokenCount: breakdown.failed_tokens.length,
            failedTokens: breakdown.failed_tokens.slice(0, 12),
          };
        } catch {
          partial = { note: "PARTIAL order, but the breakdown read failed — retry indexify__orders_list with this orderId." };
        }
      }
      return ok({
        order: {
          orderId: details.order.order_id,
          status: details.order.status,
          direction: details.order.type === "fromUSDC" ? "buy" : details.order.type === "toUSDC" ? "sell" : details.order.type,
          createdAt: details.order.created_at,
        },
        transactionCount: details.transaction_count ?? details.transactions.length,
        transactions: details.transactions.slice(0, 20).map((t) => ({
          success: t.success ?? null,
          txnHash: t.txn_hash ?? null,
        })),
        ...(partial !== undefined ? { partial } : {}),
      });
    } catch (err) {
      return fail(`Indexify order read unavailable (${indexifyFailureDetail("indexify__orders_list", err)})`);
    }
  }

  const limitRead = readNumber(p, "limit", PAGE_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const offsetRead = readNumber(p, "offset", PAGE_NUMERIC_PARAMS);
  if (!offsetRead.ok) return fail(offsetRead.reason);
  try {
    const page = await client.listOrders(
      limitRead.value ?? INDEXIFY_HISTORY_LIMIT_DEFAULT,
      offsetRead.value ?? 0,
      { signal: context.abortSignal },
    );
    return ok({
      count: page.orders.length,
      totalCount: page.pagination?.total_count ?? null,
      hasMore: page.pagination?.has_more ?? null,
      orders: page.orders.map((row) => ({
        orderId: row.order_id,
        stackId: row.stack_id ?? null,
        stackName: row.stack_name ?? null,
        direction: row.type === "fromUSDC" ? "buy" : row.type === "toUSDC" ? "sell" : row.type ?? null,
        status: row.status,
        createdAt: row.created_at ?? null,
        pendingPartialResolution: row.partial_completion_action === "pending",
      })),
    });
  } catch (err) {
    return fail(`Indexify orders unavailable (${indexifyFailureDetail("indexify__orders_list", err)})`);
  }
}

export async function indexifyHistoryHandler(
  p: Record<string, unknown>,
  context: ProtocolExecutionContext,
) {
  const limitRead = readNumber(p, "limit", PAGE_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);
  const offsetRead = readNumber(p, "offset", PAGE_NUMERIC_PARAMS);
  if (!offsetRead.ok) return fail(offsetRead.reason);
  const stackIdRead = readNumber(p, "stackId", PAGE_NUMERIC_PARAMS);
  if (!stackIdRead.ok) return fail(stackIdRead.reason);

  const statusRaw = str(p, "status").trim();
  let status: IndexifyOrderStatus | undefined;
  if (statusRaw) {
    const match = INDEXIFY_ORDER_STATUSES.find((candidate) => candidate === statusRaw.toUpperCase());
    if (!match) return fail(`"status" must be one of: ${INDEXIFY_ORDER_STATUSES.join(", ")}.`);
    status = match;
  }

  try {
    const client = getIndexifyClient();
    const offset = offsetRead.value ?? 0;
    const unfilteredFirstPage = offset === 0 && status === undefined && stackIdRead.value === null;
    const [page, summary] = await Promise.all([
      client.history(
        {
          limit: limitRead.value ?? INDEXIFY_HISTORY_LIMIT_DEFAULT,
          offset,
          ...(status !== undefined ? { status } : {}),
          ...(stackIdRead.value !== null ? { stackId: stackIdRead.value } : {}),
        },
        { signal: context.abortSignal },
      ),
      // Summary counts ride along on the first unfiltered page only — they
      // describe the WHOLE account, so repeating them per filtered page would
      // mislead more than inform.
      unfilteredFirstPage
        ? client.historySummary({ signal: context.abortSignal }).catch(() => null)
        : Promise.resolve(null),
    ]);
    return ok({
      count: page.transactions.length,
      totalCount: page.pagination?.total_count ?? null,
      hasMore: page.pagination?.has_more ?? null,
      ...(summary !== null ? { accountSummary: summary.summary } : {}),
      transactions: page.transactions.map((row) => ({
        orderId: row.order_id,
        type: row.transaction_type ?? null,
        status: row.status ?? null,
        stackId: row.stack_id ?? null,
        asset: row.asset?.name ?? null,
        usdcAmount: row.usdc_amount ?? null,
        sellPercent: row.sell_percentage ?? null,
        creatorFeeUsdc: row.creator_fee ?? null,
        platformFeeUsdc: row.platform_fee ?? null,
        createdAt: row.created_at ?? null,
        txnHash: row.transaction_hash ?? null,
      })),
    });
  } catch (err) {
    return fail(`Indexify history unavailable (${indexifyFailureDetail("indexify__history_list", err)})`);
  }
}
