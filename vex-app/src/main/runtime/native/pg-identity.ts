/**
 * Ownership proof for the native cluster (D6), run on every connect the
 * supervisor makes: authenticate as `vex` over loopback SCRAM and require
 *
 *   current_database() = 'vex', current_user = 'vex', and
 *   (SELECT system_identifier FROM pg_control_system()) = the value recorded
 *   in runtime-state.json at bootstrap.
 *
 * Any mismatch is `foreign_listener`. This is the native replacement for the
 * container corroboration in the compose identity probe, and deliberately
 * imports nothing from that module, which is deleted with the compose stack.
 *
 * The password is read by the caller from this install's own secret file and
 * never appears in a message.
 */

import pg from "pg";
import { LOOPBACK_DB_HOST } from "../../database/connection-state.js";
import { isDiskFullText } from "./postgres-facts.js";

export const VEX_DATABASE = "vex";
export const VEX_ROLE = "vex";

const CONNECT_TIMEOUT_MS = 5_000;

export interface PgConnectTarget {
  readonly port: number;
  readonly password: string;
  readonly database: string;
}

/**
 * - `usable`: all three facts match.
 * - `foreign_listener`: a Postgres answered as this install and is provably
 *   another cluster or another database.
 * - `auth_rejected`: the server refused this install's secret. On a port our
 *   own postmaster just bound, that is our cluster holding an older password,
 *   not a neighbour, so the caller reports it as a failure rather than an
 *   accusation.
 * - `unreachable`: nothing usable answered yet; retryable.
 */
export type PgIdentityResult =
  | { readonly kind: "usable" }
  | { readonly kind: "foreign_listener"; readonly detail: string }
  | { readonly kind: "auth_rejected"; readonly detail: string }
  | { readonly kind: "unreachable"; readonly detail: string };

/**
 * Run `body` on a short-lived client; never throws for a connection outcome.
 * Queries share the connect timeout unless `queryTimeoutMs` says otherwise: a
 * probe should answer in seconds, while the one-time CREATE DATABASE copies
 * template1 to disk and can take longer on a slow disk.
 */
export async function withPgClient<T>(
  target: PgConnectTarget,
  body: (client: pg.Client) => Promise<T>,
  options: { readonly queryTimeoutMs?: number } = {},
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
  const client = new pg.Client({
    host: LOOPBACK_DB_HOST,
    port: target.port,
    user: VEX_ROLE,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: options.queryTimeoutMs ?? CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return { ok: true, value: await body(client) };
  } catch (error: unknown) {
    return { ok: false, error };
  } finally {
    // Not awaited: a server that closed the socket first can leave the
    // graceful close pending, and the answer is already in hand.
    void client.end().catch(() => {});
  }
}

/**
 * The SQLSTATE of an error the SERVER sent, or null for a socket error.
 * node-postgres puts both in `code` (`28P01` and `EPIPE` alike); only a
 * server error carries `severity` ("FATAL", "ERROR", ...).
 */
function serverSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  if (typeof severity !== "string" || severity.length === 0) return null;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * The server ran out of disk: SQLSTATE 53100 (`disk_full`, what Postgres maps
 * ENOSPC to), or a message carrying the ENOSPC text. Measured on PG 18.6: an
 * INSERT on a full volume is answered `PANIC 53100 could not write to file
 * "pg_wal/xlogtemp.55629": No space left on device`.
 */
export function isDiskFullPgError(error: unknown): boolean {
  if (serverSqlState(error) === "53100") return true;
  return error instanceof Error && isDiskFullText(error.message);
}

/**
 * The `vex` database already exists: `42P04` (duplicate_database), or `23505`
 * on `pg_database_datname_index`, which is what a CREATE DATABASE racing an
 * uncommitted one gets once the first commits. Either way the database the
 * bootstrap wanted is there, so creating it is done.
 */
export function isDuplicateDatabaseError(error: unknown): boolean {
  const state = serverSqlState(error);
  if (state === "42P04") return true;
  if (state !== "23505" || typeof error !== "object" || error === null) return false;
  return (error as { constraint?: unknown }).constraint === "pg_database_datname_index";
}

export function describePgError(error: unknown): Exclude<PgIdentityResult, { readonly kind: "usable" }> {
  const message = error instanceof Error ? error.message : "unknown error";
  const state = serverSqlState(error);
  // Our credentials reached a server that has no `vex` database: whatever
  // that is, it is not this install's cluster.
  if (state === "3D000") return { kind: "foreign_listener", detail: "the server on this port has no vex database" };
  if (state === "28000" || state === "28P01") {
    return { kind: "auth_rejected", detail: `the server rejected this install's credentials (SQLSTATE ${state})` };
  }
  // Starting up, too many connections, a refused or closed socket: retryable.
  return { kind: "unreachable", detail: state === null ? message : `SQLSTATE ${state}: ${message}` };
}

interface IdentityRow {
  readonly db: unknown;
  readonly usr: unknown;
  readonly sysid: unknown;
}

export async function checkPgIdentity(
  port: number,
  password: string,
  recordedSystemIdentifier: string,
): Promise<PgIdentityResult> {
  const answer = await withPgClient({ port, password, database: VEX_DATABASE }, async (client) => {
    const result = await client.query<IdentityRow>(
      "SELECT current_database() AS db, current_user AS usr, "
        + "(SELECT system_identifier::text FROM pg_control_system()) AS sysid",
    );
    return result.rows[0];
  });
  if (!answer.ok) return describePgError(answer.error);
  const row = answer.value;
  if (row === undefined) return { kind: "unreachable", detail: "the identity query returned no row" };
  if (row.db !== VEX_DATABASE || row.usr !== VEX_ROLE) {
    return {
      kind: "foreign_listener",
      detail: `the server reports database ${String(row.db)} and role ${String(row.usr)}`,
    };
  }
  if (row.sysid !== recordedSystemIdentifier) {
    return {
      kind: "foreign_listener",
      detail: `the server's system_identifier ${String(row.sysid)} is not this install's ${recordedSystemIdentifier}`,
    };
  }
  return { kind: "usable" };
}
