import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/148_lighter_oco_orders.sql"),
  "utf8",
);

describe("Lighter OCO migration", () => {
  /**
   * The consent-expiry state. `expired_unsubmitted` means signed or staged,
   * then consent expired or the approved dispatch was aborted, with no
   * submission attempt started. Without it the execution path would have to
   * record such a row as submitted, claiming an order was sent that never was.
   */
  it("admits the consent-expiry state and forbids a dishonest expired_unsubmitted row", () => {
    expect(sql).toContain("'expired_unsubmitted'");
    expect(sql).toContain("send_attempt_started_at           TIMESTAMPTZ");
    // The state may not be claimed once a send attempt was started.
    expect(sql).toContain("execution_state <> 'expired_unsubmitted'");
    expect(sql).toContain("send_attempt_started_at IS NULL");
  });

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
