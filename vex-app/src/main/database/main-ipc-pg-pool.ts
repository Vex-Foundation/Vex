/**
 * One shared, bounded `pg.Pool` for the main process's IPC database reads
 * (Kairos Phase 7, K-4), behind the named constant {@link MAIN_IPC_PG_POOL}.
 *
 * WHY. Every main-process `withClient` opened a FRESH `pg.Client` per call:
 * TCP connect, startup, SCRAM handshake, one query, `end()`. A window focus
 * refetches every active renderer query (`refetchOnWindowFocus`), so a focus
 * fired a burst of those handshakes into Docker at once (on Windows through
 * the WSL2 port proxy). `scripts/probes/pg-connect-latency.mjs` measures that
 * per-call cost on the owner's machine.
 *
 * WHO USES IT. Every IPC connection wrapper in `src/main/database` (the
 * sessions, messages and bug-reports `withClient`, the private `withClient`
 * copies of the approvals, missions, portfolio, usage, memory, compaction,
 * agent-scan and token-history modules, and `withRuntimeDbClient`, which this
 * module installs itself into on load rather than being imported by it). Readiness
 * probes keep their own client; `__tests__/main-ipc-pg-pool-routing.test.ts`
 * pins both lists.
 *
 * WHAT CHANGES WHEN ON. A caller checks one client out of a small pool for the
 * whole of its callback, so a caller that runs BEGIN ... COMMIT keeps one
 * dedicated connection for its transaction, exactly as before. The client is
 * always given back, also when the callback throws. It is DESTROYED rather
 * than reused when:
 *
 *   - the callback threw, or
 *   - the connection is not idle at release (an open or aborted transaction:
 *     the last ReadyForQuery status was not `I`).
 *
 * Destroying is what today's `client.end()` did for every call, so a caller
 * that leaves a transaction open can never hand it to the next caller.
 *
 * Connection config is unchanged: same host/port/database/user/password, same
 * `connectionTimeoutMillis` and `statement_timeout`. The pool only adds `max`
 * and an idle timeout. `connectionTimeoutMillis` also bounds the wait for a
 * free pooled client, so a saturated pool fails as fast as a refused connect.
 *
 * NESTING. A `withClient` call made from INSIDE another pooled callback (same
 * async context) takes a fresh per-call client, today's path. With a bounded
 * pool, nested checkouts could otherwise wait on each other until the connect
 * timeout.
 *
 * LIFECYCLE. The pool is closed on app quit (ordered quit stage, before
 * Compose stops Postgres), and retired whenever the DB connection handoff
 * changes (`setDbConnection`: compose up/reuse after a Docker or Postgres
 * restart, compose down) or the resolved config differs from the live pool's
 * (port or password changed). Retiring waits for checked-out clients, so an
 * in-flight transaction finishes on its own connection; new callers get a new
 * pool.
 *
 * OFF restores today's exact behaviour: a fresh `Client` per call, `end()` in
 * `finally`, the same log lines.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { Client, Pool, type ClientConfig, type PoolClient } from "pg";

import { subscribeDbConnection } from "./connection-state.js";
import type { DbPoolConfig } from "./db-config.js";
import { installRuntimeDbClientRunner } from "./runtime-db-client.js";
import { log } from "../logger/index.js";

/** K-4 switch. `false` restores the fresh-`Client`-per-call path exactly. */
export const MAIN_IPC_PG_POOL = false;

/** Upper bound on pooled connections the main-process IPC reads may hold. */
export const MAIN_IPC_PG_POOL_MAX = 4;

/** An unused pooled connection is closed after this long. */
export const MAIN_IPC_PG_POOL_IDLE_TIMEOUT_MS = 30_000;

export interface MainDbClientTimeouts {
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface MainDbClientCall<R> {
  /** Log prefix of the calling module, e.g. `[sessions-db]`. */
  readonly logPrefix: string;
  readonly timeouts: MainDbClientTimeouts;
  /**
   * What the caller returns (or throws) when no connection could be obtained,
   * after the `client.connect failed` line is logged.
   */
  readonly onConnectFailed: (cause: unknown) => R;
}

let override: boolean | null = null;

/** Test seam: force the switch either way; `null` returns to the constant. */
export function setMainIpcPgPoolOverrideForTests(value: boolean | null): void {
  override = value;
}

export function mainIpcPgPoolEnabled(): boolean {
  return override ?? MAIN_IPC_PG_POOL;
}

export function toMainDbClientConfig(
  cfg: DbPoolConfig,
  timeouts: MainDbClientTimeouts,
): ClientConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: timeouts.connectTimeoutMs,
    statement_timeout: timeouts.statementTimeoutMs,
  };
}

/**
 * Runs `fn` with a connected client: pooled when the switch is on and the call
 * is not nested inside another pooled callback, fresh per call otherwise.
 * A failed connect returns `onConnectFailed(cause)`; rethrows
 * whatever `fn` throws, after the client is released.
 */
export async function runWithMainDbClient<R>(
  cfg: DbPoolConfig,
  call: MainDbClientCall<R>,
  fn: (client: Client) => Promise<R>,
): Promise<R> {
  const clientConfig = toMainDbClientConfig(cfg, call.timeouts);
  if (!mainIpcPgPoolEnabled() || nestedScope.getStore() === true) {
    return runWithFreshClient(clientConfig, call, fn);
  }
  return runWithPooledClient(clientConfig, call, fn);
}

// ── OFF path: today's code, unchanged ──────────────────────────────────

async function runWithFreshClient<R>(
  clientConfig: ClientConfig,
  call: MainDbClientCall<R>,
  fn: (client: Client) => Promise<R>,
): Promise<R> {
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
}

// ── ON path: the shared pool ───────────────────────────────────────────

interface LivePool {
  readonly key: string;
  readonly pool: Pool;
}

const nestedScope = new AsyncLocalStorage<true>();
/** Last ReadyForQuery transaction status per pooled client: I, T or E. */
const txStatus = new WeakMap<Client, string>();
let live: LivePool | null = null;
let unsubscribeConnection: (() => void) | null = null;
const retiring = new Set<Promise<void>>();

function poolKey(config: ClientConfig): string {
  return JSON.stringify([
    config.host,
    config.port,
    config.database,
    config.user,
    config.password,
    config.connectionTimeoutMillis,
    config.statement_timeout,
  ]);
}

function retire(pool: Pool): void {
  const ending = pool.end().catch((cause: unknown) => {
    log.warn("[main-ipc-pg-pool] pool.end failed (non-fatal)", cause);
  });
  retiring.add(ending);
  void ending.finally(() => retiring.delete(ending));
}

function ensureConnectionSubscription(): void {
  if (unsubscribeConnection !== null) return;
  unsubscribeConnection = subscribeDbConnection(() => {
    // Any handoff (compose up/reuse after a restart, compose down) may mean
    // the server behind every idle connection is gone. Start clean.
    resetMainIpcPgPool();
  });
}

function poolFor(config: ClientConfig): Pool {
  const key = poolKey(config);
  if (live !== null && live.key === key) return live.pool;
  if (live !== null) retire(live.pool);
  ensureConnectionSubscription();
  const pool = new Pool({
    ...config,
    max: MAIN_IPC_PG_POOL_MAX,
    idleTimeoutMillis: MAIN_IPC_PG_POOL_IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  // An idle client whose server went away emits here; without a listener the
  // pool would rethrow it as an uncaught error. The pool already drops it.
  pool.on("error", (cause) => {
    log.warn("[main-ipc-pg-pool] idle client error (dropped)", cause);
  });
  live = { key, pool };
  return pool;
}

function trackTxStatus(client: Client): void {
  if (txStatus.has(client)) return;
  // A client is only ever handed out idle: freshly connected, or released
  // with status I.
  txStatus.set(client, "I");
  client.connection.on("readyForQuery", (msg: unknown) => {
    if (typeof msg === "object" && msg !== null && "status" in msg) {
      const status = msg.status;
      if (typeof status === "string") txStatus.set(client, status);
    }
  });
}

async function runWithPooledClient<R>(
  clientConfig: ClientConfig,
  call: MainDbClientCall<R>,
  fn: (client: Client) => Promise<R>,
): Promise<R> {
  let pooled: PoolClient;
  try {
    pooled = await poolFor(clientConfig).connect();
  } catch (cause) {
    log.warn(`${call.logPrefix} client.connect failed`, cause);
    return call.onConnectFailed(cause);
  }
  if (!(pooled instanceof Client)) {
    pooled.release(true);
    const cause = new Error("pool returned a non-Client");
    log.warn(`${call.logPrefix} client.connect failed`, cause);
    return call.onConnectFailed(cause);
  }
  const client = pooled;
  trackTxStatus(client);
  let threw = true;
  try {
    const result = await nestedScope.run(true, () => fn(client));
    threw = false;
    return result;
  } finally {
    const idle = txStatus.get(client) === "I";
    try {
      // `true` destroys the connection (the server rolls back anything open).
      pooled.release(threw || !idle ? true : undefined);
    } catch (cause) {
      log.warn(`${call.logPrefix} client release failed (non-fatal)`, cause);
    }
  }
}

// `withRuntimeDbClient` does not import this module (see its header): the
// seam installs itself there on load, so the control-plane reads follow the
// same switch as every other wrapper.
installRuntimeDbClientRunner(runWithMainDbClient);

/** Retire the live pool (if any). New callers get a fresh pool. */
export function resetMainIpcPgPool(): void {
  const current = live;
  live = null;
  if (current !== null) retire(current.pool);
}

/**
 * Close the pool and wait for every retiring pool to finish. Checked-out
 * clients are released by their callers first, so an in-flight transaction
 * completes on its own connection. Used by the ordered quit, before Compose
 * stops Postgres.
 */
export async function closeMainIpcPgPool(): Promise<void> {
  resetMainIpcPgPool();
  if (unsubscribeConnection !== null) {
    unsubscribeConnection();
    unsubscribeConnection = null;
  }
  await Promise.all([...retiring]);
}

/** Sanitised numbers for logs and tests; never config or credentials. */
export function mainIpcPgPoolStats(): {
  readonly enabled: boolean;
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
} {
  const pool = live?.pool;
  return {
    enabled: mainIpcPgPoolEnabled(),
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
  };
}
