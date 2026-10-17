/**
 * Dim-lock DB helper (M9 Step 4).
 *
 * Counts knowledge_entries rows whose `embedding_dim` differs from
 * the new dim the user is trying to set. A non-zero count means the
 * existing vectors would become unreachable until the user exports,
 * wipes, and re-imports knowledge with the new model.
 *
 * Uses `pg.Client` (single-shot connection) instead of `pg.Pool` —
 * cleaner lifecycle for one query per IPC call, no risk of leaking
 * connections to the long-lived process pool.
 *
 * Reads connection metadata from the same `buildPoolConfig()` the
 * M6 migrate runner uses (the connection the local runtime published). If
 * no runtime is up yet (`buildPoolConfig` returns null) or the
 * connect/query throws, returns `embedding.db_unavailable` so the
 * renderer can surface a retry + System Check link.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

/** Bounded probe: keep envState/hot-path responsive even if DB is slow. */
const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 3_000;

function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "embedding.db_unavailable",
    domain: "embedding",
    message:
      "Database unavailable. Check that the local runtime is running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function toClientConfig(
  cfg: NonNullable<Awaited<ReturnType<typeof buildPoolConfig>>>,
): ClientConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  };
}

/**
 * @returns ok(rowCount) where rowCount > 0 means the change would
 * orphan that many existing vectors. ok(0) means the change is safe.
 * err(embedding.db_unavailable) when the DB cannot be reached.
 */
export async function countRowsWithDimNotMatching(
  targetDim: number,
): Promise<Result<number, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[dim-lock] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  const client = new Client(toClientConfig(cfg));
  try {
    await client.connect();
    const res = await client.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM knowledge_entries WHERE embedding_dim <> $1",
      [targetDim],
    );
    const raw = res.rows[0]?.n ?? "0";
    const parsed = Number.parseInt(raw, 10);
    return ok(Number.isFinite(parsed) ? parsed : 0);
  } catch (cause) {
    log.warn("[dim-lock] count query failed", cause);
    return dbUnavailable();
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[dim-lock] client.end failed (non-fatal)", cause);
    }
  }
}

/**
 * Best-effort connectivity probe for `envState.embeddings.dbReachable`.
 * Returns true / false / null (timeout). Caller treats null as
 * "unknown — let the actual write attempt surface the real status".
 */
export async function probeDbReachable(): Promise<boolean | null> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch {
    return false;
  }
  if (cfg === null) return false;

  const client = new Client(toClientConfig(cfg));
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), CONNECT_TIMEOUT_MS + 200).unref?.();
  });

  try {
    const probe = (async () => {
      await client.connect();
      return true;
    })().catch(() => false);
    const result = await Promise.race([probe, timeout]);
    return result;
  } finally {
    try {
      await client.end();
    } catch {
      // best-effort
    }
  }
}
