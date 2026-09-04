/**
 * Publishing ONE portfolio snapshot group inside ONE short transaction.
 *
 * The accounting rules live in `./publication-gate.ts`. This module owns the
 * SEQUENCE, which is load-bearing and fixed:
 *
 *   1. every snapshot DTO is prepared by the CALLER, before `BEGIN`. Gathering
 *      and validation are minutes of scanning; none of it happens while the
 *      activity table is locked.
 *   2. `SET LOCAL lock_timeout` - a bounded wait. We would rather skip a
 *      snapshot than park a pool client behind a long-running writer.
 *   3. `LOCK TABLE agent_activity IN SHARE MODE` - from here no activity row
 *      can be written until we commit, which is what makes step 4 a boundary
 *      rather than a stale reading.
 *   4. the in-flight ledger + the transition fence, under the lock.
 *   5. the per-wallet rows AND the group record, still under the lock.
 *   6. COMMIT.
 *
 * ## In-flight money is ACCOUNTED FOR, never a reason to withhold
 *
 * The ledger read in step 4 no longer decides whether to publish; it decides
 * what the group SAYS. Only three things still withhold a group, and none of
 * them is money in flight:
 *
 *   `activity_transition`  the group would mix reads from opposite sides of a
 *                          settlement that happened during the scan;
 *   `lock_unavailable`     the boundary could not be established;
 *   `gate_probe_failed`    the ledger or the fence could not be evaluated -
 *                          unknown stays fail-closed;
 *   `publish_failed`       the insert itself failed. A defect, not a busy path.
 *
 * ## Nothing here may fail the balance refresh
 *
 * Balances are written per wallet-chain long before this runs and stay fresh
 * regardless. A snapshot that cannot be taken safely is a SKIP with a named
 * reason, never a thrown error that aborts the cycle - including a lock
 * timeout, a deadlock, and a gate probe that could not run.
 *
 * ## Whole group or none
 *
 * Every row - the per-wallet snapshots AND the group record that carries the
 * in-flight ledger - is inserted on the transaction's own client, so a failure
 * at wallet three rolls back wallets one and two and the group record with
 * them. A half-populated `snapshotGroupId` would break the aggregate stitch AND
 * `pnl_vs_prev`; a group record without its rows (or rows without their record)
 * would make the published total unreadable.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import { insertSnapshot } from "@vex-agent/db/repos/balances.js";
import { describeFailureForLog } from "@utils/error-summary.js";
import logger from "@utils/logger.js";
import {
  fencesMatch,
  readActivityFence,
  readInFlightMoney,
  type ActivityFence,
  type InFlightEntry,
} from "./publication-gate.js";

/**
 * How long the publisher waits for the activity table lock. Small on purpose:
 * holding a pool client behind a busy writer buys nothing, and the next cycle
 * is minutes away.
 */
export const PUBLICATION_LOCK_TIMEOUT_MS = 2_000;

/** Postgres SQLSTATEs that mean "the lock is not available", not "we are broken". */
const LOCK_NOT_AVAILABLE = "55P03";
const DEADLOCK_DETECTED = "40P01";

/** One wallet's fully-prepared snapshot, built BEFORE the transaction opens. */
export interface SnapshotDraft {
  readonly walletFamily: string;
  readonly walletAddress: string;
  readonly totalUsd: number;
  readonly positions: Record<string, unknown>;
  readonly activeChains: readonly string[];
}

export interface PublishedSnapshot {
  readonly walletFamily: string;
  readonly walletAddress: string;
  readonly snapshotId: number;
  readonly totalUsd: number;
  readonly pnlVsPrev: number | null;
}

/**
 * The group's own record: what was measured, what is on its way, and what
 * nobody could account for. Persisted to `proj_portfolio_snapshot_groups`
 * (migration 101) in the same transaction as the per-wallet rows.
 */
export interface SnapshotGroupLedger {
  /** Sum of the per-wallet `total_usd` rows: balances actually read. */
  readonly settledUsd: number;
  /** Sum of the `usdEstimate`s of the `in_transit` entries. Estimates only. */
  readonly inTransitUsd: number;
  /** `unresolved` entries. Listed, counted, and in NO total. */
  readonly unresolvedCount: number;
  readonly entries: readonly InFlightEntry[];
  /** The ledger hit its bound and the oldest entries were kept. */
  readonly truncated: boolean;
}

export type PublicationSkipReason =
  /** A transaction began and settled during the scan - the group would mix reads. */
  | "activity_transition"
  /** The activity table lock could not be taken within the bounded wait. */
  | "lock_unavailable"
  /** The gate itself could not be evaluated. Unknown means blocked. */
  | "gate_probe_failed"
  /** The insert failed. Zero rows from this group exist. A defect, not a busy path. */
  | "publish_failed";

export type PublicationOutcome =
  | {
      readonly published: true;
      readonly rows: readonly PublishedSnapshot[];
      readonly ledger: SnapshotGroupLedger;
    }
  | { readonly published: false; readonly reason: PublicationSkipReason };

export interface PublishSnapshotGroupInput {
  readonly snapshotGroupId: string;
  readonly walletAddresses: readonly string[];
  /** The activity generation stamped BEFORE the scan started. */
  readonly fenceAtCycleStart: ActivityFence;
  readonly drafts: readonly SnapshotDraft[];
  readonly lockTimeoutMs?: number;
}

const INSERT_GROUP_SQL = `
  INSERT INTO proj_portfolio_snapshot_groups
    (snapshot_group_id, settled_usd, in_transit_usd, unresolved_count, in_flight)
  VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`;

export async function publishSnapshotGroup(
  input: PublishSnapshotGroupInput,
): Promise<PublicationOutcome> {
  const lockTimeoutMs = boundedLockTimeout(input.lockTimeoutMs);
  try {
    return await withTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      await client.query("LOCK TABLE agent_activity IN SHARE MODE");

      // Read for the RECORD, not for a veto: what is in flight is part of the
      // measurement this group publishes.
      const inFlight = await readInFlightMoney(client, input.walletAddresses);

      const fenceNow = await readActivityFence(client, input.walletAddresses);
      if (!fencesMatch(input.fenceAtCycleStart, fenceNow)) {
        return skip("activity_transition");
      }

      const rows: PublishedSnapshot[] = [];
      for (const draft of input.drafts) {
        const { snapshotId, pnlVsPrev } = await insertSnapshot(
          {
            walletFamily: draft.walletFamily,
            walletAddress: draft.walletAddress,
            snapshotGroupId: input.snapshotGroupId,
            totalUsd: draft.totalUsd,
            positions: draft.positions,
            activeChains: [...draft.activeChains],
          },
          client,
        );
        rows.push({
          walletFamily: draft.walletFamily,
          walletAddress: draft.walletAddress,
          snapshotId,
          totalUsd: draft.totalUsd,
          pnlVsPrev,
        });
      }

      const ledger = summarizeLedger(rows, inFlight.entries, inFlight.truncated);
      await client.query(INSERT_GROUP_SQL, [
        input.snapshotGroupId,
        ledger.settledUsd,
        ledger.inTransitUsd,
        ledger.unresolvedCount,
        JSON.stringify(ledger.entries),
      ]);

      return { published: true as const, rows, ledger };
    });
  } catch (err) {
    return skipOnError(err, input.snapshotGroupId);
  }
}

/**
 * `settledUsd` is the sum of what was actually inserted, not of what was
 * offered, so the record can never claim a wallet the group does not contain.
 *
 * `inTransitUsd` sums ONLY `in_transit` entries with a known estimate. An
 * `unresolved` entry contributes nothing in either direction - it is money
 * nobody can currently account for, and a portfolio must not assert it is
 * there or that it is gone.
 */
function summarizeLedger(
  rows: readonly PublishedSnapshot[],
  entries: readonly InFlightEntry[],
  truncated: boolean,
): SnapshotGroupLedger {
  let settledUsd = 0;
  for (const row of rows) settledUsd += row.totalUsd;

  let inTransitUsd = 0;
  let unresolvedCount = 0;
  for (const entry of entries) {
    if (entry.standing === "unresolved") {
      unresolvedCount += 1;
      continue;
    }
    if (entry.usdEstimate !== null) inTransitUsd += entry.usdEstimate;
  }
  return { settledUsd, inTransitUsd, unresolvedCount, entries, truncated };
}

/**
 * One transition signal per outcome, plus the ONE escalation this lane still
 * has: money whose bound has passed is money a human should look at. It no
 * longer withholds anything, so it is reported on a PUBLISHED group.
 *
 * The warn line carries the kind, the ref and the age and deliberately NOT the
 * amount or the symbol: an operator needs to know which row to open, and a warn
 * log is not the place to restate what the user holds.
 */
export function logPublicationOutcome(
  outcome: PublicationOutcome,
  snapshotGroupId: string,
): void {
  if (outcome.published) {
    const { ledger } = outcome;
    logger.info("sync.balance.snapshot_published", {
      snapshotGroupId,
      wallets: outcome.rows.length,
      settledUsd: ledger.settledUsd.toFixed(2),
      inTransitUsd: ledger.inTransitUsd.toFixed(2),
      inFlightCount: ledger.entries.length,
      unresolvedCount: ledger.unresolvedCount,
      inFlightTruncated: ledger.truncated,
    });
    if (ledger.unresolvedCount > 0) {
      logger.warn("sync.balance.snapshot_unresolved_money", {
        snapshotGroupId,
        unresolvedCount: ledger.unresolvedCount,
        unresolved: ledger.entries
          .filter((entry) => entry.standing === "unresolved")
          .map((entry) => ({ kind: entry.kind, ref: entry.ref, ageSeconds: entry.ageSeconds })),
        hint: "counted and shown, excluded from every total until its outcome is proven",
      });
    }
    return;
  }

  const fields = {
    snapshotGroupId,
    reason: outcome.reason,
    hint: "balances still refreshed; the next cycle takes the snapshot",
  };
  if (outcome.reason === "publish_failed") {
    logger.error("sync.balance.snapshot_publish_failed", fields);
    return;
  }
  logger.info("sync.balance.snapshot_deferred", fields);
}

function skip(reason: PublicationSkipReason): PublicationOutcome {
  return { published: false as const, reason };
}

function skipOnError(err: unknown, snapshotGroupId: string): PublicationOutcome {
  const code = pgErrorCode(err);
  if (code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED) {
    logger.info("sync.balance.snapshot_lock_unavailable", { snapshotGroupId, code });
    return skip("lock_unavailable");
  }
  // The failure carries a Postgres connection string - password included - in
  // its message, so only the canonical bounded summary may reach the log.
  logger.warn("sync.balance.snapshot_publish_error", {
    snapshotGroupId,
    error: describeFailureForLog(err),
  });
  return skip("publish_failed");
}

function pgErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Interpolated into `SET LOCAL lock_timeout`, which cannot take a bind
 * parameter - so the value is forced to a bounded integer here rather than
 * trusted. Mirrors `db/repos/balances/valuation.ts`'s statement-timeout clamp.
 */
function boundedLockTimeout(requested: number | undefined): number {
  const value = requested ?? PUBLICATION_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(value)) return PUBLICATION_LOCK_TIMEOUT_MS;
  return Math.min(30_000, Math.max(100, Math.trunc(value)));
}
