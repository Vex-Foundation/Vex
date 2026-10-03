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
 *
 * K-4: the shared main-process IPC pool (`main-ipc-pg-pool.ts`, behind
 * `MAIN_IPC_PG_POOL`) installs itself here as the connection runner when it
 * loads (the main entry imports it at startup). This module does not import
 * the pool: the root test program reaches this file, and keeping the pool out
 * of that program keeps it inside that program's rootDir. Until a runner is
 * installed (and in any test that never loads the pool) the default runner
 * below is the fresh-client-per-call path, the same code that was here before.
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

/** The resolved connection config `withRuntimeDbClient` hands a runner. */
export type RuntimeDbPoolConfig = NonNullable<Awaited<ReturnType<typeof buildPoolConfig>>>;

/**
 * Runs `fn` on a connected client. Structurally the signature of
 * `runWithMainDbClient`, so the pool installs that function unchanged.
 */
export type RuntimeDbClientRunner = <R>(
  cfg: RuntimeDbPoolConfig,
  call: {
    readonly logPrefix: string;
    readonly timeouts: {
      readonly connectTimeoutMs: number;
      readonly statementTimeoutMs: number;
    };
    readonly onConnectFailed: (cause: unknown) => R;
  },
  fn: (client: Client) => Promise<R>,
) => Promise<R>;

/** Today's path: a fresh client per call, ended in `finally`. */
const runWithFreshClient: RuntimeDbClientRunner = async (cfg, call, fn) => {
  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: call.timeouts.connectTimeoutMs,
    statement_timeout: call.timeouts.statementTimeoutMs,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn(`${call.logPrefix} client.connect failed`, cause);
    return call.onConnectFailed(cause);
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn(`${call.logPrefix} client.end failed (non-fatal)`, cause);
    }
  }
};

let runner: RuntimeDbClientRunner = runWithFreshClient;

/** Called by `main-ipc-pg-pool.ts` when it loads; `null` restores the default. */
export function installRuntimeDbClientRunner(next: RuntimeDbClientRunner | null): void {
  runner = next ?? runWithFreshClient;
}

/** Test seam: whether the default fresh-client runner is in force. */
export function runtimeDbClientRunnerIsDefault(): boolean {
  return runner === runWithFreshClient;
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

  return runner(
    cfg,
    {
      logPrefix: "[runtime-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: () => runtimeDbUnavailable(correlationId),
    },
    fn,
  );
}
