import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/114_lighter_stop_loss_orders.sql"),
  "utf8",
);

describe("Lighter stop-loss order migration", () => {
  it("extends only the existing single-order preview and execution constraints", () => {
    expect(sql).toContain("ALTER TABLE lighter_order_previews");
    expect(sql).toContain("ALTER TABLE lighter_order_execution_intents");
    expect(sql).toContain("'stop-loss'");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("signature");
  });
});
