/**
 * Agent Scan — DB-backed read-only views over the agent's own session-wallet
 * history: recent transactions (the primary feed), activity, balances,
 * snapshots, and the protocol execution audit log.
 *
 * Renamed from `portfolio` (Agent Scan plan v3 §1.9/§4.7 — the profit-
 * computation system is deleted; this is plain recorded state, not PnL).
 * Export identifier `PORTFOLIO_TOOLS` is kept for import stability
 * (`registry/lookup.ts`) — only the tool's `name` field changed.
 */

import type { ToolDef } from "../types.js";

export const PORTFOLIO_TOOLS: readonly ToolDef[] = [
  {
    name: "agent_scan", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: [
      "Read-only view over your own session-wallet history, materialized from DB projections — NOT live RPC. The agent owns this surface; do not query third parties for the same data.",
      "View groups (pick one via `view`; see parameters.view.enum for the full set):",
      "- `transactions` (PRIMARY view — start here): one chronological feed of your recorded swaps/bridges/orders — pending, confirmed, AND failed — each with amounts (symbols, not raw units), status, chain, and tx hash for an explorer lookup. Filter by `productType` (spot/perps/prediction/bridge/order/lend), keyset-paginate with `cursor` (pass the prior response's `nextCursor` until `hasMore` is false), or pass `txHash` to look up one transaction. Use this for \"what happened recently\" / \"did my last swap land\" / \"find this txHash\".",
      "- `activity`: trade/bridge/LP-adjacent flow log (broader, lower-detail than `transactions`).",
      "- `balances`, `snapshots`: current aggregate USD balance and point-in-time snapshots over time (snapshot deltas, not trade PnL).",
      "- `summary`: balances-only portfolio overview (total USD, open position count, latest snapshot). No realized/unrealized PnL — compute that yourself from `transactions`' recorded amounts if you need it.",
      "- `executions`: the global protocol-call audit log (every tool execution, not wallet-scoped).",
      "Filters narrow the rows: `namespace` (protocol), `productType` (spot/perps/prediction/bridge/order/lend), `txHash`, `cursor`, `limit`.",
      "Freshness caveat: balances/snapshots reflect the last indexer sync, not on-chain head. For real-time per-token balance (e.g. confirming a swap landed), prefer `wallet_balances` (EVM) or `khalani_tokens_balances`. For instrument prices, use the relevant quote tools in the kyberswap namespace.",
    ].join(" "),
    parameters: { type: "object", properties: {
      view: { type: "string", enum: ["transactions", "activity", "balances", "snapshots", "summary", "executions"], description: "What to inspect (see description for group breakdown)" },
      namespace: { type: "string", description: "Protocol filter (e.g. kyberswap, khalani)" },
      productType: { type: "string", description: "Product filter (e.g. spot, perps, prediction, bridge, order, lend)" },
      cursor: { type: "string", description: "Opaque pagination cursor (transactions) — pass the prior response's nextCursor to fetch the next page" },
      txHash: { type: "string", description: "Transaction hash anchor (transactions) — return rows matching this txHash" },
      limit: { type: "number", description: "Max rows (default 20)" },
    }, required: ["view"] },
  },
];
