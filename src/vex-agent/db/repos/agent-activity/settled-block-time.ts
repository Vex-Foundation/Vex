/**
 * The ONE writer of `agent_activity.settled_block_time` (migration 078).
 *
 * WHAT THE COLUMN IS. The block time of the transaction that settled the row,
 * read from the chain. It is NOT `confirmed_at`, which is the time this install
 * OBSERVED the settlement, and which trails the block by however long the app
 * was not running. AgentScan compares a reported confirmation time against the
 * block time it reads itself and strikes the install when they disagree by more
 * than its tolerance, so an honest late observation is exactly the shape that
 * gets struck. Reporting the block time, or nothing, removes that class.
 *
 * ITS OWN MODULE, not a parameter on the confirm CAS: the block time is a
 * SEPARATE fact from the status transition, established by a separate chain
 * read that not every confirm site can make. A missing block time is the normal
 * state (every row written before 078, every confirm site with no block to
 * read), and the reporter's rule is explicitly "no block time means send no
 * confirmation time" — so this write failing, or never happening, degrades the
 * report's precision and nothing else. It is not a money write and not a
 * safety condition.
 *
 * WRITE-ONCE, CONFIRMED-ONLY. The CAS refuses a row that is not `confirmed` and
 * refuses to overwrite a value already recorded: two readers of the same block
 * must agree, and if they do not, the first observation is the one that was
 * already reported.
 */

import { queryOne } from "../../client.js";

/**
 * Record the settling block's time on a CONFIRMED row that has none.
 *
 * Returns whether the value was written. `false` means the row was not
 * confirmed, no longer exists, or already carries a block time — all ordinary
 * outcomes, none of them an error.
 */
export async function noteSettledBlockTime(id: number, blockTimeIso: string): Promise<boolean> {
  const written = await queryOne<{ id: number }>(
    `UPDATE agent_activity
        SET settled_block_time = $2::timestamptz, updated_at = NOW()
      WHERE id = $1 AND status = 'confirmed' AND settled_block_time IS NULL
      RETURNING id`,
    [id, blockTimeIso],
  );
  return written !== null;
}
