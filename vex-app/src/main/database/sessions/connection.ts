/**
 * Shared connection + error helpers for the sessions DB repository.
 *
 * vex-app's main process talks to the same Postgres instance the engine
 * (`src/vex-agent`) writes to, but it does NOT import the engine repos —
 * vex-app deliberately uses its own pg connections so the GUI build stays
 * decoupled from the engine module graph (mirrors the pattern in
 * `dim-lock.ts`).
 *
 * `withClient` is the single connection wrapper (a fresh client per call, or
 * one checked out of the shared main-process pool when `MAIN_IPC_PG_POOL` is
 * on, see `../main-ipc-pg-pool.ts`); `dbError` / `dbUnavailable`
 * are the single-sourced failure builders every query function returns.
 */

import type { Client } from "pg";
import { err, type Result, type VexError } from "@shared/ipc/result.js";
import { buildPoolConfig } from "../db-config.js";
import { runWithMainDbClient } from "../main-ipc-pg-pool.js";
import { log } from "../../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

export function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "internal",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

export function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[sessions-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "internal",
    message: "Unable to complete the session operation.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

export async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[sessions-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on: same
  // connection config, same timeouts, same failure results either way.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[sessions-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: dbUnavailable,
    },
    fn,
  );
}
