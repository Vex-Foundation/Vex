import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => ({
  one: vi.fn(async (_statement: string, _parameters?: unknown[]) => null),
  many: vi.fn(async (_statement: string, _parameters?: unknown[]) => []),
}));
vi.mock("@vex-agent/db/client.js", () => ({ queryOne: sql.one, query: sql.many }));
import * as order from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as oco from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as lifecycle from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("atomic expiration of pre-send nonce reservations", () => {
  const identity = {
    intentId: "intent-1", sessionId: "session-1", environment: "rhc" as const,
    accountIndex: 42, apiKeyIndex: 7, reservationId: "reservation-1", nonceValue: "9", signerTxHash: null,
  };

  for (const entry of [
    { name: "create", repo: order, state: "approval_pending" },
    { name: "OCO", repo: oco, state: "approval_pending" },
    { name: "lifecycle", repo: lifecycle, state: "nonce_reserved" },
  ] as const) {
    it(`guards ${entry.name} retirement and nonce release in one statement`, async () => {
      if (entry.name === "lifecycle") {
        await entry.repo.expirePreSendNonceReservation({ ...identity, expectedState: entry.state });
      } else {
        await entry.repo.expirePreSendNonceReservation({ ...identity, expectedState: entry.state });
      }
      const call = sql.one.mock.calls[0];
      if (call === undefined) throw new Error("nonce retirement did not query the repository");
      const [statement, parameters] = call;
      expect(statement.indexOf("UPDATE lighter_nonce_state")).toBeGreaterThan(statement.indexOf("UPDATE lighter_"));
      expect(statement).toContain("AND status='reserved' AND reservation_id=$6 AND reserved_nonce=$7");
      expect(statement).toContain("execution_state=$8 AND nonce_reservation_id=$6 AND nonce_value=$7");
      expect(statement).toContain("expires_at <= clock_timestamp()");
      expect(statement).toContain("approval_status='approved' AND decided_at IS NOT NULL");
      expect(statement).toContain("pre_submit_revalidation_json IS NOT NULL AND pre_submit_revalidated_at IS NOT NULL");
      expect(statement).toContain(`execution_state='${entry.state}' AND signer_tx_hash IS NULL`);
      expect(statement).toContain("execution_state='signed' AND signer_tx_hash=$9");
      expect(statement).toContain("send_attempt_started_at IS NULL AND submitted_tx_hash IS NULL");
      expect(statement).toContain("submit_code IS NULL AND submit_message IS NULL");
      expect(statement).toContain("predicted_execution_time_ms IS NULL AND volume_quota_remaining IS NULL");
      expect(statement).toContain("provider_outcome_json IS NULL AND provider_outcome_checked_at IS NULL AND ambiguous_reason IS NULL");
      expect(statement).toContain("AND EXISTS (SELECT 1 FROM owner)");
      expect(statement).toContain("AND EXISTS (SELECT 1 FROM reservation)");
      expect(statement.match(/FOR UPDATE/g)).toHaveLength(2);
      expect(statement).toContain("FROM retired r WHERE n.environment=r.environment AND n.account_index=r.account_index AND n.api_key_index=r.api_key_index");
      expect(statement).toContain("n.reservation_id=r.nonce_reservation_id AND n.reserved_nonce=r.nonce_value");
      expect(statement).not.toContain("execution_state='submitted'");
      expect(statement).not.toContain("execution_state='submission_staged'");
      expect(parameters).toEqual(["intent-1", "session-1", "rhc", 42, 7, "reservation-1", "9", entry.state, null]);
      expect(sql.one).toHaveBeenCalledOnce();
    });
  }

  it("includes unsigned nonce owners in create and OCO status discovery", async () => {
    await order.listUnresolved("rhc");
    await oco.listUnresolved("rhc");
    for (const [statement] of sql.many.mock.calls) {
      expect(statement).toContain("execution_state='approval_pending' AND approval_status='approved' AND nonce_reservation_id IS NOT NULL");
    }
    expect(sql.many).toHaveBeenCalledTimes(2);
  });
});
