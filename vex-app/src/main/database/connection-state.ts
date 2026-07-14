/**
 * Module-level handoff between the compose lifecycle (writer) and the
 * database migration handler (reader). The pgPort + pgPasswordPath pair
 * is sensitive enough that it MUST stay main-process-only — never
 * crosses the preload boundary, never reaches the renderer.
 *
 * The compose handler calls `setDbConnection(...)` after a successful
 * `running` / `reused` result. The database handler calls
 * `getDbConnection()` to derive a per-call `pg.Pool` (no shared global
 * pool — migrate runs are short-lived and the pool is closed after).
 */

export interface DbConnection {
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
