/**
 * Vex Agent — shared Postgres pool configuration (Kairos S-4).
 *
 * One place that turns the connection string and the AGENT_DB_* bounds into
 * `pg.PoolConfig` for the engine's two pools:
 *
 *   - the MAIN pool (`client.ts#getPool`), used by every ordinary query;
 *   - the reserved CONTROL pool (`control-pool.ts`), used only for Stop,
 *     lease renewal/release and reconciliation.
 *
 * Both pools carry the same server-side bounds: `statement_timeout` and
 * `idle_in_transaction_session_timeout` are sent as connection startup
 * parameters, so they are the session defaults — a `SET LOCAL` override ends
 * with its transaction and a `RESET ALL` (the migration runner's cleanup)
 * returns to them rather than to "no limit". `connectionTimeoutMillis` bounds
 * the client-side wait for a pooled connection.
 */

import type pg from "pg";
import logger from "@utils/logger.js";
import {
  parseAgentDbBoundsEnv,
  type AgentDbBounds,
} from "../../lib/agent-config.js";

/**
 * Single source of truth for the dev-convenience fallback connection string,
 * used both as the actual `connectionString` and as the input to the redacted
 * warning hint. Embeds dev credentials (`vex:vex`) by necessity — those
 * credentials MUST NOT be emitted to logs/support bundles, so anything derived
 * for logging goes through `redactConnectionString()` first.
 */
export const FALLBACK_DB_URL = "postgresql://vex:vex@localhost:5777/vex_test";

/** The main pool's size; unchanged from the pre-S-4 pool. */
export const MAIN_POOL_MAX = 10;

/** Idle pooled connections are closed after this long (both pools). */
const IDLE_TIMEOUT_MS = 30_000;

export type PoolKind = "main" | "control";

const APPLICATION_NAME: Readonly<Record<PoolKind, string>> = {
  main: "vex-agent",
  control: "vex-agent-control",
};

/**
 * Strip credential material from a Postgres connection string for safe logging.
 * Returns a `host:port/db` descriptor only — never the username, password, or
 * the credential-bearing URL. Parsing failures fall back to the literal
 * `"<unparseable url>"` so we never echo the raw (possibly secret) input.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const host = url.hostname || "<unknown-host>";
    const port = url.port ? `:${url.port}` : "";
    // url.pathname is the leading-slash db path, e.g. "/vex_test".
    const db = url.pathname.replace(/^\//, "") || "<unknown-db>";
    return `${host}${port}/${db}`;
  } catch {
    return "<unparseable url>";
  }
}

/** `VEX_DB_URL`, or the dev fallback when it is unset. */
export function resolveConnectionString(): { connectionString: string; usingFallback: boolean } {
  const explicitUrl = process.env.VEX_DB_URL;
  return explicitUrl
    ? { connectionString: explicitUrl, usingFallback: false }
    : { connectionString: FALLBACK_DB_URL, usingFallback: true };
}

/**
 * Effective DB bounds from the environment. An invalid value never disables
 * a bound: it is logged (key and reason only — never the raw value) and the
 * field's default applies. `loadConfig` in `inference/config.ts` validates
 * the same fields and fails startup on them.
 */
export function readDbBounds(env: NodeJS.ProcessEnv = process.env): AgentDbBounds {
  const parsed = parseAgentDbBoundsEnv(env);
  for (const error of parsed.errors) {
    logger.warn("vex-db.pool.bound_invalid_using_default", {
      key: error.key,
      reason: error.reason,
    });
  }
  return parsed.value;
}

/** The `pg.PoolConfig` for one engine pool. */
export function buildPoolConfig(
  kind: PoolKind,
  connectionString: string,
  bounds: AgentDbBounds,
): pg.PoolConfig {
  return {
    connectionString,
    max: kind === "main" ? MAIN_POOL_MAX : bounds.controlPoolMax,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: bounds.connectionTimeoutMs,
    statement_timeout: bounds.statementTimeoutMs,
    idle_in_transaction_session_timeout: bounds.idleInTransactionTimeoutMs,
    application_name: APPLICATION_NAME[kind],
  };
}
