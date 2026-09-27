import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../vex-agent/db/migrations/172_rename_turn_queue_wait.sql", import.meta.url),
  "utf8",
);
const statements = sql.replace(/^--.*$/gm, "");

describe("turn_run_timings pre-loop setup rename migration", () => {
  it("renames the column in place so existing rows keep their values", () => {
    expect(statements).toMatch(
      /ALTER TABLE turn_run_timings RENAME COLUMN queue_wait_ms TO pre_loop_setup_ms/,
    );
    expect(statements).not.toMatch(/\b(DROP|ADD COLUMN|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("only renames while the old column exists and the new one does not", () => {
    expect(statements).toMatch(/IF EXISTS \(SELECT 1 FROM information_schema\.columns[\s\S]*column_name = 'queue_wait_ms'\)/);
    expect(statements).toMatch(/AND NOT EXISTS \(SELECT 1 FROM information_schema\.columns[\s\S]*column_name = 'pre_loop_setup_ms'\)/);
  });

  it("does not touch migration 171, which is already applied", () => {
    const m171 = readFileSync(
      new URL("../../../vex-agent/db/migrations/171_runtime_timings.sql", import.meta.url),
      "utf8",
    );
    expect(m171).toMatch(/queue_wait_ms\s+INTEGER,/);
  });
});
