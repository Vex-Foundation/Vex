import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../vex-agent/db/migrations/140_lighter_order_lifecycle_intents.sql", import.meta.url),
  "utf8",
);

describe("Lighter order lifecycle migration", () => {
  it("preserves provider order identity as bounded decimal text", () => {
    expect(sql).toMatch(/provider_order_id\s+TEXT/i);
    expect(sql).toContain("provider_order_id::NUMERIC <= 1152921504606846975");
    expect(sql).not.toMatch(/provider_order_id\s+BIGINT/i);
  });

  it("pins exact action shapes and durable pre-submission stages", () => {
    for (const action of ["cancel_one", "modify", "cancel_all", "close_position"]) {
      expect(sql).toContain(`'${action}'`);
    }
    for (const state of ["pre_submit_revalidated", "nonce_reserved", "signed", "submission_staged", "ambiguous"]) {
      expect(sql).toContain(`'${state}'`);
    }
    expect(sql).toContain("action_type = 'cancel_all' AND market_index IS NULL AND provider_order_id IS NULL");
    expect(sql).toContain("action_type = 'close_position'");
    expect(sql).toContain("AND reduce_only");
  });

  /**
   * The consent-expiry state. `expired_unsubmitted` means signed or staged,
   * then consent expired or the approved dispatch was aborted, with no
   * submission attempt started. Without it the execution path would have to
   * record such a row as submitted, claiming an order was sent that never was.
   */
  it("admits the consent-expiry state and forbids a dishonest expired_unsubmitted row", () => {
    expect(sql).toContain("'expired_unsubmitted'");
    expect(sql).toContain("send_attempt_started_at      TIMESTAMPTZ");
    // The state may not be claimed once a send attempt was started.
    expect(sql).toContain("execution_state <> 'expired_unsubmitted'");
    expect(sql).toContain("send_attempt_started_at IS NULL");
  });

  it("never stores signed payloads or private credential material", () => {
    expect(sql).not.toMatch(/^\s*(private_key|auth_token|tx_info|signature)\s+/im);
    expect(sql).toContain("credential_ref_json");
    expect(sql).toContain("signer_tx_hash");
  });
});
