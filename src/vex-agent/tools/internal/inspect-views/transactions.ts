/**
 * Agent Scan — transactions view: the unified tx feed (PRIMARY view, Agent
 * Scan plan v3 §1.9/§4.2 output-polish).
 *
 * FUSES `agent_activity` (new-format swap attempts: pending/confirmed/
 * definitively_failed) with legacy successful activity (proj_activity) and
 * legacy FAILED trade-impacting mutation attempts (protocol_executions,
 * THIS session only), filtered by productType, keyset-paginated, with a
 * txHash anchor. The repo (`db/repos/transactions.ts`) owns the SQL + the
 * cursor semantics; this handler decodes the opaque cursor (bounded-fail on
 * garbage), calls the repo, and shapes the bounded result.
 *
 * Output polish (owner: "write it the way you'd want to receive it"): every
 * row gets a compact human `summary` line up front (amounts with symbols,
 * USD labeled as an estimate, status, short tx hash) ahead of the full
 * machine fields. Rows with a resolvable chain+hash also feed `_explorerRefs`
 * (metadata-only, model-invisible — same mechanism `wallet/send` uses for a
 * linkable-but-uncaptured tx ref) so the desktop app can render a real
 * explorer deep link without this module needing its own chain→URL map.
 */

import type { ToolResult } from "../../types.js";
import { ok, fail } from "../types.js";
import type { TransactionRow } from "@vex-agent/db/repos/transactions.js";

export interface InspectTransactionsParams {
  productType?: string;
  namespace?: string;
  txHash?: string;
  cursor?: string;
  limit?: number;
}

/** Bounded set of explorer refs derived from this page's rows — same shape `wallet/send` attaches under `data._explorerRefs`. */
function buildExplorerRefs(items: readonly TransactionRow[]): Array<{ chain: string; txRef: string }> {
  const seen = new Set<string>();
  const refs: Array<{ chain: string; txRef: string }> = [];
  for (const item of items) {
    if (!item.txHash) continue;
    const chain = item.chain ?? (item.chainId != null ? String(item.chainId) : null);
    if (!chain) continue;
    const key = `${chain}:${item.txHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ chain, txRef: item.txHash });
  }
  return refs;
}

function shortHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return hash.length <= 14 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function leg(amount: string | null | undefined, token: string | null | undefined): string | null {
  return amount != null && token != null ? `${amount} ${token}` : null;
}

function usdEstimate(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value) ? `~$${value.toFixed(2)} est.` : null;
}

/** Compact human line for one row — leads the item, full fields follow. */
function summarize(row: TransactionRow): string {
  const hash = shortHash(row.txHash);

  if (row.source === "failure") {
    // Failure rows carry no economics (never produced a fill).
    const label = row.toolId ?? row.namespace;
    return hash ? `${label} failed (tx ${hash})` : `${label} failed — no tx broadcast`;
  }

  const chain = row.chain ?? "unknown chain";
  const venue = row.protocol ?? row.namespace;
  const inLeg = leg(row.inputAmount, row.inputToken);
  const outLeg = leg(row.outputAmount, row.outputToken);
  const route = inLeg && outLeg ? `${inLeg} → ${outLeg}` : (inLeg ?? outLeg ?? venue);
  const status = row.status ?? "confirmed";

  const parts = [`${route} via ${venue} on ${chain} — ${status}`];
  const usd = usdEstimate(row.valueUsd ?? null);
  if (usd) parts.push(usd);
  if (status === "definitively_failed" && row.failureCode) parts.push(`(${row.failureCode})`);
  if (hash) parts.push(`tx ${hash}`);
  return parts.join(" — ");
}

export async function inspectTransactions(
  addresses: string[],
  sessionId: string | null,
  params: InspectTransactionsParams,
): Promise<ToolResult> {
  const { getTransactions } = await import("@vex-agent/db/repos/transactions.js");
  const { decodeCursor, CursorError } = await import("@vex-agent/db/repos/transactions-cursor.js");

  // Decode the opaque cursor at the boundary. Malformed input is rejected with a
  // bounded failure — never crashes the tool, never echoes the raw cursor.
  let cursor = null;
  if (params.cursor !== undefined && params.cursor !== "") {
    try {
      cursor = decodeCursor(params.cursor);
    } catch (err) {
      if (err instanceof CursorError) return fail("Invalid cursor");
      throw err;
    }
  }

  const limit = params.limit ?? 20;

  const { items, nextCursor, hasMore, failuresScope } = await getTransactions({
    addresses,
    sessionId,
    productType: params.productType,
    namespace: params.namespace,
    txHash: params.txHash,
    cursor,
    limit,
  });

  return ok({
    view: "transactions",
    count: items.length,
    failuresScope,
    transactions: items.map((item) => ({ summary: summarize(item), ...item })),
    nextCursor,
    hasMore,
    _explorerRefs: buildExplorerRefs(items),
  });
}
