/**
 * Integration test fixtures — helpers that hit the real Postgres instance
 * started by `globalSetup.ts`.
 *
 * Scope: table reset, session/message/memory seeding, deterministic vector
 * generation, and a live `embedQuery` delegate. Nothing here is safe against
 * concurrent tests — the integration suite runs single-threaded by design.
 */

import { createHash, randomUUID } from "node:crypto";

import { execute, query } from "@vex-agent/db/client.js";
import { createSession } from "@vex-agent/db/repos/sessions.js";
import type { Message, MessageMetadata } from "@vex-agent/db/repos/messages.js";
import { embedQuery } from "@vex-agent/embeddings/client.js";

/**
 * Wipe every non-schema table + reset identity sequences. Keeps
 * migration ledgers so migrations don't re-run per test.
 */
export async function resetDb(): Promise<void> {
  const rows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('schema_version', 'schema_migration_files', 'schema_migration_recovery_files', 'schema_migration_baseline')`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await execute(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Create a session and return its id.
 */
export async function makeSession(
  id: string = randomUUID(),
): Promise<string> {
  await createSession(id);
  return id;
}

export interface InsertMessageOptions {
  toolCallId?: string;
  toolCalls?: Message["toolCalls"];
  metadata?: MessageMetadata;
  /** Deterministic timestamp override — ISO string. Defaults to `new Date().toISOString()`. */
  timestamp?: string;
}

/**
 * Insert a live message and return its DB id. Mirrors `addMessage` but uses
 * `RETURNING id` so callers can thread the id into subsequent fixtures
 * (e.g. `forkToolMessageToArchive(id, ...)` or cutoff values for
 * `archivePrefix`).
 */
export async function insertMessage(
  sessionId: string,
  role: Message["role"],
  content: string,
  opts: InsertMessageOptions = {},
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO messages
       (session_id, role, content, tool_call_id, tool_calls, created_at,
        source, message_type, visibility, origin_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      sessionId,
      role,
      content,
      opts.toolCallId ?? null,
      opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
      opts.timestamp ?? new Date().toISOString(),
      opts.metadata?.source ?? null,
      opts.metadata?.messageType ?? null,
      opts.metadata?.visibility ?? null,
      opts.metadata?.originSessionId ?? null,
    ],
  );
  await execute(
    "UPDATE sessions SET message_count = message_count + 1 WHERE id = $1",
    [sessionId],
  );
  if (rows.length === 0) throw new Error("insertMessage: no row returned");
  return rows[0].id;
}

/**
 * Deterministic pseudo-random unit vector of the requested dim, seeded by an
 * arbitrary string. Unit-normalized so cosine similarity in `recallTopK`
 * behaves predictably across seeds.
 */
export function randVector(dim: number, seed = "seed"): number[] {
  const hash = createHash("sha256").update(seed).digest();
  const out = new Array<number>(dim);
  let h = 0;
  for (let i = 0; i < dim; i++) {
    const byte = hash[i % hash.length];
    h = (h * 1103515245 + byte + i) >>> 0;
    out[i] = ((h & 0xffff) / 0xffff) * 2 - 1;
  }
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] = out[i] / norm;
  return out;
}

/**
 * Stable legacy hash helper retained for old fixtures that need deterministic
 * row-collision data.
 */
export function episodeHash(kind: string, summaryText: string): string {
  return createHash("sha256").update(kind).update("\n").update(summaryText).digest("hex");
}

/** Live embedding call — fails loudly if the endpoint is down. */
export async function embedText(
  text: string,
): Promise<{ embedding: number[]; providerModel: string }> {
  return embedQuery(text);
}
