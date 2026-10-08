/**
 * Long-memory DB helper — read-only list of the GLOBAL long-term memory
 * store (memory-system S9 rewire; rows live in the `knowledge_entries`
 * table — the table name is engine-internal and never surfaces in the DTO).
 *
 * Mirrors `usage-db.ts`: own `pg.Client` per call, no `@vex-agent/db/repos/*`
 * import. Long-term memory is a global store (no session scope), so this is
 * NOT app-scoped.
 *
 * SANITIZATION: the SELECT deliberately omits `content_md`, `source_refs`,
 * `content_hash`, `embedding`, `embedding_model`, and `embedding_dim`. Only
 * short-form metadata leaves the main process.
 */

import type { Client } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  LONG_MEMORY_MATURITY_STATES,
  LONG_MEMORY_SOURCES,
  type LongMemoryEntryDto,
  type LongMemoryListInput,
  type LongMemoryListResult,
  type LongMemoryMaturityStateDto,
  type LongMemorySourceDto,
  type LongMemoryStatusDto,
} from "@shared/schemas/long-memory.js";
import { buildPoolConfig } from "./db-config.js";
import { runWithMainDbClient } from "./main-ipc-pg-pool.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "memory",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  log.warn(`[long-memory-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "memory",
    message: "Unable to load memory.",
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
    log.warn("[long-memory-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  // Fresh client per call, or a pooled one when MAIN_IPC_PG_POOL is on
  // (`main-ipc-pg-pool.ts`): same config, timeouts and failure results.
  return runWithMainDbClient(
    cfg,
    {
      logPrefix: "[long-memory-db]",
      timeouts: { connectTimeoutMs: CONNECT_TIMEOUT_MS, statementTimeoutMs: QUERY_TIMEOUT_MS },
      onConnectFailed: () => dbUnavailable(),
    },
    fn,
  );
}

interface LongMemoryRow {
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: string[] | null;
  readonly confidence: number | string | null;
  readonly status: string;
  readonly source: string | null;
  readonly maturity_state: string | null;
  readonly pinned: boolean;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNum(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function coerceSource(raw: string | null): LongMemorySourceDto | null {
  return raw !== null && (LONG_MEMORY_SOURCES as readonly string[]).includes(raw)
    ? (raw as LongMemorySourceDto)
    : null;
}

function coerceMaturityState(
  raw: string | null,
): LongMemoryMaturityStateDto | null {
  return raw !== null &&
    (LONG_MEMORY_MATURITY_STATES as readonly string[]).includes(raw)
    ? (raw as LongMemoryMaturityStateDto)
    : null;
}

function mapRow(r: LongMemoryRow): LongMemoryEntryDto {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    tags: r.tags ?? [],
    confidence: toNum(r.confidence),
    status: r.status as LongMemoryStatusDto,
    source: coerceSource(r.source),
    maturityState: coerceMaturityState(r.maturity_state),
    pinned: r.pinned,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

/**
 * List long-memory entries (newest first), optionally filtered by status.
 * Bounded by `input.limit` (validated + capped in the shared schema).
 */
export async function listLongMemory(
  input: LongMemoryListInput,
): Promise<Result<LongMemoryListResult, VexError>> {
  return withClient(async (client) => {
    try {
      const params: unknown[] = [];
      let whereClause = "";
      if (input.status !== undefined) {
        params.push(input.status);
        whereClause = `WHERE status = $${params.length}`;
      }
      params.push(input.limit);
      const limitParam = params.length;
      const result = await client.query<LongMemoryRow>(
        `SELECT id, kind, title, summary, tags, confidence, status, source,
                maturity_state, pinned, created_at, updated_at
           FROM knowledge_entries
           ${whereClause}
          ORDER BY updated_at DESC, id DESC
          LIMIT $${limitParam}`,
        params,
      );
      return ok(result.rows.map(mapRow));
    } catch (cause) {
      return dbError("listLongMemory query failed", cause);
    }
  });
}
