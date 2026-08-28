import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/116_lighter_oco_orders.sql"),
  "utf8",
);

describe("Lighter OCO migration", () => {
  it("binds two distinct child previews to one approval and transaction", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS lighter_oco_execution_intents");
    expect(sql).toContain("stop_loss_preview_id");
    expect(sql).toContain("take_profit_preview_id");
    expect(sql).toContain("stop_loss_client_order_index <> take_profit_client_order_index");
    expect(sql).toContain("idx_lighter_oco_repair");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("signature");
    expect(sql).not.toContain("tx_info");
  });
});
