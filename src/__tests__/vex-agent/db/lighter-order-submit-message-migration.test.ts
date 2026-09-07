import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../vex-agent/db/migrations/111_lighter_order_submit_message.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Lighter order submit message migration", () => {
  it("preserves provider message syntax while retaining lifecycle constraints", () => {
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_submit_lifecycle_shape/i,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT lighter_order_execution_intents_submit_lifecycle_shape/i,
    );
    expect(sql).not.toMatch(/length\(submit_message\)/i);
    expect(sql).not.toMatch(/submit_message\s*!~/i);
    expect(sql).toMatch(/execution_state = 'api_accepted'/i);
    expect(sql).toMatch(/api_accepted_at IS NOT NULL/i);
  });
});
