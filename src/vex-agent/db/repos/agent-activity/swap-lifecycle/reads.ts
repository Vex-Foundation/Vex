/**
 * `agent_activity` READ queries — the row lookup, the two repair-sweep
 * candidate sets, the Agent Scan feed page, and the execution-existence probe.
 *
 * Extracted from the sibling `../swap-lifecycle.ts`, which kept its name and its
 * public exports — every caller's import is unchanged, and this module is
 * reached through the `../../agent-activity.ts` facade exactly as before.
 * Different reason to change: this file changes when a candidate set's fairness
 * ordering, a filter, or a pagination shape changes; `swap-lifecycle.ts` changes
 * when the CAS state transitions do.
 */

import { queryOne, query } from "../../../client.js";
import { mapRow } from "../mappers.js";
import type { AgentActivityEvent, BridgeChainFamily } from "../types.js";

export async function getActivityEventById(id: number): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent_activity WHERE id = $1",
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * Repair-sweep candidate set: `pending` rows whose signed submit was
 * attempted more than `olderThanMs` ago, LEAST-RECENTLY-CHECKED first, capped
 * at `limit` rows (FIX-SPINE C11 — finding 12: the repair sweep must never
 * starve balance/Jupiter sync by loading an unbounded backlog). A row with no
 * `submit_attempted_at` yet (crash before step 2) is not a candidate — there
 * is no hash to check.
 *
 * FAIRNESS (2026-07-30, the 30s status-only cadence): ordering by
 * `COALESCE(last_checked_at, submit_attempted_at)` — never by
 * `submit_attempted_at` alone — is what makes the LIMIT window ROTATE over a
 * backlog. `touchLastChecked` moves a just-checked row to the back, so a
 * backlog larger than `limit` drains instead of the same oldest rows being
 * re-served every 30 seconds forever. `id ASC` is a deterministic tiebreak.
 *
 * `chainFamily` is REQUIRED (W5 design REVISION 1 R3 — Codex's
 * non-disjointness finding at this file's prior state): the caller must name
 * which sweep it is, so the EVM repair sweep (`'eip155'`) and the Solana
 * activity sweep (`solana-activity-repair.ts`'s own
 * `listSolanaStagedPending`, a disjoint candidate shape — see below) can
 * never both claim the same row.
 */
export async function listPendingOlderThan(
  olderThanMs: number,
  limit: number,
  chainFamily: BridgeChainFamily,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE status = 'pending'
        AND submit_attempted_at IS NOT NULL
        AND submit_attempted_at < NOW() - make_interval(secs => $1::float8)
        AND chain_family = $3
      ORDER BY COALESCE(last_checked_at, submit_attempted_at) ASC, id ASC
      LIMIT $2`,
    [olderThanMs / 1000, limit, chainFamily],
  );
  return rows.map(mapRow);
}

/**
 * Solana activity-sweep candidate set (design `w5-design.md` §4/R3): every
 * LOCALLY-STAGED (`tx_hash IS NOT NULL`) `pending` Solana row, oldest-checked
 * first — `COALESCE(last_checked_at, submit_attempted_at)` so a
 * never-yet-checked row is served before a recently re-checked one (mirrors
 * the bridge sweep's fairness clock). Deliberately UNFILTERED by `kind`: R3
 * corrects §4 to include Solana `bridge_deposit` legs too (the bridge sweep
 * owns ONLY the logical `bridge_fill_expected` row, whose
 * `submit_attempted_at` is always NULL and is therefore never a candidate
 * here) — swap/lend/prediction/bridge-deposit rows share ONE disjoint
 * candidate set by `chain_family` alone. The caller
 * (`solana-activity-repair.ts`) applies its own per-row due gate — a FLAT 30s
 * interval since the sweeps became status-only (owner decree 2026-07-30); the
 * old escalating 60s→5m→30m→2h backoff is gone, because a status-only check is
 * one entry in a batched `getSignatureStatuses` call and costs almost nothing to
 * repeat. This query only bounds + orders the batch.
 */
export async function listSolanaStagedPending(limit: number): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE status = 'pending'
        AND chain_family = 'solana'
        AND tx_hash IS NOT NULL
        AND submit_attempted_at IS NOT NULL
      ORDER BY COALESCE(last_checked_at, submit_attempted_at) ASC, id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

export interface ListActivityFeedOptions {
  walletAddresses: string[];
  before?: { createdAt: string; id: number };
  limit: number;
}

/** Keyset-paginated (created_at DESC, id DESC) feed for a wallet set — the Agent Scan read surface. */
export async function listActivityFeed(
  options: ListActivityFeedOptions,
): Promise<AgentActivityEvent[]> {
  if (options.walletAddresses.length === 0) return [];
  const params: unknown[] = [options.walletAddresses, options.limit];
  let cursorClause = "";
  if (options.before) {
    params.push(options.before.createdAt, options.before.id);
    cursorClause = `AND (created_at < $3::timestamptz OR (created_at = $3::timestamptz AND id < $4::bigint))`;
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE wallet_address = ANY($1::text[]) ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  return rows.map(mapRow);
}

/**
 * True iff at least one `agent_activity` row exists for this
 * `protocol_execution_id` — used by the compatibility feed (transactions.ts)
 * to exclude a legacy-failure-half row already represented here (FIX-SPINE
 * C9 — findings 1/2).
 */
export async function existsForExecutionId(protocolExecutionId: number): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM agent_activity WHERE protocol_execution_id = $1) AS exists",
    [protocolExecutionId],
  );
  return row?.exists === true;
}

