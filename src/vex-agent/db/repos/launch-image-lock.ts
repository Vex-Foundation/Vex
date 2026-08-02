/**
 * The image lock — the one serialization point between deleting a locker image
 * and creating/authorizing an intent that references it (contract C2).
 *
 * WHY IT EXISTS. `launch_images` deliberately has NO foreign key from
 * `token_launch_intents.image_id`: the delete refusal is conditional on the
 * referencing row's STATUS, which a foreign key cannot express (see the header
 * of `./launch-images.ts`). That leaves the database with nothing to block the
 * race. Under READ COMMITTED, a delete transaction's reference check does not
 * see an intent inserted concurrently by another transaction, and the inserting
 * transaction does not see the pending delete — both commit, and a live launch
 * about to sign is left pointing at metadata and bytes that are gone. On a
 * real-funds path that is not acceptable.
 *
 * WHAT IT IS. A transaction-scoped Postgres advisory lock keyed on the image id,
 * taken by the delete transaction BEFORE its reference check and by every intent
 * write that references an image BEFORE the insert/update. The two paths take
 * the SAME key, so they serialize; writes touching different images never
 * contend. `pg_advisory_xact_lock` releases at COMMIT/ROLLBACK, so no failure
 * path can leak it — the same mechanism and key idiom `mission_results` uses for
 * `seq_no` minting.
 *
 * This module owns the key derivation so the two callers cannot drift apart; a
 * key computed differently on either side is a lock that silently locks nothing.
 * It lives outside both callers to keep `launch-images.ts` and the intent
 * writers free of an import cycle.
 */

import type { PoolClient } from "pg";

/**
 * `hashtextextended` maps the namespaced key to the bigint the advisory-lock
 * functions take. Collisions are possible in principle and harmless in practice:
 * the consequence is two unrelated images briefly serializing, never a missed
 * lock.
 */
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

const IMAGE_EXISTS_SQL = "SELECT 1 FROM launch_images WHERE image_id = $1";

/**
 * The image a write tried to capture no longer exists — the writer LOST the
 * delete-first race and refuses rather than persisting a dangling `image_id`.
 *
 * Thrown, not returned as `null`, on both writers deliberately. `null` is the
 * CAS-miss vocabulary ("the state moved on, this is recoverable"), while this is
 * a hard refusal that must roll the transaction back and must never be confused
 * with an expired form. A launch that reached signing with an `image_id` behind
 * which there are no bytes is the exact failure C2 exists to prevent.
 */
export class LaunchImageMissingError extends Error {
  readonly code = "image_not_found" as const;
  readonly imageId: string;
  constructor(imageId: string) {
    super(
      `launch_images: image "${imageId}" no longer exists — it was deleted before this launch write could capture it. Upload the image again and retry; nothing was signed.`,
    );
    this.name = "LaunchImageMissingError";
    this.imageId = imageId;
  }
}

/** Stable, namespaced advisory-lock key for one locker image. */
export function launchImageLockKey(imageId: string): string {
  return `launch_image:${imageId}`;
}

/**
 * Block until this transaction owns the image's lock. Callers MUST already be
 * inside a transaction — outside one the lock is taken and released by the same
 * implicit transaction and protects nothing.
 */
export async function lockLaunchImageWith(
  client: PoolClient,
  imageId: string,
): Promise<void> {
  await client.query(LOCK_SQL, [launchImageLockKey(imageId)]);
}

/**
 * Take the image's lock and CONFIRM the image survived the wait — the call every
 * intent write that captures an image must use.
 *
 * The lock orders the two transactions; it does not decide which one wins. In
 * the DELETE-FIRST interleaving the deletion holds the lock, sees no live
 * intent, deletes and commits, and this writer's lock is then granted over an
 * image that is already gone. Locking alone would happily insert that dangling
 * id. Re-reading UNDER THE HELD LOCK is what makes the outcome safe in both
 * orders: either the intent exists before the check (delete refuses) or the
 * image is gone before the write (this refuses).
 *
 * @throws {LaunchImageMissingError} when the row is gone.
 */
export async function lockAndRequireLaunchImageWith(
  client: PoolClient,
  imageId: string,
): Promise<void> {
  await lockLaunchImageWith(client, imageId);
  const res = await client.query(IMAGE_EXISTS_SQL, [imageId]);
  if (res.rowCount === 0) throw new LaunchImageMissingError(imageId);
}
