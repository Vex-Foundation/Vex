/**
 * Indexify account manifests — auth-gated reads over the LINKED INDEXIFY
 * ACCOUNT (a custodial venue account, not a Vex session wallet).
 *
 * Every tool here requires INDEXIFY_API_KEY: without it they are hidden from
 * discovery and refused at execute, which is the requiresEnv contract.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { INDEXIFY_ACCOUNT_DISCOVERY } from "../../embeddings/indexify/account.js";
import {
  INDEXIFY_API_KEY_ENV,
  INDEXIFY_HISTORY_LIMIT_CAP,
  INDEXIFY_HISTORY_LIMIT_DEFAULT,
  INDEXIFY_ORDER_STATUSES,
} from "@tools/indexify/constants.js";

export const INDEXIFY_ACCOUNT_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "indexify.portfolio",
    publicName: "indexify__portfolio_get",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "Read the linked Indexify account's balances. Use this before sizing a stack buy (the venue trades only the account's deposited USDC, never a Vex session wallet) or when the user asks what the Indexify account holds. Returns spendable USDC, USDC reserved by in-flight orders, total portfolio value in USDC, and the account's Indexify-embedded Solana wallet address — which is also the USDC deposit address. Per-token balances are not available from the venue; per-stack positions are read with indexify__stack_holdings_get instead. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    discovery: INDEXIFY_ACCOUNT_DISCOVERY["indexify.portfolio"],
  },
  {
    toolId: "indexify.holdings",
    publicName: "indexify__stack_holdings_get",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "Read the linked Indexify account's position inside ONE stack. Use this after a trade settles to confirm the position, or when the user asks how a stack investment is doing. Returns the position's current value in USDC, total invested, cost basis, per-token amounts where the venue reports them, and the PnL block: realized, unrealized, and total profit/loss with percentages. A stack the account never bought returns zeros, not an error, so a zero row after a buy means the order has not settled yet — check it with indexify__orders_list. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "stackId",
        type: "number",
        required: true,
        description:
          "The stack's own numeric id, as discovery, search, and order rows carry it. One stack per call.",
      },
    ],
    exampleParams: { stackId: 4139 },
    discovery: INDEXIFY_ACCOUNT_DISCOVERY["indexify.holdings"],
  },
  {
    toolId: "indexify.orders",
    publicName: "indexify__orders_list",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "List the linked Indexify account's stack orders, or read one order in full. Use this after indexify__stack_trade_execute to confirm settlement — every Indexify trade becomes an order (PENDING → SUCCESS, FAILED, or PARTIAL) that settles asynchronously on the venue's side. Without orderId, returns recent orders with id, stack, direction, status, and timestamps. With orderId, returns that order's detail: status, per-transaction Solana hashes, and — when the order is PARTIAL — the breakdown of which tokens filled, which failed, and which resolutions (acknowledge, retry, sell_all) the venue currently offers for indexify__order_resolve. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "orderId",
        type: "string",
        description:
          "One order's own id, as trade replies and order rows carry it. Switches the read from the list to that order's full detail.",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Maximum order rows returned when listing, 1-${INDEXIFY_HISTORY_LIMIT_CAP}. Defaults to ${INDEXIFY_HISTORY_LIMIT_DEFAULT}. Ignored when orderId is given.`,
      },
      {
        key: "offset",
        type: "number",
        description:
          "Order-list row offset for paging, 0-based. Ignored when orderId is given; pairs with limit otherwise.",
      },
    ],
    exampleParams: {},
    discovery: INDEXIFY_ACCOUNT_DISCOVERY["indexify.orders"],
  },
  {
    toolId: "indexify.history",
    publicName: "indexify__history_list",
    namespace: "indexify",
    lifecycle: "active",
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "Read the linked Indexify account's transaction history — the venue's durable record of everything the account did. Use this when the user asks what the account has traded, deposited, or withdrawn, or to audit past activity with fees. Returns rows with order id, type (buy/sell/deposit/withdrawal), status, USDC amount or sell percentage, creator and platform fees, timestamps, the asset traded, and the Solana transaction hash where one exists; the first unfiltered page also returns summary counts by type and outcome. Filter by lifecycle status or by one stack. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "status",
        type: "string",
        enum: [...INDEXIFY_ORDER_STATUSES],
        description:
          "Keep only rows in one lifecycle status: PENDING, PROCESSING, SUCCESS, FAILED, or PARTIAL. Omit for all statuses.",
      },
      {
        key: "stackId",
        type: "number",
        description:
          "Keep only rows that traded this stack, by its numeric id. Omit to cover the whole account history.",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Maximum history rows returned, 1-${INDEXIFY_HISTORY_LIMIT_CAP}. Defaults to ${INDEXIFY_HISTORY_LIMIT_DEFAULT}.`,
      },
      {
        key: "offset",
        type: "number",
        description:
          "History row offset for paging, 0-based. Pass the previous offset plus returned row count for the next page.",
      },
    ],
    exampleParams: {},
    discovery: INDEXIFY_ACCOUNT_DISCOVERY["indexify.history"],
  },
];
