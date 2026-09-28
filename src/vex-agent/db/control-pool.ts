/**
 * Vex Agent — the reserved CONTROL pool (Kairos S-4).
 *
 * A small, separate Postgres pool (AGENT_DB_CONTROL_POOL_MAX, default 2) used
 * ONLY for the writes that must still get through when the main pool is busy:
 *
 *   - user / session Stop,
 *   - runner lease renewal and release,
 *   - reconciliation of uncertain outcomes.
 *
 * Ordinary queries MUST keep using `client.ts` (`query`, `withTransaction`,
 * ...). Anything else here would eat the reserve and defeat its purpose.
 *
 * What it buys: priority against Vex's OWN main-pool saturation (ten busy
 * main-pool clients cannot starve a Stop). What it does not buy: a guarantee.
 * The server's `max_connections`, a row or advisory lock held by another
 * transaction, or a down database still apply; the control pool carries the
 * same statement / idle-in-transaction / connect bounds as the main pool, so
 * those cases fail within a bound instead of hanging.
 */

import pg from "pg";
import logger from "@utils/logger.js";
import { buildPoolConfig, readDbBounds, resolveConnectionString } from "./pool-config.js";

const { Pool } = pg;

let controlPool: pg.Pool | null = null;

/** The reserved control pool (lazily created, separate from `getPool()`). */
export function getControlPool(): pg.Pool {
  if (!controlPool) {
    const { connectionString } = resolveConnectionString();
    controlPool = new Pool(buildPoolConfig("control", connectionString, readDbBounds()));
    controlPool.on("error", (err) => {
      logger.error("vex-db.control_pool.error", { error: err.message });
    });
  }
  return controlPool;
}

/**
 * Run `fn` with one control-pool client (no transaction), always releasing it.
 * Use for single statements such as a lease renewal `UPDATE`.
 */
export async function withControlClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getControlPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * `BEGIN`/`COMMIT` on a control-pool client; `ROLLBACK` on throw (a failing
 * rollback never masks the original error). Same contract as
 * `client.ts#withTransaction`, different pool.
 */
export async function withControlTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withControlClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

/** Drain the control pool. Called by `client.ts#closePool`. */
export async function closeControlPool(): Promise<void> {
  if (controlPool) {
    const draining = controlPool;
    controlPool = null;
    await draining.end();
    logger.info("vex-db.control_pool.closed");
  }
}
