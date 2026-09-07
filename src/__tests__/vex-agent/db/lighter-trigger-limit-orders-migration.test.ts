import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourcePath = resolve(
  process.cwd(),
  "src/vex-agent/db/migrations/117_lighter_trigger_limit_orders.sql",
);
const sql = readFileSync(sourcePath, "utf8");

describe("Lighter trigger-limit order migration", () => {
  it("expands preview and execution order-type constraints to the full native family", () => {
    expect(sql).toContain("ALTER TABLE lighter_order_previews");
    expect(sql).toContain("ALTER TABLE lighter_order_execution_intents");
    for (const orderType of [
      "'limit'",
      "'market'",
      "'stop-loss'",
      "'stop-loss-limit'",
      "'take-profit'",
      "'take-profit-limit'",
    ]) {
      expect(sql).toContain(orderType);
    }
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("signature");
    expect(sql).not.toContain("CREATE TABLE");
  });

  it("backfills only public preview precision needed to reconcile pre-upgrade intents", () => {
    expect(sql).toContain("UPDATE lighter_order_execution_intents AS intent");
    expect(sql).toContain("intent.preview_id = preview.preview_id");
    expect(sql).toContain("'{baseAmount,decimals}'");
    expect(sql).toContain("'{price,decimals}'");
    expect(sql).toContain("'{baseDecimals}'");
    expect(sql).toContain("'{priceDecimals}'");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("tx_info");
  });
});
