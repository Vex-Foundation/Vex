import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../../../vex-agent/db/migrations/143_lighter_order_submit_message.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("Lighter order submit message migration", () => {
  /**
   * The consent-expiry state. `expired_unsubmitted` means signed or staged,
   * then consent expired or the approved dispatch was aborted, with no
   * submission attempt started. Without it the execution path would have to
   * record such a row as submitted, claiming an order was sent that never was.
   */
  it("restates the consent-expiry truth clause with the rest of the shape", () => {
    // The state may not be claimed once a send attempt was started.
    expect(sql).toContain("execution_state = 'expired_unsubmitted'");
    expect(sql).toContain("send_attempt_started_at IS NULL");
    expect(sql).toContain("signed_at IS NOT NULL");
  });

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
