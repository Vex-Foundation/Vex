import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../vex-agent/db/migrations/112_lighter_order_predicted_execution_timestamp.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Lighter order predicted execution timestamp migration", () => {
  it.each([
    "lighter_order_execution_intents",
    "lighter_order_lifecycle_intents",
  ])("widens provider millisecond timestamps for %s", (tableName) => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${tableName}`, "i"));
  });

  it("preserves existing timestamp values while widening to BIGINT", () => {
    expect(sql.match(/ALTER COLUMN predicted_execution_time_ms TYPE BIGINT/gi)).toHaveLength(2);
    expect(sql.match(/USING predicted_execution_time_ms::BIGINT/gi)).toHaveLength(2);
  });
});
