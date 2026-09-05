/**
 * Postgres connection mechanics for the published-port identity probe.
 * Replaces the previous `docker compose exec pg_isready` path
 * (codex turn 7) which hung silently when the docker exec channel was
 * unhealthy or the project name disagreed with the running stack.
 *
 * This module owns ONLY the connection: open a `pg.Client` on the port
 * this install published, with this install's credentials, and report
 * what answered. The vocabulary and the classification policy live in
 * `pg-listener-identity.ts`; the poll loop lives in `health.ts`.
 *
 * `pg_isready`-style liveness is deliberately not the contract any more:
 * a listener being alive says nothing about WHOSE database it is (see
 * the shadowed-port note in `pg-listener-identity.ts`). The probe
 * authenticates and asks the server to name the database and role it
 * gave us.
 *
 * Reading the secret here is safe - main process owns the file at
 * `pgPasswordPath` (mode 0o600) and never forwards plaintext to the
 * renderer, to a log line, or into an error message.
 */

import { promises as fs } from "node:fs";
import pg from "pg";
import {
  classifyPgConnectError,
  type PgConnectEvidence,
} from "./pg-listener-identity.js";

const { Client } = pg;

const CONNECTION_TIMEOUT_MS = 5_000;

export const DEFAULT_PG_DATABASE = "vex";
export const DEFAULT_PG_USER = "vex";

export interface PgProbeOptions {
  readonly host?: string;
  readonly port: number;
  readonly database?: string;
  readonly user?: string;
  readonly pgPasswordPath: string;
  readonly signal?: AbortSignal;
}

interface IdentityRow {
  readonly db?: unknown;
  readonly usr?: unknown;
}

async function readPassword(path: string): Promise<string> {
  const raw = await fs.readFile(path, "utf8");
  return raw.trim();
}

/**
 * Connect to the published port as this install and report what
 * answered. Never throws for a connection outcome; a failure to read
 * this install's own secret is reported as `no_usable_answer` with the
 * filesystem cause (never the secret's content).
 */
export async function pgConnectProbe(
  options: PgProbeOptions
): Promise<PgConnectEvidence> {
  if (options.signal?.aborted) {
    return { kind: "no_usable_answer", detail: "aborted" };
  }
  const database = options.database ?? DEFAULT_PG_DATABASE;
  const user = options.user ?? DEFAULT_PG_USER;

  let password: string;
  try {
    password = await readPassword(options.pgPasswordPath);
  } catch (err: unknown) {
    return {
      kind: "no_usable_answer",
      detail: `cannot read this install's pg password file: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    };
  }
  if (password.length === 0) {
    return {
      kind: "no_usable_answer",
      detail: "this install's pg password file is empty",
    };
  }

  const client = new Client({
    host: options.host ?? "127.0.0.1",
    port: options.port,
    database,
    user,
    password,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: CONNECTION_TIMEOUT_MS,
    query_timeout: CONNECTION_TIMEOUT_MS,
  });

  // Hard-abort plumbing: pg.Client doesn't natively respect AbortSignal,
  // so we race against an abort/timeout that calls client.end().
  const ac = new AbortController();
  const linked = (): void => ac.abort();
  options.signal?.addEventListener("abort", linked, { once: true });
  const timer = setTimeout(() => ac.abort(), CONNECTION_TIMEOUT_MS + 500);

  try {
    await client.connect();
    if (ac.signal.aborted) {
      return { kind: "no_usable_answer", detail: "probe aborted before query" };
    }
    // Authentication already proved possession of this install's secret.
    // The server still has to name the database and role it handed us:
    // a pooler or a differently-provisioned server can authenticate and
    // then route somewhere else entirely.
    const result = await client.query(
      "select current_database() as db, current_user as usr"
    );
    const row = result.rows[0] as IdentityRow | undefined;
    if (row === undefined) {
      return {
        kind: "no_usable_answer",
        detail: "server returned no row for the identity query",
      };
    }
    if (row.db !== database || row.usr !== user) {
      return {
        kind: "identity_mismatch",
        detail: `server reports database ${String(row.db)} and role ${String(
          row.usr
        )}; this install uses ${database}/${user}`,
      };
    }
    return { kind: "identity_ok" };
  } catch (err: unknown) {
    return classifyPgConnectError(err);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", linked);
    // Fire-and-forget client.end(). When the server has closed the
    // socket from its side (e.g. during a postgres restart cycle) the
    // graceful close handshake can hang indefinitely; awaiting it would
    // block the probe loop after we already have the answer we needed.
    // The socket gets cleaned up by the OS either way.
    void client.end().catch(() => {
      // best-effort
    });
  }
}
