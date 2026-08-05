/**
 * The connection policy shared by the runtime control-plane reads.
 *
 * Extracted from `mission-runs-db.ts` unchanged when the control-state
 * aggregate moved into its own module: two readers of the same tables must not
 * grow two connection policies, two timeouts and two spellings of "the database
 * is unavailable". The renderer classifies from the error `code`, so a second
 * variant would become a second contract.
 *
 * Own short-lived `pg.Client` per call, mirroring `sessions-db.ts`: these reads
 * are on the IPC path, must not queue behind engine work, and must fail fast
 * with a bounded timeout rather than hang a control surface.
 */

import { Client, type ClientConfig } from "pg";

import { err, type Result, type VexError } from "@shared/ipc/result.js";
import { buildPoolConfig } from "./db-config.js";
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
    log.warn("[runtime-db] client.connect failed", cause);
    return runtimeDbUnavailable(correlationId);
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[runtime-db] client.end failed (non-fatal)", cause);
    }
  }
}
