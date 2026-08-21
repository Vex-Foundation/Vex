/**
 * Agent Scan — portfolio views: summary, balances, snapshots, executions.
 * Aggregate balance state and protocol-execution audit (Agent Scan plan v3
 * §1.9/§4.7 — the profit-computation system is deleted; `summary` is
 * balances-only, no realized/unrealized PnL).
 */

import type { ToolResult } from "../../types.js";
import { ok } from "../types.js";

// All portfolio reads are scoped to the session's selected wallet set
// (puzzle 5 phase 5E-2). An empty set yields zeroes/[] (never global) because
// every filter is `wallet_address = ANY($::text[])` and `ANY('{}')` matches
// nothing. Default-resolution callers pass the primary set, preserving prior behaviour.
export async function inspectSummary(addresses: string[]): Promise<ToolResult> {
  const { getTotalUsd, getLatestAggregateSnapshot } = await import("@vex-agent/db/repos/balances.js");
  const { getOpen } = await import("@vex-agent/db/repos/open-positions.js");

  const totalUsd = await getTotalUsd(addresses);
  const openPositions = await getOpen(addresses);
  const latestSnapshot = await getLatestAggregateSnapshot(addresses);

  return ok({
    view: "summary",
    totalBalanceUsd: totalUsd,
    openPositionCount: openPositions.length,
    latestSnapshot: latestSnapshot ? {
      totalUsd: latestSnapshot.totalUsd,
      pnlVsPrev: latestSnapshot.pnlVsPrev,
      activeChains: latestSnapshot.activeChains,
      at: latestSnapshot.at,
    } : null,
    note: "Scoped to this session's selected wallet(s). Balances only — trade history, amounts, and explorer refs live in `transactions`; compute PnL yourself from those recorded numbers if you need it.",
  });
}

export async function inspectBalances(addresses: string[]): Promise<ToolResult> {
  const { getTotalUsd } = await import("@vex-agent/db/repos/balances.js");
  const totalUsd = await getTotalUsd(addresses);

  return ok({
    view: "balances",
    totalUsd,
    note: "Use WalletBalances for fresh per-token live balances. This shows the selected wallet(s)' aggregate USD total from DB projections.",
  });
}

export async function inspectSnapshots(addresses: string[]): Promise<ToolResult> {
  const { getAggregateSnapshots } = await import("@vex-agent/db/repos/balances.js");
  // Aggregated per full-sync cycle across the selected wallet set (complete
  // cycles only — partial syncs excluded).
  const snapshots = await getAggregateSnapshots(addresses, "7d");

  return ok({
    view: "snapshots",
    count: snapshots.length,
    snapshots: snapshots.map(s => ({
      totalUsd: s.totalUsd,
      pnlVsPrev: s.pnlVsPrev,
      pnlPctVsPrev: s.pnlPctVsPrev,
      activeChains: s.activeChains,
      createdAt: s.at,
    })),
  });
}

export async function inspectExecutions(namespace?: string, limit = 20): Promise<ToolResult> {
  const { getByNamespace } = await import("@vex-agent/db/repos/executions.js");
  if (!namespace) {
    const { query } = await import("@vex-agent/db/client.js");
    const rows = await query<Record<string, unknown>>(
      "SELECT id, tool_id, namespace, success, external_refs, duration_ms, created_at FROM protocol_executions ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return ok({
      view: "executions",
      count: rows.length,
      executions: rows.map(e => ({
        id: e.id,
        toolId: e.tool_id,
        namespace: e.namespace,
        success: e.success,
        externalRefs: e.external_refs,
        durationMs: e.duration_ms,
        createdAt: e.created_at,
      })),
    });
  }
  const executions = await getByNamespace(namespace, limit);

  return ok({
    view: "executions",
    count: executions.length,
    executions: executions.map(e => ({
      toolId: e.toolId,
      success: e.success,
      externalRefs: e.externalRefs,
      durationMs: e.durationMs,
      createdAt: e.createdAt,
    })),
  });
}
