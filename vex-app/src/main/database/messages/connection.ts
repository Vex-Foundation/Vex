/**
 * Shared connection + error helpers for the messages DB repository.
 *
 * vex-app's main process talks to the same Postgres instance the engine
 * (`src/vex-agent`) writes to, but it does NOT import the engine repos —
 * vex-app deliberately uses its own pg connections so the GUI build stays
 * decoupled from the engine module graph (mirrors the pattern in
 * `sessions-db.ts`).
 *
 * `withClient` is the single connection wrapper; `dbError` / `dbUnavailable`
 * are the single-sourced failure builders every query function returns.
 */

import type { Client } from "pg";
import { err, type Result, type VexError } from "@shared/ipc/result.js";
import { buildPoolConfig } from "../db-config.js";
import { runWithMainDbClient } from "../main-ipc-pg-pool.js";
import { log } from "../../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` is intentionally omitted from these error literals.
// `registerHandler` stamps `ctx.requestId` downstream when the field is
// absent; an empty-string `correlationId` would be rejected by
// `isValidVexErrorShape` (length === 0) and downgrade the public error
// to `internal.contract_violation`. Mirror the `sessions-db.ts` pattern.
export function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "messages",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

export function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[messages-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "messages",
    message: "Unable to load messages.",
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
    log.warn("[messages-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on
  // (`main-ipc-pg-pool.ts`): same config, timeouts and failure results.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[messages-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: () => dbUnavailable(),
    },
    fn,
  );
}
