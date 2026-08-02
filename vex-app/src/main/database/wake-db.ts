/**
 * Wake DB helper — main-process reads over `loop_wake_requests`.
 *
 * Mirrors `compaction-db.ts` / `mission-runs-db.ts`: own `pg.Client` per call,
 * no `@vex-agent/db/repos/*` import.
 *
 *   - `probeLoopWakeReady()` proves Postgres is reachable AND the
 *     `loop_wake_requests` table exists (migrations applied) — not merely that
 *     `VEX_DB_URL` resolves — so the supervisor keeps the wake executor idle
 *     rather than spamming claim errors before the DB is ready.
 *   - `getPendingWakeForSession()` is the read behind `runtime.getState`'s
 *     `pausedWake`: the "Vex is sleeping until…" banner. Display only — it
 *     never influences wake or defer semantics.
 */

import { Client, type ClientConfig } from "pg";
import {
  PAUSED_WAKE_REASON_MAX_CHARS,
  PAUSED_WAKE_WATCH_SUMMARY_MAX_CHARS,
  type RuntimePausedWake,
} from "@shared/schemas/runtime.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/**
 * `true` only when Postgres is reachable AND `public.loop_wake_requests`
 * exists (migrations ran). Any failure (config absent, connect error, table
 * missing, query error) → `false`, so the supervisor keeps the wake executor
 * idle rather than starting it against a not-yet-migrated DB.
 */
export async function probeLoopWakeReady(): Promise<boolean> {
  const client = await openClient();
  if (client === null) return false;
  try {
    const r = await client.query<{ reg: string | null }>(
      `SELECT to_regclass('public.loop_wake_requests') AS reg`,
    );
    return r.rows[0]?.reg != null;
  } catch (cause) {
    log.warn("[wake-db] probeLoopWakeReady query failed", cause);
    return false;
  } finally {
    await closeClient(client);
  }
}

// ── Pending wake read (runtime.getState → pausedWake) ───────────────

interface PendingWakeRow {
  due_at: string | Date;
  reason: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * The session's pending wake, shaped for display, or `null` when the session
 * is not sleeping.
 *
 * DEGRADES TO `null` on every failure — missing config, connect error, query
 * error, unreadable row. This is a decoration on `runtime.getState`, whose
 * primary job is gating the pause/stop/resume controls; a wake-table hiccup
 * must not turn that whole result into an error. "No banner" is the correct
 * fallback for "we could not read whether it is sleeping".
 *
 * Reads three named columns, never `SELECT *`: `payload` is protocol-owned
 * JSONB and only its condition TYPE names are summarised, so no variant field
 * (threshold, token id, address) can become an accidental renderer contract.
 */
export async function getPendingWakeForSession(
  sessionId: string,
): Promise<RuntimePausedWake | null> {
  const client = await openClient();
  if (client === null) return null;
  try {
    const result = await client.query<PendingWakeRow>(
      `SELECT due_at, reason, payload
         FROM loop_wake_requests
        WHERE session_id = $1 AND status = 'pending'
        ORDER BY due_at ASC
        LIMIT 1`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapPendingWakeRow(row);
  } catch (cause) {
    log.warn("[wake-db] getPendingWakeForSession query failed", cause);
    return null;
  } finally {
    await closeClient(client);
  }
}

function mapPendingWakeRow(row: PendingWakeRow): RuntimePausedWake | null {
  const dueAt = row.due_at instanceof Date ? row.due_at : new Date(row.due_at);
  // A row whose due time cannot be read is not a sleeping run we can describe;
  // the banner's whole content is the countdown to this instant.
  if (Number.isNaN(dueAt.getTime())) {
    log.warn("[wake-db] pending wake row has an unreadable due_at");
    return null;
  }
  return {
    dueAt: dueAt.toISOString(),
    reason: boundedText(row.reason, PAUSED_WAKE_REASON_MAX_CHARS),
    watchSummary: summariseWatch(row.payload),
  };
}

/**
 * Agent-authored text, bounded to what the DTO accepts. Over-long text is
 * DROPPED rather than truncated: the engine's own `loop_defer` bound is the
 * same number, so anything longer did not come from the sanctioned writer and
 * a half-sentence is worse than no sentence.
 */
function boundedText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Distinct watch condition TYPE names, in first-seen order — "price, balance".
 * `null` for a plain timed defer, an unrecognisable payload, or types that do
 * not survive the DTO bound.
 */
function summariseWatch(payload: Record<string, unknown> | null): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const conditions = payload.conditions;
  if (!Array.isArray(conditions)) return null;

  const types: string[] = [];
  for (const condition of conditions) {
    if (typeof condition !== "object" || condition === null) continue;
    const type = (condition as { type?: unknown }).type;
    if (typeof type !== "string") continue;
    const trimmed = type.trim();
    if (trimmed.length === 0 || types.includes(trimmed)) continue;
    types.push(trimmed);
  }
  return boundedText(
    types.join(", "),
    PAUSED_WAKE_WATCH_SUMMARY_MAX_CHARS,
  );
}

// ── Client lifecycle ────────────────────────────────────────────────

/** Connected client, or `null` when config is absent or the connect failed. */
async function openClient(): Promise<Client | null> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[wake-db] buildPoolConfig threw", cause);
    return null;
  }
  if (cfg === null) return null;

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
    return client;
  } catch (cause) {
    log.warn("[wake-db] client.connect failed", cause);
    return null;
  }
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.end();
  } catch (cause) {
    log.warn("[wake-db] client.end failed (non-fatal)", cause);
  }
}
