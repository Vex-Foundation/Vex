/**
 * Session message archiving helpers.
 *
 * Kept separate from `sessions.ts` so the lifecycle repo stays focused
 * while preserving the public `sessionsRepo.archivePrefix /
 * forkToolMessageToArchive` surface via re-exports.
 *
 * Explicit column projection (puzzle 04 phase 5)
 * ----------------------------------------------
 * Migration 023 added `messages_archive.rewind_checkpoint_id`. The
 * column lives ONLY on the archive table — `messages` doesn't have
 * it. That breaks the previous `INSERT INTO messages_archive SELECT *
 * FROM messages` shortcut: the source row count would no longer match
 * the target's column count. The fix is the same in both writers
 * below:
 *
 *   - SELECT projection from `messages` uses `MESSAGE_DB_COLUMNS`
 *     (12 columns)
 *   - INSERT target uses `MESSAGE_ARCHIVE_DB_COLUMNS` (13 columns)
 *   - `rewind_checkpoint_id` is always written NULL: both
 *     `archivePrefix` (compaction) and `forkToolMessageToArchive`
 *     (giant-tool overflow) pass NULL. The rewind/restore writer that
 *     once stamped a non-NULL id was removed in phase 4e; the column
 *     itself is retained (migration 023 is immutable).
 *
 * The constants live in `messages.ts` so adding a column to the
 * messages schema forces a deliberate update there, and any forgotten
 * archive path fails typecheck.
 */

import type { PoolClient } from "pg";
import { getPool, setLocalLongStatementTimeout } from "../client.js";
import { MESSAGE_DB_COLUMNS } from "./messages.js";

const MESSAGE_COLS = MESSAGE_DB_COLUMNS.join(", ");

/**
 * Partial archive — move messages with `id <= cutoffMessageId` into
 * `messages_archive` and set the live `message_count` to
 * `remainingCount`.
 *
 * Compaction-only path — every archived row gets `rewind_checkpoint_id
 * = NULL`.
 */
export async function archivePrefix(
  sessionId: string,
  cutoffMessageId: number,
  remainingCount: number,
  client?: PoolClient,
): Promise<void> {
  if (client) {
    await runArchivePrefixStatements(client, sessionId, cutoffMessageId, remainingCount);
    return;
  }
  const own = await getPool().connect();
  try {
    await own.query("BEGIN");
    // Known long statement (S-4): a bulk row move that scales with the session.
    await setLocalLongStatementTimeout(own);
    await runArchivePrefixStatements(own, sessionId, cutoffMessageId, remainingCount);
    await own.query("COMMIT");
  } catch (err) {
    await own.query("ROLLBACK").catch(() => {
      // ROLLBACK failures are non-actionable; the original error is what matters.
    });
    throw err;
  } finally {
    own.release();
  }
}

async function runArchivePrefixStatements(
  tx: PoolClient,
  sessionId: string,
  cutoffMessageId: number,
  remainingCount: number,
): Promise<void> {
  // Symmetric session-row lock — `forkToolMessageToArchive` takes the
  // same lock, so both archive mutators serialize on the same row.
  await tx.query(
    `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  await tx.query(
    `WITH moved AS (
       DELETE FROM messages
       WHERE session_id = $1 AND id <= $2
       RETURNING ${MESSAGE_COLS}
     )
     INSERT INTO messages_archive (${MESSAGE_COLS}, rewind_checkpoint_id)
       SELECT ${MESSAGE_COLS}, NULL FROM moved
       ON CONFLICT (id) DO NOTHING`,
    [sessionId, cutoffMessageId],
  );
  await tx.query(
    "UPDATE sessions SET message_count = $2 WHERE id = $1",
    [sessionId, remainingCount],
  );
}

/**
 * Giant-tool fallback — copy one live message into the archive and
 * replace the live row's content with a short placeholder. Stamped
 * `rewind_checkpoint_id = NULL` (compaction-style, non-restorable).
 *
 * Takes `sessionId` so the internal helper can lock the sessions
 * row first (symmetric with `archivePrefix`). Caller
 * (`compact-jobs/service.ts`) already has the session id in scope.
 */
export async function forkToolMessageToArchive(
  sessionId: string,
  messageId: number,
  placeholderContent: string,
  client?: PoolClient,
): Promise<void> {
  if (client) {
    await runForkToolStatements(client, sessionId, messageId, placeholderContent);
    return;
  }
  const own = await getPool().connect();
  try {
    await own.query("BEGIN");
    // Known long statement (S-4): a bulk row move that scales with the session.
    await setLocalLongStatementTimeout(own);
    await runForkToolStatements(own, sessionId, messageId, placeholderContent);
    await own.query("COMMIT");
  } catch (err) {
    await own.query("ROLLBACK").catch(() => {
      // ROLLBACK failures are non-actionable; the original error is what matters.
    });
    throw err;
  } finally {
    own.release();
  }
}

async function runForkToolStatements(
  tx: PoolClient,
  sessionId: string,
  messageId: number,
  placeholderContent: string,
): Promise<void> {
  // Symmetric session-row lock — same invariant as `archivePrefix`.
  await tx.query(
    `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  // Both subsequent statements constrain by `session_id` AS WELL AS
  // `id` so a wrong `sessionId` arg cannot lock one session row while
  // mutating a message owned by another. Caller bugs surface as a
  // no-op rather than cross-session writes.
  await tx.query(
    `INSERT INTO messages_archive (${MESSAGE_COLS}, rewind_checkpoint_id)
       SELECT ${MESSAGE_COLS}, NULL FROM messages
       WHERE id = $1 AND session_id = $2
     ON CONFLICT (id) DO NOTHING`,
    [messageId, sessionId],
  );
  await tx.query(
    "UPDATE messages SET content = $3 WHERE id = $1 AND session_id = $2",
    [messageId, sessionId, placeholderContent],
  );
}
