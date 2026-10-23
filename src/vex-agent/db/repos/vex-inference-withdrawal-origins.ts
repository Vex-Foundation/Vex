/**
 * Which Vex Inference withdrawals THIS app created (migration 181): the
 * durable memory behind the "a withdrawal you did not start" notice.
 *
 * OWNER. The Electron main process
 * (`vex-app/src/main/vex-cloud/funding/withdrawal-origins.ts`). This module is
 * persistence only: it never decides what is cooling or what is a notice.
 *
 * Account ids are stored lowercase, so the same account read in another case
 * is one key.
 */

import { getPool, queryOneWith, queryWith, type Executor } from "../client.js";

export type WithdrawalOrigin = "created_here" | "foreign";

export interface WithdrawalOriginRow {
  readonly accountId: string;
  readonly withdrawalId: string;
  readonly origin: WithdrawalOrigin;
  readonly recordedAt: Date;
  readonly dismissedAt: Date | null;
}

interface OriginDbRow {
  readonly account_id: string;
  readonly withdrawal_id: string;
  readonly origin: WithdrawalOrigin;
  readonly recorded_at: Date;
  readonly dismissed_at: Date | null;
}

function mapRow(row: OriginDbRow): WithdrawalOriginRow {
  return {
    accountId: row.account_id,
    withdrawalId: row.withdrawal_id,
    origin: row.origin,
    recordedAt: row.recorded_at,
    dismissedAt: row.dismissed_at,
  };
}

const COLUMNS = "account_id, withdrawal_id, origin, recorded_at, dismissed_at";

/**
 * Record that this app created the withdrawal. Idempotent. A row the scan
 * wrote as `foreign` (its create answer was lost, then resolved) becomes
 * `created_here`, so its notice disappears.
 */
export async function recordWithdrawalCreatedHere(
  accountId: string,
  withdrawalId: string,
  db: Executor = getPool(),
): Promise<void> {
  await queryWith(
    db,
    `INSERT INTO vex_inference_withdrawal_origins (account_id, withdrawal_id, origin)
     VALUES ($1, $2, 'created_here')
     ON CONFLICT (account_id, withdrawal_id) DO UPDATE SET origin = 'created_here', dismissed_at = NULL`,
    [accountId.toLowerCase(), withdrawalId],
  );
}

/** The rows for these ids on the account; ids without a row are absent from the map. */
export async function readWithdrawalOrigins(
  accountId: string,
  withdrawalIds: readonly string[],
  db: Executor = getPool(),
): Promise<ReadonlyMap<string, WithdrawalOriginRow>> {
  if (withdrawalIds.length === 0) return new Map();
  const rows = await queryWith<OriginDbRow>(
    db,
    `SELECT ${COLUMNS} FROM vex_inference_withdrawal_origins WHERE account_id = $1 AND withdrawal_id = ANY($2::text[])`,
    [accountId.toLowerCase(), [...withdrawalIds]],
  );
  return new Map(rows.map((row) => [row.withdrawal_id, mapRow(row)]));
}

/**
 * Write the `foreign` row for an id this app did not create. Returns `true`
 * for exactly the ONE call that wrote it (the moment its notice is emitted),
 * `false` when any row for the id already exists, `created_here` included:
 * the insert never overwrites.
 */
export async function flagForeignWithdrawal(
  accountId: string,
  withdrawalId: string,
  db: Executor = getPool(),
): Promise<boolean> {
  const row = await queryOneWith<{ withdrawal_id: string }>(
    db,
    `INSERT INTO vex_inference_withdrawal_origins (account_id, withdrawal_id, origin)
     VALUES ($1, $2, 'foreign')
     ON CONFLICT (account_id, withdrawal_id) DO NOTHING
     RETURNING withdrawal_id`,
    [accountId.toLowerCase(), withdrawalId],
  );
  return row !== null;
}

/**
 * The user's "It was me" on a notice. Only a `foreign` row can be dismissed;
 * returns whether one was (a repeated dismiss of the same row returns `true`).
 */
export async function dismissForeignWithdrawal(
  accountId: string,
  withdrawalId: string,
  db: Executor = getPool(),
): Promise<boolean> {
  const row = await queryOneWith<{ withdrawal_id: string }>(
    db,
    `UPDATE vex_inference_withdrawal_origins
        SET dismissed_at = coalesce(dismissed_at, now())
      WHERE account_id = $1 AND withdrawal_id = $2 AND origin = 'foreign'
      RETURNING withdrawal_id`,
    [accountId.toLowerCase(), withdrawalId],
  );
  return row !== null;
}
