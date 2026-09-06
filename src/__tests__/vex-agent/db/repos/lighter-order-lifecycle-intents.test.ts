import { testPoolClient } from "../../../helpers/db-client.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
let mockQueryOne: QueryOneMock;
let mockQueryOneWith: Mock<(client: unknown, sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;

function resetMocks() {
  mockQueryOne = vi.fn<QueryOneMock>().mockResolvedValue(null);
  mockQueryOneWith = vi.fn<typeof mockQueryOneWith>().mockResolvedValue(null);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  queryOneWith: (client: unknown, sql: string, params?: unknown[]) => mockQueryOneWith(client, sql, params),
}));

const repo = await import("@vex-agent/db/repos/lighter-order-lifecycle-intents.js");

const credential = {
  kind: "encrypted_vault_reference" as const,
  environment: "rhc" as const,
  accountIndex: 42,
  apiKeyIndex: 7,
  vaultCredentialId: "lighter/rhc/account-42/api-key-7",
};

const base = {
  intentId: `lighter-lifecycle-${"a".repeat(32)}`,
  sessionId: "session-1",
  matchHash: "b".repeat(64),
  environment: "rhc" as const,
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  providerOrderId: "1152921504606846975",
  providerSnapshotJson: { orderId: "1152921504606846975", status: "open" },
  credentialRefJson: credential,
  expiresAt: "2026-08-19T22:00:00.000Z",
};

function row(overrides: Partial<LighterOrderLifecycleIntentRow> = {}): LighterOrderLifecycleIntentRow {
  return {
    ...base,
    actionType: "cancel_one",
    protocolExecutionId: null,
    approvalId: "approval-1",
    requestedBaseAmountInteger: null,
    requestedPriceInteger: null,
    requestedSide: null,
    reduceOnly: false,
    approvalStatus: "approved",
    executionState: "approved",
    decisionReason: "user approved",
    decidedAt: "2026-08-19T21:58:00.000Z",
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    signerExpiryMs: null,
    signerTxHash: null,
    submittedTxHash: null,
    submitCode: null,
    submitMessage: null,
    predictedExecutionTimeMs: null,
    volumeQuotaRemaining: null,
    providerOutcomeJson: null,
    providerOutcomeCheckedAt: null,
    ambiguousReason: null,
    createdAt: "2026-08-19T21:57:00.000Z",
    updatedAt: "2026-08-19T21:58:00.000Z",
    ...overrides,
  };
}

beforeEach(resetMocks);

describe("Lighter order lifecycle intent repository", () => {
  it("inserts cancel-one identity without numeric conversion or secret material", async () => {
    await repo.createApprovalPendingWith(testPoolClient(), { ...base, actionType: "cancel_one" });
    const call = mockQueryOneWith.mock.calls[0];
    expect(call?.[1]).toContain("INSERT INTO lighter_order_lifecycle_intents");
    expect(call?.[1]).not.toMatch(/tx_info|private_key|auth_token/i);
    expect(call?.[2]).toContain("1152921504606846975");
    expect(JSON.stringify(call?.[2])).not.toContain("privateKey");
  });

  it("requires modify values and account-wide cancel-all identity", async () => {
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "modify",
    })).rejects.toThrow("modify values are required");
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "cancel_all",
    })).rejects.toThrow("action target shape mismatch");
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "cancel_all",
      marketIndex: null,
      providerOrderId: null,
    })).resolves.toBeNull();
  });

  it("rejects rounded, out-of-range, mismatched, or secret-bearing facts before SQL", async () => {
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "cancel_one",
      providerOrderId: "1152921504606846976",
    })).rejects.toThrow("outside the official range");
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "cancel_one",
      providerOrderId: "01",
    })).rejects.toThrow("invalid providerOrderId");
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "cancel_one",
      credentialRefJson: { ...credential, accountIndex: 43 },
    })).rejects.toThrow("credential scope mismatch");
    await expect(repo.createApprovalPendingWith(testPoolClient(), {
      ...base,
      actionType: "cancel_one",
      providerSnapshotJson: { authToken: "forbidden" },
    })).rejects.toThrow("forbidden signed or secret material");
    expect(mockQueryOneWith).not.toHaveBeenCalled();
  });

  it("enforces compare-and-set transitions around nonce and submission", async () => {
    await repo.markPreSubmitRevalidated({ intentId: base.intentId, sessionId: "session-1", evidence: { status: "open" } });
    await repo.attachNonceReservation({ intentId: base.intentId, sessionId: "session-1", reservationId: "reserve-1", nonceValue: "9" });
    await repo.markSubmissionStaged({ intentId: base.intentId, sessionId: "session-1", signerTxHash: "hash-1" });
    expect(mockQueryOne.mock.calls[0]?.[0]).toContain("execution_state = 'approved'");
    expect(mockQueryOne.mock.calls[1]?.[0]).toContain("execution_state = 'pre_submit_revalidated'");
    expect(mockQueryOne.mock.calls[2]?.[0]).toContain("execution_state = 'signed'");
  });

  it("guards stream evidence by exact account scope and nonterminal states", async () => {
    await repo.markStreamEvidence({
      intentId: base.intentId,
      environment: "rhc",
      accountIndex: 42,
      state: "completed",
      evidence: { kind: "lighter_lifecycle_stream_evidence", orderId: base.providerOrderId },
    });

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining("execution_state IN ('signed','submission_staged','api_accepted','sequencer_pending','ambiguous')"),
      expect.arrayContaining([base.intentId, "rhc", 42, "completed"]),
    );
  });

  it("recognizes only expired pre-submit rows with no nonce, signature, or submission evidence", () => {
    const now = Date.parse("2026-08-19T22:00:01.000Z");
    expect(repo.isSafelyExpirablePreSubmit(row(), now)).toBe(true);
    expect(repo.isSafelyExpirablePreSubmit(row({
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      approvalId: null,
      decisionReason: null,
      decidedAt: null,
    }), now)).toBe(true);
    expect(repo.isSafelyExpirablePreSubmit(row({ expiresAt: "2026-08-19T22:00:02.000Z" }), now)).toBe(false);
    expect(repo.isSafelyExpirablePreSubmit(row({ nonceReservationId: "lighter-lifecycle:one", nonceValue: "9" }), now)).toBe(false);
    expect(repo.isSafelyExpirablePreSubmit(row({ signerTxHash: "signed" }), now)).toBe(false);
    expect(repo.isSafelyExpirablePreSubmit(row({ submittedTxHash: "submitted" }), now)).toBe(false);
  });

  it("uses a full evidence-free compare-and-set to expire stale pre-submit work", async () => {
    await repo.expireStalePreSubmitWith(testPoolClient(), {
      intentId: base.intentId,
      sessionId: base.sessionId,
      matchHash: base.matchHash,
      environment: base.environment,
      accountIndex: base.accountIndex,
      actionType: "cancel_one",
      marketIndex: base.marketIndex,
      providerOrderId: base.providerOrderId,
    });

    const sql = mockQueryOneWith.mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("execution_state = 'expired'");
    expect(sql).toContain("expires_at <= NOW()");
    expect(sql).toContain("nonce_reservation_id IS NULL");
    expect(sql).toContain("signer_tx_hash IS NULL");
    expect(sql).toContain("submitted_tx_hash IS NULL");
    expect(sql).toContain("provider_outcome_json IS NULL");
  });

  it("terminalizes a changed close only from the pristine approved state", async () => {
    await repo.markClosePositionChangedBeforeSubmissionWith(testPoolClient(), {
      intentId: base.intentId,
      sessionId: base.sessionId,
    });

    const sql = mockQueryOneWith.mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("action_type = 'close_position'");
    expect(sql).toContain("execution_state = 'approved'");
    expect(sql).toContain("execution_state = 'rejected'");
    expect(sql).toContain("nonce_reservation_id IS NULL");
    expect(sql).toContain("transactionSubmitted");
  });
});
