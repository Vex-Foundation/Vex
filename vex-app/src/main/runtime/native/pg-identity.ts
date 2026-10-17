/**
 * Ownership proof for the native cluster (D6), run on every connect the
 * supervisor makes: authenticate as `vex` over loopback SCRAM and require
 *
 *   current_database() = 'vex', current_user = 'vex', and
 *   (SELECT system_identifier FROM pg_control_system()) = the value recorded
 *   in runtime-state.json at bootstrap.
 *
 * Any mismatch is `foreign_listener`. This replaces the Docker branch of
 * `compose/pg-listener-identity.ts` (the `docker exec` corroboration); the
 * pure error classification there is reused as is, so a socket errno is never
 * mistaken for a SQLSTATE here either.
 *
 * The password is read by the caller from this install's own secret file and
 * never appears in a message.
 */

import pg from "pg";
import { classifyPgConnectError } from "../../compose/pg-listener-identity.js";
import { LOOPBACK_DB_HOST } from "../../database/connection-state.js";

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

/** Run `body` on a short-lived client; never throws for a connection outcome. */
export async function withPgClient<T>(
  target: PgConnectTarget,
  body: (client: pg.Client) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
  const client = new pg.Client({
    host: LOOPBACK_DB_HOST,
    port: target.port,
    user: VEX_ROLE,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: CONNECT_TIMEOUT_MS,
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

export function describePgError(error: unknown): Exclude<PgIdentityResult, { readonly kind: "usable" }> {
  const evidence = classifyPgConnectError(error);
  switch (evidence.kind) {
    case "auth_rejected":
      // Our credentials reached a server that has no `vex` database:
      // whatever that is, it is not this install's cluster.
      if (evidence.sqlState === "3D000") {
        return { kind: "foreign_listener", detail: "the server on this port has no vex database" };
      }
      return {
        kind: "auth_rejected",
        detail: `the server rejected this install's credentials (SQLSTATE ${evidence.sqlState})`,
      };
    case "server_transient":
    case "no_usable_answer":
      return { kind: "unreachable", detail: evidence.detail };
    case "identity_ok":
    case "identity_mismatch":
      // classifyPgConnectError never produces these for an error.
      return { kind: "unreachable", detail: evidence.kind };
  }
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
