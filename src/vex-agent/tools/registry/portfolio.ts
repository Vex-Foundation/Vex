/**
 * Agent Scan - DB-backed read-only views over the agent's own session-wallet
 * history: recent transactions (the primary feed), activity, balances,
 * snapshots, and the protocol execution audit log.
 *
 * Renamed from `portfolio` (Agent Scan plan v3 §1.9/§4.7 - the profit-
 * computation system is deleted; this is plain recorded state, not PnL).
 * Export identifier `PORTFOLIO_TOOLS` is kept for import stability
 * (`registry/lookup.ts`) - only the tool's `name` field changed.
 */

import type { ToolDef } from "../types.js";
import { READ_ONLY_NO_VEX_FEE } from "../vex-fee-notes.js";

export const PORTFOLIO_TOOLS: readonly ToolDef[] = [
  {
    name: "AgentScan", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: [
      "Read-only view over your own session-wallet history, from DB projections - NOT live RPC. Do not query third parties for the same data.",
      "View groups (pick one via `view`; the enum has the full set):",
      "- `transactions` (PRIMARY view - start here): one chronological feed of your recorded swaps, bridges and orders - pending, confirmed AND failed - each with amounts in symbols, status, chain and tx hash. Filter by `productType`, paginate with `cursor` (pass the prior `nextCursor` until `hasMore` is false), or pass `txHash` for one row. It is also how you follow a Relay bridge, which BridgeStatus does not read.",
      "- `activity`: trade/bridge/LP-adjacent flow log, broader and lower-detail than `transactions`. `executions`: the global protocol-call audit log, not wallet-scoped.",
      "- `balances`, `snapshots`: aggregate USD balance now and point-in-time snapshots (snapshot deltas, not trade PnL). `summary` adds open position count and the latest snapshot. No PnL anywhere.",
      "- `mission_baseline` (in-app missions only; ABSENT over MCP, where it answers status 'absent'): what the mission wallets were worth at the start of the run against now.",
            "Use this when the user asks what you have already done, before re-deriving it from a transcript that does not survive compaction. For what the wallet holds RIGHT NOW use `WalletBalances`: this is recorded history, and its balances follow the last indexer sync, not on-chain head.",
      "RETURNS `view`, `count` and the rows under a per-view key, plus the fields named in the result. `transactions` is the ONLY paginated view (`nextCursor`, `hasMore`); `activity` and `executions` apply `limit` silently, with no hasMore and no omission counter, so a short list there is not evidence there is no more.",
      "VEX FEE: every `transactions` row carries what Vex charged - the exact amount in the input token, its raw pair and a nullable USD estimate. A row with an amount but no USD estimate WAS charged; a row with no fee figures is a failed attempt (never charged) or a non-fee-bearing action.",
      "Full contract: vex_ToolDescribe.",
    ].join(" "),
    // The per-view field list this description used to carry inline, moved here
    // whole when the text had to fit the client's 2048-character cut.
    returns:
      "RETURNS `view` and `count` on every view, with the rows under a per-view key: `transactions` "
      + "(each row a readable summary line plus its full recorded fields), `activities`, `snapshots` "
      + "or `executions`. `transactions` is the ONLY paginated view: it returns `nextCursor` and "
      + "`hasMore`, and you pass the cursor back rather than computing one. `activity` and "
      + "`executions` apply `limit` silently, with no hasMore and no omission counter, so a short "
      + "list there is not evidence there is no more. `summary` returns totalBalanceUsd, "
      + "openPositionCount and latestSnapshot; `balances` returns totalUsd; `mission_baseline` "
      + "returns the run's start and now valuations, changeSinceStartUsdEstimate and deployedCapital, "
      + "or status 'absent' with a reason when the baseline was never recorded.",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: { type: "object", properties: {
      view: { type: "string", enum: ["transactions", "activity", "balances", "snapshots", "summary", "executions", "mission_baseline"], description: "What to inspect (see description for group breakdown)" },
      namespace: { type: "string", description: "Protocol filter (e.g. kyberswap, khalani)" },
      productType: { type: "string", description: "Product filter (e.g. spot, perps, prediction, bridge, order, lend)" },
      cursor: { type: "string", description: "Opaque pagination cursor (transactions) - pass the prior response's nextCursor to fetch the next page" },
      txHash: { type: "string", description: "Transaction hash anchor (transactions) - return rows matching this txHash" },
      limit: { type: "number", description: "Max rows (default 20)" },
    }, required: ["view"] },
  },
];
