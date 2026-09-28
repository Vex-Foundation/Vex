/**
 * Vex Agent — Postgres connection pool + typed query helpers.
 *
 * Own pool, own connection string (VEX_DB_URL).
 * Does NOT share pool with legacy src/agent/db/client.ts.
 *
 * Helpers come in two flavors:
 *   - `queryWith` / `queryOneWith` / `executeWith` accept an explicit
 *     `Executor` (Pool | PoolClient). Callers running inside a transaction
 *     (e.g. compact service, PR4 maintenance-lease writers) pass their
 *     own `PoolClient` so statements join the same tx.
 *   - `query` / `queryOne` / `execute` are thin wrappers that delegate to the
 *     `*With` variant using `getPool()` as the executor. They exist for the
 *     ~hundreds of non-tx call sites that just need a pool-backed query.
 *
 * Zero behavioral change for existing callers — wrappers match the previous
 * signatures exactly. New tx-aware callers opt into `*With` explicitly.
 */


import pg from "pg";
import logger from "@utils/logger.js";
import {
  buildPoolConfig,
  readDbBounds,
  redactConnectionString,
  resolveConnectionString,
  FALLBACK_DB_URL,
} from "./pool-config.js";
import { closeControlPool } from "./control-pool.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let longStatementTimeoutMs: number | null = null;

/**
 * The main engine pool. Carries the Kairos S-4 bounds (see `pool-config.ts`):
 * `statement_timeout`, `idle_in_transaction_session_timeout` and a bounded
 * wait for a connection. Stop, lease renewal/release and reconciliation use
 * the separate reserved pool in `control-pool.ts` instead.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const { connectionString, usingFallback } = resolveConnectionString();
    if (usingFallback) {
      // Loud warning: the fallback exists for dev convenience but the canonical
      // expectation is that VEX_DB_URL is set explicitly (matches the
      // compose stack on port 5777). A future PR may remove the fallback entirely.
      // The hint carries only a redacted host/port/db descriptor — never the
      // fallback credentials — so the warning is safe in logs and support bundles.
      logger.warn("vex-db.pool.using_fallback_url", {
        hint: "VEX_DB_URL not set — using local fallback. Set VEX_DB_URL explicitly to silence this warning.",
        fallbackTarget: redactConnectionString(FALLBACK_DB_URL),
      });
    }
    const bounds = readDbBounds();
    longStatementTimeoutMs = bounds.longStatementTimeoutMs;
    pool = new Pool(buildPoolConfig("main", connectionString, bounds));
    pool.on("error", (err) => {
      logger.error("vex-db.pool.error", { error: err.message });
    });
  }
  return pool;
}

/**
 * Executor abstraction — either the shared pool or a specific `PoolClient`
 * that belongs to an open transaction. Both expose the same `.query()`
 * method shape, so tx-aware helpers can accept either.
 */
export type Executor = pg.Pool | pg.PoolClient;

// ── tx-aware helpers (primary API) ──────────────────────────────────

/** Run a query on the given executor and return all rows typed as T. */
export async function queryWith<T extends pg.QueryResultRow>(
  exec: Executor,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await exec.query<T>(sql, params);
  return result.rows;
}

/** Run a query on the given executor and return the first row, or null. */
export async function queryOneWith<T extends pg.QueryResultRow>(
  exec: Executor,
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await exec.query<T>(sql, params);
  return result.rows[0] ?? null;
}

/** Run a mutation on the given executor and return affected row count. */
export async function executeWith(
  exec: Executor,
  sql: string,
  params?: unknown[],
): Promise<number> {
  const result = await exec.query(sql, params);
  return result.rowCount ?? 0;
}

// ── Thin wrappers (backward-compatible) ─────────────────────────────

/** Run a query on the shared pool and return all rows typed as T. */
export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  return queryWith<T>(getPool(), sql, params);
}

/** Run a query on the shared pool and return the first row, or null. */
export async function queryOne<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  return queryOneWith<T>(getPool(), sql, params);
}

/** Run a mutation on the shared pool and return affected row count. */
export async function execute(sql: string, params?: unknown[]): Promise<number> {
  return executeWith(getPool(), sql, params);
}

/**
 * Run `fn` inside a `BEGIN`/`COMMIT` block on a dedicated `PoolClient`.
 * Rollback on throw, always release the client. Returns whatever `fn`
 * resolves with.
 *
 * The wrapper exists so callers that need atomicity across multiple
 * statements (e.g. `appendMessage` — INSERT messages + UPDATE
 * sessions.message_count, then emit-after-commit) get one obvious entry
 * point instead of hand-rolling `getPool().connect()` + try/finally
 * everywhere. ROLLBACK errors are swallowed with `.catch(() => undefined)`
 * so they cannot mask the original failure — the original throw is what
 * the caller cares about.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // Swallow rollback errors so they cannot mask the original failure
    // (the rethrow below carries the actionable diagnostic).
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Long statements (Kairos S-4) ────────────────────────────────

/**
 * Raise `statement_timeout` for the REST OF THE CURRENT TRANSACTION to
 * AGENT_DB_LONG_STATEMENT_TIMEOUT_MS. For the known long statements only
 * (compaction commits and captures, bulk archive moves); everything else
 * keeps the pool's ordinary cap.
 *
 * `SET LOCAL` outside a transaction does nothing (the server only warns), so
 * the caller MUST already have issued `BEGIN` on `client`. The value is an
 * integer from the validated config, never user input; `SET` takes no bind
 * parameter.
 */
export async function setLocalLongStatementTimeout(client: pg.PoolClient): Promise<void> {
  if (longStatementTimeoutMs === null) {
    longStatementTimeoutMs = readDbBounds().longStatementTimeoutMs;
  }
  await client.query(`SET LOCAL statement_timeout = ${Math.trunc(longStatementTimeoutMs)}`);
}

/**
 * `withTransaction` for a transaction that runs known long statements: the
 * raised statement cap is applied right after `BEGIN` and ends with the
 * transaction.
 */
export async function withLongStatementTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await setLocalLongStatementTimeout(client);
    return fn(client);
  });
}

/** Graceful shutdown — drain the main pool and the reserved control pool. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    longStatementTimeoutMs = null;
    logger.info("vex-db.pool.closed");
  }
  await closeControlPool();
}
