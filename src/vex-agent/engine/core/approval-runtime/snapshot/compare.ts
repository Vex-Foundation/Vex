/**
 * Approval runtime — locked-tx snapshot phase: read-only helpers.
 *
 * Lock+load of the denormalised snapshot row and the DB-side `NOW()` read for
 * the atomic TTL gate. Both are READ-only: `lockAndLoadSnapshot` acquires the
 * `FOR UPDATE OF i, q, s` row locks but writes nothing, and `getDbNow` reads
 * the committed DB clock so an approve racing the TTL boundary observes a
 * single committed truth. The CAS / write owners live in `./build.js`.
 */

import type { ClientBase } from "pg";

import type { IntentSnapshotRow } from "./types.js";
import { SNAPSHOT_SELECT_SQL } from "./render.js";

export async function lockAndLoadSnapshot(
  client: ClientBase,
  approvalId: string,
): Promise<IntentSnapshotRow | null> {
  const res = await client.query<IntentSnapshotRow>(SNAPSHOT_SELECT_SQL, [
    approvalId,
  ]);
  return res.rows[0] ?? null;
}

export async function getDbNow(client: ClientBase): Promise<Date> {
  const res = await client.query<{ now: Date }>("SELECT NOW() as now", []);
  return res.rows[0].now;
}
