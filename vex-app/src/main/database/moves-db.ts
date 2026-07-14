/**
 * Moves DB helper — read-only per-session executed-trade activity (move 0.3).
 *
 * Mirrors `portfolio-db.ts`: own `pg.Client` per call, no
 * `@vex-agent/db/repos/*` import. Reads the same local `vex` Postgres the
 * engine writes to, against:
 *
 *   proj_activity(id SERIAL, wallet_address TEXT, trade_side TEXT,
 *                 product_type TEXT, namespace TEXT,
 *                 input_token TEXT, input_amount TEXT, output_token TEXT,
 *                 output_amount TEXT, value_usd NUMERIC, capture_status TEXT,
 *                 instrument_key TEXT, created_at TIMESTAMPTZ, ...)
 *
 * `proj_activity` is success-only BY CONSTRUCTION (the engine writes an
 * activity row only after a capture succeeds), so there is NO `success = true`
 * predicate.
 *
 * STRICT PER-SESSION attribution: the read INNER JOINs `protocol_executions`
 * on `proj_activity.execution_id = protocol_executions.id` and filters
 * `protocol_executions.session_id = $2`, so ONLY moves whose originating
 * execution was recorded under THIS session appear. Rows with a NULL
 * `execution_id`, or an execution owned by another session / carrying a NULL
 * `session_id` (historical or externally-detected activity), are excluded
 * (fail-closed; externally-detected deposits intentionally drop out of the
 * session view). `protocol_executions.session_id` is written by the engine's
 * `recordExecution` from the same app session id used for the wallet scope
 * (renderer sends session id → engine turn `context.sessionId` → capture), so
 * the JOIN key and the wallet scope share one id space.
 *
 * SECURITY (non-negotiable):
 *  - The SELECT carries `WHERE wallet_address = ANY($1::text[])` with a bound,
 *    finite array resolved from the session's wallet scope, AND
 *    `protocol_executions.session_id = $2` via the INNER JOIN. The wallet
 *    filter is retained as defense-in-depth and is never omitted.
 *  - addresses.length === 0 → return the EMPTY DTO (`ok([])`) BEFORE any SQL
 *    (empty session scope, or a session with no selected wallets). Fail closed.
 *  - addresses are resolved SERVER-SIDE (session scope); a renderer-supplied
 *    address is never accepted.
 *  - join key is the raw ADDRESS string — DO NOT lowercase (the engine stores
 *    raw checksum/base58 addresses).
 *  - The SELECT projects ONLY bounded, renderer-safe columns. It NEVER selects
 *    `params`, `result`, `trade_capture`, `meta`, or the raw `external_refs`
 *    JSONB. The single sanctioned extraction from `external_refs` is the
 *    on-chain tx reference scalar (`->>'txHash'` for EVM, `->>'signature'`
 *    for Solana) — public on-chain data powering the renderer's
 *    block-explorer deep links; never the whole blob.
 *  - `wallet_address` IS projected (`walletAddress`) so the renderer can build
 *    an account block-explorer link for rows without a tx ref (HyperCore). This
 *    is the session's OWN wallet, already server-side scoped by the wallet
 *    filter — it is not a widening of the read. It is still NEVER logged (see
 *    below).
 *  - logging records sessionId + the row COUNT only; NEVER raw addresses,
 *    USD figures, token symbols, or tx hashes.
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  MOVES_MAX,
  type MovesDto,
} from "@shared/schemas/portfolio-moves.js";
import { getSessionWalletScope } from "./sessions-db.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

// `correlationId` intentionally omitted; `registerHandler` stamps
// `ctx.requestId` downstream. Domain is `portfolio` (MOVES reuses the
// portfolio VexDomain — no separate `moves` domain). Mirrors `portfolio-db.ts`.
function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[moves-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "portfolio",
    message: "Unable to load moves.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[moves-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

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
  } catch (cause) {
    log.warn("[moves-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[moves-db] client.end failed (non-fatal)", cause);
    }
  }
}

interface MoveRow {
  readonly id: number | string;
  readonly trade_side: string | null;
  readonly product_type: string | null;
  readonly venue: string | null;
  readonly input_token: string | null;
  readonly input_amount: string | null;
  readonly output_token: string | null;
  readonly output_amount: string | null;
  readonly value_usd: number | string | null;
  readonly capture_status: string | null;
  readonly instrument_key: string | null;
  readonly chain: string;
  readonly tx_ref: string | null;
  readonly wallet_address: string | null;
  readonly created_at: string | Date;
}

/**
 * `value_usd` (`NUMERIC`) comes back from `pg` as a string or number. Coerce
 * to a finite JS number, preserving the "absent" distinction as `null` (no
 * fabricated 0 — the column is genuinely nullable when the engine could not
 * price the trade).
 */
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** TIMESTAMPTZ comes back as a Date (node-postgres) or string; normalise to ISO. */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Resolve the session's wallet address allow-list (raw strings, NO lowercasing
 * so the `proj_activity.wallet_address` filter matches the engine's stored
 * form). A failed scope read propagates as an error (fail closed); an empty
 * scope resolves to `[]` (→ empty DTO before SQL).
 */
async function resolveSessionAddresses(
  sessionId: string,
): Promise<Result<readonly string[], VexError>> {
  const scope = await getSessionWalletScope(sessionId);
  if (!scope.ok) return scope;
  const addrs = [scope.data.evm?.address, scope.data.solana?.address].filter(
    (a): a is string => typeof a === "string",
  );
  return ok([...new Set(addrs)]);
}

/**
 * Read the session's executed-trade MOVES, newest first.
 *
 * Returns the EMPTY DTO (`ok([])`, no SQL issued) when the resolved allow-list
 * is empty. Otherwise selects up to `MOVES_MAX` bounded `proj_activity` rows
 * (activity rows / fills, NOT executions) that are BOTH scoped to the session's
 * wallets AND attributed to this session via an INNER JOIN to
 * `protocol_executions` (`session_id = $2`); newest first.
 */
export async function getMovesForSession(
  sessionId: string,
): Promise<Result<MovesDto, VexError>> {
  const resolved = await resolveSessionAddresses(sessionId);
  if (!resolved.ok) return resolved;
  const addresses = resolved.data;

  // Fail closed: no wallets → empty moves BEFORE any SQL.
  if (addresses.length === 0) {
    log.info(`[moves-db] getMovesForSession ok session=${sessionId} moves=0 (empty scope)`);
    return ok([]);
  }

  const addrParam = [...addresses];

  return withClient(async (client) => {
    try {
      // STRICT PER-SESSION attribution. INNER JOIN protocol_executions on
      // execution_id and filter session_id = $2:
      //  - the INNER JOIN drops rows with a NULL execution_id (never a session);
      //  - session_id = $2 drops rows whose execution belongs to another
      //    session OR carries a NULL session_id (both comparisons evaluate to
      //    UNKNOWN → excluded). Fail-closed: externally-detected / historical
      //    activity without a matching session execution never leaks in.
      // The wallet_address filter is KEPT as defense-in-depth (never omitted).
      // Columns are qualified with the `a` alias because proj_activity and
      // protocol_executions share `id`, `created_at`, and `external_refs`.
      const result = await client.query<MoveRow>(
        `SELECT a.id,
                a.trade_side,
                a.product_type,
                a.namespace AS venue,
                a.input_token,
                a.input_amount,
                a.output_token,
                a.output_amount,
                a.value_usd,
                a.capture_status,
                a.instrument_key,
                a.chain,
                COALESCE(a.external_refs->>'txHash', a.external_refs->>'signature')
                  AS tx_ref,
                a.wallet_address,
                a.created_at
           FROM proj_activity a
           JOIN protocol_executions e ON e.id = a.execution_id
          WHERE a.wallet_address = ANY($1::text[])
            AND e.session_id = $2
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${MOVES_MAX}`,
        [addrParam, sessionId],
      );

      const moves: MovesDto = result.rows.map((row) => ({
        id: String(row.id),
        tradeSide: row.trade_side,
        productType: row.product_type,
        venue: row.venue,
        inputToken: row.input_token,
        inputAmount: row.input_amount,
        outputToken: row.output_token,
        outputAmount: row.output_amount,
        valueUsd: toNumberOrNull(row.value_usd),
        captureStatus: row.capture_status,
        instrumentKey: row.instrument_key,
        chain: row.chain,
        txRef: row.tx_ref,
        walletAddress: row.wallet_address,
        createdAt: toIso(row.created_at),
      }));

      log.info(
        `[moves-db] getMovesForSession ok session=${sessionId} moves=${moves.length}`,
      );
      return ok(moves);
    } catch (cause) {
      return dbError("getMovesForSession query failed", cause);
    }
  });
}
