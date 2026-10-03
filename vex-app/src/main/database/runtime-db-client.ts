/**
 * The connection policy shared by the runtime control-plane reads.
 *
 * Extracted from `mission-runs-db.ts` unchanged when the control-state
 * aggregate moved into its own module: two readers of the same tables must not
 * grow two connection policies, two timeouts and two spellings of "the database
 * is unavailable". The renderer classifies from the error `code`, so a second
 * variant would become a second contract.
 *
 * Own short-lived `pg.Client` per call (or a client from the separate
 * main-process IPC pool when `MAIN_IPC_PG_POOL` is on), never the engine
 * pool: these reads are on the IPC path, must not queue behind engine work,
 * and must fail fast with a bounded timeout rather than hang a control surface.
 */

import type { Client } from "pg";

import { err, type Result, type VexError } from "@shared/ipc/result.js";
import { buildPoolConfig } from "./db-config.js";
import { runWithMainDbClient } from "./main-ipc-pg-pool.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * `correlationId` is THREADED, not omitted for the framework to stamp later.
 * These reads run beneath handlers and (for the control-state emit) beneath no
 * handler at all, so the id has to come from the caller for the redacted
 * main-side log line and the renderer-visible error to carry the SAME value.
 * That is the `agent-scan-db` pattern, and it is what makes a control-surface
 * failure traceable instead of merely reported.
 */
export function runtimeDbUnavailable(
  correlationId: string,
): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "runtime",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  });
}

export function runtimeDbError(
  correlationId: string,
  reason: string,
  cause?: unknown,
): Result<never, VexError> {
  log.warn(`[runtime-db] ${reason} correlationId=${correlationId}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "runtime",
    message: "Unable to load runtime state.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

export async function withRuntimeDbClient<T>(
  correlationId: string,
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[runtime-db] buildPoolConfig threw", cause);
    return runtimeDbUnavailable(correlationId);
  }
  if (cfg === null) return runtimeDbUnavailable(correlationId);

  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on
  // (`main-ipc-pg-pool.ts`): same config, timeouts and failure results.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[runtime-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: () => runtimeDbUnavailable(correlationId),
    },
    fn,
  );
}
