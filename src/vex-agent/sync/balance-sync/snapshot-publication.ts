/**
 * WP8 - publishing ONE portfolio snapshot group inside ONE short transaction.
 *
 * The gate's reasoning lives in `./publication-gate.ts`. This module owns the
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
 *   4. blockers + transition fence, under the lock.
 *   5. prior snapshots + the WHOLE group inserted, still under the lock.
 *   6. COMMIT.
 *
 * ## Nothing here may fail the balance refresh
 *
 * Balances are written per wallet-chain long before this runs and stay fresh
 * regardless. A snapshot that cannot be taken safely is a SKIP with a named
 * reason, never a thrown error that aborts the cycle - including a lock
 * timeout, a deadlock, and a gate probe that could not run. `publish_failed`
 * (an actual insert error) is the one skip logged at ERROR, because unlike the
 * others it indicates a defect rather than a busy money path.
 *
 * ## Whole group or none
 *
 * Every row is inserted on the transaction's own client, so a failure at wallet
 * three rolls back wallets one and two with it. A half-populated
 * `snapshotGroupId` would break the aggregate stitch AND `pnl_vs_prev`, whose
 * per-wallet chain would then span a gap on some wallets and not others.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import { insertSnapshot } from "@vex-agent/db/repos/balances.js";
import { describeFailureForLog } from "@utils/error-summary.js";
import logger from "@utils/logger.js";
import {
  fencesMatch,
  readActivityFence,
  readPublicationBlockers,
  type ActivityFence,
  type PublicationBlocker,
} from "./publication-gate.js";

/**
 * How long the publisher waits for the activity table lock. Small on purpose:
 * a busy money path is exactly when a snapshot is unsafe, so waiting longer
 * buys nothing but a held pool client.
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

export type PublicationSkipReason =
  /** Something is in flight, or its outcome is unproven. See `blockers`. */
  | "in_flight_money_state"
  /** A transaction began and settled during the scan - the group would mix reads. */
  | "activity_transition"
  /** The activity table lock could not be taken within the bounded wait. */
  | "lock_unavailable"
  /** The gate itself could not be evaluated. Unknown means blocked. */
  | "gate_probe_failed"
  /** The insert failed. Zero rows from this group exist. A defect, not a busy path. */
  | "publish_failed";

export type PublicationOutcome =
  | { readonly published: true; readonly rows: readonly PublishedSnapshot[] }
  | {
      readonly published: false;
      readonly reason: PublicationSkipReason;
      readonly blockers: readonly PublicationBlocker[];
    };

export interface PublishSnapshotGroupInput {
  readonly snapshotGroupId: string;
  readonly walletAddresses: readonly string[];
  /** The activity generation stamped BEFORE the scan started. */
  readonly fenceAtCycleStart: ActivityFence;
  readonly drafts: readonly SnapshotDraft[];
  readonly lockTimeoutMs?: number;
}

export async function publishSnapshotGroup(
  input: PublishSnapshotGroupInput,
): Promise<PublicationOutcome> {
  const lockTimeoutMs = boundedLockTimeout(input.lockTimeoutMs);
  try {
    return await withTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      await client.query("LOCK TABLE agent_activity IN SHARE MODE");

      const blockers = await readPublicationBlockers(client, input.walletAddresses);
      if (blockers.length > 0) {
        return skip("in_flight_money_state", blockers);
      }

      const fenceNow = await readActivityFence(client, input.walletAddresses);
      if (!fencesMatch(input.fenceAtCycleStart, fenceNow)) {
        return skip("activity_transition", []);
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
      return { published: true as const, rows };
    });
  } catch (err) {
    return skipOnError(err, input.snapshotGroupId);
  }
}

/**
 * The gate's own read of the outcome above, plus the escalation the owner asked
 * for: a blocker older than `UNRECONCILED_AFTER_MS` is reported as needing
 * attention. It is still a blocker - age never releases publication.
 */
export function logPublicationOutcome(
  outcome: PublicationOutcome,
  snapshotGroupId: string,
): void {
  if (outcome.published) return;
  const unreconciled = outcome.blockers.filter((b) => b.unreconciled);
  const fields = {
    snapshotGroupId,
    reason: outcome.reason,
    blockers: outcome.blockers.map((b) => ({
      kind: b.kind,
      ref: b.ref,
      detail: b.detail,
      ageSeconds: b.ageSeconds,
    })),
    unreconciledCount: unreconciled.length,
    hint: "balances still refreshed; publication resumes once every money-path row terminalizes",
  };
  if (outcome.reason === "publish_failed") {
    logger.error("sync.balance.snapshot_publish_failed", fields);
    return;
  }
  if (unreconciled.length > 0) {
    // Named separately because it is no longer "a transaction in progress":
    // something has been unproven for long enough to need a human, and until it
    // is reconciled EVERY later snapshot is withheld.
    logger.warn("sync.balance.snapshot_blocked_unreconciled", fields);
    return;
  }
  logger.info("sync.balance.snapshot_deferred", fields);
}

function skip(
  reason: PublicationSkipReason,
  blockers: readonly PublicationBlocker[],
): PublicationOutcome {
  return { published: false as const, reason, blockers };
}

function skipOnError(err: unknown, snapshotGroupId: string): PublicationOutcome {
  const code = pgErrorCode(err);
  if (code === LOCK_NOT_AVAILABLE || code === DEADLOCK_DETECTED) {
    logger.info("sync.balance.snapshot_lock_unavailable", { snapshotGroupId, code });
    return skip("lock_unavailable", []);
  }
  // The failure carries a Postgres connection string - password included - in
  // its message, so only the canonical bounded summary may reach the log.
  logger.warn("sync.balance.snapshot_publish_error", {
    snapshotGroupId,
    error: describeFailureForLog(err),
  });
  return skip("publish_failed", []);
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
