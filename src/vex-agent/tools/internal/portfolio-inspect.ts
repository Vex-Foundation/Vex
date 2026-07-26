/**
 * Agent Scan — DB-backed read-only self-inspection tool (renamed from
 * `portfolio`, Agent Scan plan v3 §1.9/§4.7 — the profit-computation system
 * is deleted; views shrink to plain recorded session-wallet history).
 *
 * Views: transactions (primary), activity, balances, snapshots, summary,
 * executions.
 *
 * View implementations in inspect-views/*.ts — this file is the router only.
 */

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { str, num, fail } from "./types.js";
import { resolveSelectedAddressSetForRead, walletScopeErrorToResult } from "./wallet/resolve.js";

// Activity view
import { inspectActivity } from "./inspect-views/activity.js";
import { inspectTransactions } from "./inspect-views/transactions.js";
// Portfolio views
import { inspectSummary, inspectBalances, inspectSnapshots, inspectExecutions } from "./inspect-views/portfolio.js";

const VALID_VIEWS = new Set<string>([
  "transactions", "activity", "balances", "snapshots", "summary", "executions",
]);

/**
 * Views scoped to the session's selected wallet set (puzzle 5 phase 5E-2).
 * Only `executions` (a global protocol audit log with no wallet_address) stays
 * unscoped.
 */
const WALLET_SCOPED_VIEWS = new Set<string>([
  "summary", "balances", "snapshots", "activity", "transactions",
]);

export async function handleAgentScan(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const view = str(params, "view");
  if (!view || !VALID_VIEWS.has(view)) {
    return fail(`Invalid view "${view}". Must be one of: ${[...VALID_VIEWS].join(", ")}`);
  }

  const namespace = str(params, "namespace") || undefined;
  const productType = str(params, "productType") || undefined;
  const limit = num(params, "limit") ?? 20;

  if (WALLET_SCOPED_VIEWS.has(view)) {
    // Resolve the session's selected wallet set (read scope). Fails closed on
    // active-run contract drift / address drift / removed wallet; mission SETUP
    // (no active run) is allowed to read its own selected wallet. A valid
    // session with a family unselected yields a smaller set; empty → empty rows.
    let addresses: string[];
    try {
      addresses = resolveSelectedAddressSetForRead(context.walletResolution, context.walletPolicy).all;
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    switch (view) {
      case "summary": return inspectSummary(addresses);
      case "balances": return inspectBalances(addresses);
      case "snapshots": return inspectSnapshots(addresses);
      case "activity": return inspectActivity(addresses, namespace, productType, limit);
      case "transactions": return inspectTransactions(addresses, context.sessionId, {
        productType,
        namespace,
        txHash: str(params, "txHash") || undefined,
        cursor: str(params, "cursor") || undefined,
        limit,
      });
      default: return fail(`Unknown view: ${view}`);
    }
  }

  // `executions` is a global protocol audit log (no wallet_address) — unscoped.
  switch (view) {
    case "executions": return inspectExecutions(namespace, limit);
    default: return fail(`Unknown view: ${view}`);
  }
}
