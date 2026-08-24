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
    name: "AgentScan", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: [
      "Read-only view over your own session-wallet history, materialized from DB projections — NOT live RPC. The agent owns this surface; do not query third parties for the same data.",
      "View groups (pick one via `view`; see parameters.view.enum for the full set):",
      "- `transactions` (PRIMARY view — start here): one chronological feed of your recorded swaps/bridges/orders — pending, confirmed, AND failed — each with amounts (symbols, not raw units), status, chain, and tx hash for an explorer lookup. Filter by `productType` (spot/perps/prediction/bridge/order/lend), keyset-paginate with `cursor` (pass the prior response's `nextCursor` until `hasMore` is false), or pass `txHash` to look up one transaction. Use this for \"what happened recently\" / \"did my last swap land\" / \"find this txHash\".",
      "- `activity`: trade/bridge/LP-adjacent flow log (broader, lower-detail than `transactions`).",
      "- `balances`, `snapshots`: current aggregate USD balance and point-in-time snapshots over time (snapshot deltas, not trade PnL).",
      "- `summary`: balances-only portfolio overview (total USD, open position count, latest snapshot). No realized/unrealized PnL — compute that yourself from `transactions`' recorded amounts if you need it.",
      "- `mission_baseline` (mission runs only): what the mission wallets were worth when this run started, what they are worth now, the change between them, and the mission's declared deployed capital. Frozen start, same projection source for both sides, USD figures are estimates. Use it instead of recomputing from the transcript.",
      "- `executions`: the global protocol-call audit log (every tool execution, not wallet-scoped).",
      "Use this when the user asks what you have already done - did a swap land, what happened recently, what a run has cost, what the mission was worth at the start - and before re-deriving any of that from the transcript, which does not survive compaction. For what the wallet holds RIGHT NOW use `WalletBalances`; this surface is recorded history.",
      "Filters narrow the rows: `namespace` (protocol), `productType` (spot/perps/prediction/bridge/order/lend), `txHash`, `cursor`, `limit`.",
      "RETURNS `view` and `count` on every view, with the rows under a per-view key: `transactions` (each row a readable summary line plus its full recorded fields), `activities`, `snapshots` or `executions`. `transactions` is the ONLY paginated view: it returns `nextCursor` and `hasMore`, and you pass the cursor back rather than computing one. `activity` and `executions` apply `limit` silently, with no hasMore and no omission counter, so a short list there is not evidence there is no more. `summary` returns totalBalanceUsd, openPositionCount and latestSnapshot; `balances` returns totalUsd; `mission_baseline` returns the run's start and now valuations, changeSinceStartUsdEstimate and deployedCapital, or status 'absent' with a reason when the baseline was never recorded.",
      "Vex fee: every `transactions` row carries what Vex charged for that action — `vexFeeAmountHuman` + `vexFeeTokenSymbol` (exact, in the input token), `vexFeeAmountRaw` + `vexFeeTokenDecimals` (atomic units), and `usdVexFeeEst` (a nullable USD ESTIMATE). This is the source of truth for \"what did that cost me?\". A row with a fee amount but a null `usdVexFeeEst` WAS charged — no trustworthy USD price existed; a row with no fee figures at all is a failed attempt (never charged) or a non-fee-bearing action.",
      "Freshness caveat: balances/snapshots reflect the last indexer sync, not on-chain head. For real-time per-token balance (e.g. confirming a swap landed), prefer `WalletBalances`. For instrument prices, use the relevant quote tools in the kyberswap namespace.",
    ].join(" "),
    parameters: { type: "object", properties: {
      view: { type: "string", enum: ["transactions", "activity", "balances", "snapshots", "summary", "executions", "mission_baseline"], description: "What to inspect (see description for group breakdown)" },
      namespace: { type: "string", description: "Protocol filter (e.g. kyberswap, khalani)" },
      productType: { type: "string", description: "Product filter (e.g. spot, perps, prediction, bridge, order, lend)" },
      cursor: { type: "string", description: "Opaque pagination cursor (transactions) — pass the prior response's nextCursor to fetch the next page" },
      txHash: { type: "string", description: "Transaction hash anchor (transactions) — return rows matching this txHash" },
      limit: { type: "number", description: "Max rows (default 20)" },
    }, required: ["view"] },
  },
];
