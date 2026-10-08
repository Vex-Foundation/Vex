/**
 * Shared connection + error helpers for the bug-reports DB repository.
 *
 * vex-app deliberately uses its own pg connections so the GUI build stays
 * decoupled from the engine (`src/vex-agent`) module graph (mirrors the
 * pattern in `sessions-db.ts` and `dim-lock.ts`).
 *
 * Connection lifecycle: each public function opens its own `pg.Client`
 * (single-shot) through `buildPoolConfig()` and closes it in `finally`. No
 * pool is kept around — these calls are infrequent, never on a hot path,
 * and the explicit lifecycle keeps connection leaks impossible to reach.
 *
 * `withClient` is the single connection wrapper; `BugReportsDbUnavailableError`
 * is single-sourced here so the create / read / upload-attempt functions all
 * fail identically when compose state is missing.
 */

import type { Client } from "pg";
import { buildPoolConfig } from "../db-config.js";
import { runWithMainDbClient } from "../main-ipc-pg-pool.js";
import { log } from "../../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * Bug-reports DB unavailable. Distinct from a transient query failure —
 * thrown when compose hasn't materialised the password file yet, so the
 * support sink simply has nowhere to write. The service layer maps this
 * to `support.persist_failed` (retryable: true) at the IPC boundary.
 */
export class BugReportsDbUnavailableError extends Error {
  constructor() {
    super("Bug reports DB unavailable (compose state missing).");
    this.name = "BugReportsDbUnavailableError";
  }
}

export async function withClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const cfg = await buildPoolConfig();
  if (cfg === null) {
    throw new BugReportsDbUnavailableError();
  }
  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on
  // (`main-ipc-pg-pool.ts`): same config, timeouts and failure results.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[bug-reports-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: (cause): never => {
        throw cause;
      },
    },
    fn,
  );
}
