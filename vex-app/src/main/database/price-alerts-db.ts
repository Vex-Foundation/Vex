/**
 * Price alerts DB helper - schema-readiness gate for the price-alert worker
 * supervisor (F01).
 *
 * Mirrors `sync-db.ts`'s probe: own `pg.Client` per call, no
 * `@vex-agent/db/repos/*` import. `probePriceAlertsReady()` proves Postgres is
 * reachable AND the `price_alerts` table exists (migration 184 applied), so
 * the supervisor keeps the poller idle instead of logging query errors against
 * a database that is not migrated yet.
 */

import { Client, type ClientConfig } from "pg";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * `true` only when Postgres is reachable AND `public.price_alerts` exists.
 * Any failure (config absent, connect error, table missing, query error) is
 * `false`, so the supervisor keeps the poller idle.
 */
export async function probePriceAlertsReady(): Promise<boolean> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[price-alerts-db] buildPoolConfig threw", cause);
    return false;
  }
  if (cfg === null) return false;

  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[price-alerts-db] client.connect failed", cause);
    return false;
  }
  try {
    const r = await client.query<{ reg: string | null }>(
      `SELECT to_regclass('public.price_alerts') AS reg`,
    );
    return r.rows[0]?.reg != null;
  } catch (cause) {
    log.warn("[price-alerts-db] probePriceAlertsReady query failed", cause);
    return false;
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[price-alerts-db] client.end failed (non-fatal)", cause);
    }
  }
}
