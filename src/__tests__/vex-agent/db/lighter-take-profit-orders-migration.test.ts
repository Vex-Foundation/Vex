import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/115_lighter_take_profit_orders.sql"),
  "utf8",
);

describe("Lighter take-profit order migration", () => {
  it("extends the released standalone order types without storing secrets", () => {
    expect(sql).toContain("ALTER TABLE lighter_order_previews");
    expect(sql).toContain("ALTER TABLE lighter_order_execution_intents");
    expect(sql).toContain("'stop-loss'");
    expect(sql).toContain("'take-profit'");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("signature");
  });
});
