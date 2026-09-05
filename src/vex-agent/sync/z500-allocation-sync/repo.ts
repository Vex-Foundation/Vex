/**
 * Z500 run ledger repo — the claim, the record, the terminal write.
 *
 * The concurrency story lives in TWO statements and nowhere else:
 *
 *   CLAIM     INSERT .. ON CONFLICT (window_id) DO NOTHING RETURNING id —
 *             a returned row IS ownership; no row means someone else owns or
 *             owned the window (running, succeeded, or failed — all block).
 *   TAKEOVER  UPDATE .. WHERE window_id = $1 AND status = 'running' AND
 *             started_at < cutoff RETURNING .. — reclaims only a run whose
 *             worker is presumed dead, atomically, and hands back the
 *             persisted record so the new owner can RECONCILE (repo callers
 *             never re-evaluate a taken-over window; see runner.ts).
 *
 * `record` is merged (`record || $patch`) rather than replaced, so partial
 * progress persisted before a crash (crucially `desiredAllocation` and
 * `mutationRequested`) survives for the takeover path to read.
 */

import { query, queryOne, execute } from "@vex-agent/db/client.js";
import { jsonb } from "@vex-agent/db/params.js";
import { Z500_STALE_RUNNING_TAKEOVER_MS } from "./config.js";

export type Z500RunOutcome =
  | "allocation_updated"
  | "no_change_needed"
  | "reconciled_already_applied"
  | "source_unavailable"
  | "source_stale"
  | "source_invalid"
  | "insufficient_eligible_tokens"
  | "indexify_unavailable"
  | "mutation_rejected"
  | "mutation_unresolved"
  | "takeover_unresolved"
  | "internal_error";

export type ClaimResult =
  | { readonly kind: "claimed"; readonly runId: number }
  | { readonly kind: "takeover"; readonly runId: number; readonly record: Record<string, unknown> }
  | { readonly kind: "owned" }      // live run elsewhere — do nothing
  | { readonly kind: "complete" };  // terminal run exists — window done forever

export interface Z500RunRow {
  readonly id: number;
  readonly windowId: string;
  readonly triggerType: string;
  readonly status: string;
  readonly outcome: string | null;
  readonly record: Record<string, unknown>;
  readonly error: string | null;
  readonly takeoverCount: number;
}

export interface Z500RunRepo {
  claimWindow(windowId: string, scheduledAt: Date, triggerType: "scheduled" | "catch-up"): Promise<ClaimResult>;
  mergeRecord(runId: number, patch: Record<string, unknown>): Promise<void>;
  complete(runId: number, status: "succeeded" | "failed", outcome: Z500RunOutcome, error?: string | null): Promise<void>;
  getRun(windowId: string): Promise<Z500RunRow | null>;
}

async function claimWindow(
  windowId: string,
  scheduledAt: Date,
  triggerType: "scheduled" | "catch-up",
): Promise<ClaimResult> {
  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO z500_sync_runs (window_id, scheduled_at, trigger_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (window_id) DO NOTHING
     RETURNING id`,
    [windowId, scheduledAt.toISOString(), triggerType],
  );
  if (inserted) return { kind: "claimed", runId: inserted.id };

  // Someone owns or owned the window. A stale `running` row is reclaimed
  // atomically; the WHERE clause makes two concurrent takeovers impossible.
  const takeover = await queryOne<{ id: number; record: Record<string, unknown> }>(
    `UPDATE z500_sync_runs
     SET takeover_count = takeover_count + 1, started_at = NOW()
     WHERE window_id = $1
       AND status = 'running'
       AND started_at < NOW() - make_interval(secs => $2)
     RETURNING id, record`,
    [windowId, Z500_STALE_RUNNING_TAKEOVER_MS / 1000],
  );
  if (takeover) return { kind: "takeover", runId: takeover.id, record: takeover.record ?? {} };

  const existing = await queryOne<{ status: string }>(
    "SELECT status FROM z500_sync_runs WHERE window_id = $1",
    [windowId],
  );
  return existing?.status === "running" ? { kind: "owned" } : { kind: "complete" };
}

async function mergeRecord(runId: number, patch: Record<string, unknown>): Promise<void> {
  await execute(
    "UPDATE z500_sync_runs SET record = record || $2::jsonb WHERE id = $1",
    [runId, jsonb(patch)],
  );
}

async function complete(
  runId: number,
  status: "succeeded" | "failed",
  outcome: Z500RunOutcome,
  error: string | null = null,
): Promise<void> {
  await execute(
    `UPDATE z500_sync_runs
     SET status = $2, outcome = $3, error = $4, completed_at = NOW()
     WHERE id = $1`,
    [runId, status, outcome, error],
  );
}

async function getRun(windowId: string): Promise<Z500RunRow | null> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM z500_sync_runs WHERE window_id = $1",
    [windowId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    windowId: String(row.window_id),
    triggerType: String(row.trigger_type),
    status: String(row.status),
    outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
    record: (row.record ?? {}) as Record<string, unknown>,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    takeoverCount: Number(row.takeover_count ?? 0),
  };
}

export function buildProductionRunRepo(): Z500RunRepo {
  return { claimWindow, mergeRecord, complete, getRun };
}
