/**
 * Integration: the columns the DESKTOP APP's preparation projection reads.
 *
 * The renderer-facing query lives in `vex-app/src/main/database/
 * compaction-preparation-db.ts`, which is unit-tested with a mocked `pg` — so
 * nothing there ever proves the column NAMES exist. A typo would compile, pass
 * that suite, and break the apply button only in production. This test closes
 * exactly that gap against real Postgres, and nothing more: it is a schema
 * contract check, not a re-implementation of the handler.
 *
 * It also pins the negative half of the allowlist: the prose columns DO exist
 * on the table (so "we don't select them" is a decision, not an accident) and
 * are deliberately absent from the projection list above.
 */

import { describe, expect, it } from "vitest";
import { query } from "@vex-agent/db/client.js";

/** Mirrors the SELECT list in `compaction-preparation-db.ts`, verbatim. */
const APP_PROJECTION_COLUMNS = [
  "status",
  "summary_status",
  "chunks_status",
  "summary_attempt_count",
  "summary_max_attempts",
  "chunks_attempt_count",
  "chunks_max_attempts",
  "summary_output", // read ONLY as `IS NOT NULL` → the `hasSummary` boolean
  "apply_source",
  "apply_requested_at",
  "applied_at",
  "created_at",
  "completed_at",
  "session_id",
  "id",
] as const;

/** Never projected: a verbatim transcript copy, and free-text provider prose. */
const NEVER_PROJECTED = [
  "corpus_text",
  "summary_last_error",
  "chunks_last_error",
  "last_error",
] as const;

async function columnNames(): Promise<Set<string>> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'compaction_preparations'`,
  );
  return new Set(rows.map((r) => r.column_name));
}

describe("desktop-app preparation projection (integration)", () => {
  it("every column the app selects exists on the table", async () => {
    const present = await columnNames();
    const missing = APP_PROJECTION_COLUMNS.filter((c) => !present.has(c));
    expect(missing).toEqual([]);
  });

  it("the prose columns exist and are deliberately left out of the projection", async () => {
    const present = await columnNames();
    for (const column of NEVER_PROJECTED) {
      expect(present.has(column)).toBe(true);
      expect(APP_PROJECTION_COLUMNS).not.toContain(column);
    }
  });
});
