import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../vex-agent/db/migrations/110_lighter_withdrawal_predicted_execution_timestamp.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Lighter withdrawal predicted execution timestamp migration", () => {
  it("widens provider millisecond timestamps without rewriting their value", () => {
    expect(sql).toMatch(/ALTER TABLE lighter_withdrawal_intents/i);
    expect(sql).toMatch(/ALTER COLUMN predicted_execution_time_ms TYPE BIGINT/i);
    expect(sql).toMatch(/USING predicted_execution_time_ms::BIGINT/i);
  });
});
