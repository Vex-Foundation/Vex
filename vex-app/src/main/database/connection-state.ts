/**
 * Module-level handoff between the local runtime host (writer) and the
 * database migration handler (reader). The host + pgPort + pgPasswordPath
 * triple is sensitive enough that it MUST stay main-process-only — never
 * crosses the preload boundary, never reaches the renderer.
 *
 * The runtime host (`runtime/runtime-host.ts`) calls `setDbConnection(...)`
 * after a `running` / `reused` start, and the e2e door in an unpackaged e2e
 * run. The database handler calls `getDbConnection()` to derive a per-call
 * `pg.Pool` (no shared global pool — migrate runs are short-lived and the
 * pool is closed after).
 */

/**
 * Where every local database Vex runs listens: the native runtime listens on
 * loopback TCP (one transport on every OS; node-postgres cannot use AF_UNIX
 * on Windows).
 */
export const LOOPBACK_DB_HOST = "127.0.0.1";

export interface DbConnection {
  /** The address the server listens on; carried so no reader hard-codes it. */
  readonly host: string;
  readonly pgPort: number;
  readonly pgPasswordPath: string;
}

let current: DbConnection | null = null;
type DbConnectionListener = (value: DbConnection | null, previous: DbConnection | null) => void;
const listeners = new Set<DbConnectionListener>();

export function setDbConnection(value: DbConnection | null): void {
  const previous = current;
  current = value;
  for (const listener of listeners) {
    try {
      listener(value, previous);
    } catch {
      // Connection handoff must remain available even if an optional observer
      // (for example policy-cache hydration) fails unexpectedly.
    }
  }
}

export function getDbConnection(): DbConnection | null {
  return current;
}

/** Subscribe to main-only connection transitions; cleanup is idempotent. */
export function subscribeDbConnection(listener: DbConnectionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
