import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
import { evaluateLighterTradingCredentialReadiness } from "@tools/lighter/trading-credentials.js";

type QueryOneMock = Mock<
  (sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;

let mockQueryOne: QueryOneMock;
let mockQueryOneWith: Mock<
  (client: unknown, sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>
>;

function resetMocks() {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockQueryOneWith = vi
    .fn<(client: unknown, sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  queryOneWith: (client: unknown, sql: string, params?: unknown[]) => mockQueryOneWith(client, sql, params),
}));

const repo = await import("@vex-agent/db/repos/lighter-order-execution-intents.js");

beforeEach(() => {
  resetMocks();
});

const PREVIEW: LighterOrderPreviewRow = {
  previewId: "lighter-preview-1",
  sessionId: "session-1",
  matchHash: "a".repeat(64),
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  side: "buy",
  baseAmountInteger: "10000",
  priceInteger: "300000",
  orderType: "limit",
  timeInForce: "good-till-time",
  reduceOnly: false,
  triggerPriceInteger: null,
  orderExpiryMs: 1786234200000,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  providerVersion: "lighter-preview-v1",
  previewJson: { symbol: "ETH", quoteNotional: "3000" },
  liveSourceJson: { source: "live_lighter_public_api" },
  createdAt: "2026-08-12T00:00:00.000Z",
  expiresAt: "2026-08-12T00:02:00.000Z",
};

const READINESS = evaluateLighterTradingCredentialReadiness({
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  vaultCredentialId: "lighter/rhc/account-42/api-key-7",
});

if (!READINESS.ready) throw new Error("test readiness should be ready");

function dbRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    intent_id: "lighter-exec-1",
    session_id: "session-1",
    preview_id: "lighter-preview-1",
    protocol_execution_id: "99",
    approval_id: "approval-1",
    match_hash: "a".repeat(64),
    environment: "rhc",
    account_index: "42",
    api_key_index: 7,
    market_index: 0,
    side: "buy",
    base_amount_integer: "10000",
    price_integer: "300000",
    order_type: "limit",
    time_in_force: "good-till-time",
    reduce_only: false,
    trigger_price_integer: null,
    order_expiry_ms: "1786234200000",
    client_order_index_policy: "vex_assigned_uint48",
    provider_version: "lighter-preview-v1",
    credential_ref_json: READINESS.reference,
    approval_status: "approval_pending",
    execution_state: "approval_pending",
    decision_reason: null,
    decided_at: null,
    nonce_reservation_id: null,
    nonce_value: null,
    signer_tx_hash: null,
    submitted_tx_hash: null,
    submit_code: null,
    submit_message: null,
    predicted_execution_time_ms: null,
    volume_quota_remaining: null,
    ambiguous_reason: null,
    signed_at: null,
    submitted_at: null,
    api_accepted_at: null,
    ambiguous_at: null,
    created_at: new Date("2026-08-12T00:00:01.000Z"),
    updated_at: new Date("2026-08-12T00:00:02.000Z"),
    expires_at: new Date("2026-08-12T00:05:00.000Z"),
    ...overrides,
  };
}

describe("lighter order execution intents repo", () => {
  it("creates an approval-pending intent from an exact preview and vault reference", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow());

    const created = await repo.createApprovalPending({
      intentId: "lighter-exec-1",
      preview: PREVIEW,
      credentialReadiness: READINESS,
      protocolExecutionId: 99,
      approvalId: "approval-1",
      expiresAt: "2026-08-12T00:05:00.000Z",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO lighter_order_execution_intents");
    expect(sql).toContain("ON CONFLICT (intent_id) DO NOTHING");
    expect(sql).toContain("RETURNING intent_id, session_id, preview_id");
    expect(params).toEqual([
      "lighter-exec-1",
      "session-1",
      "lighter-preview-1",
      99,
      "approval-1",
      "a".repeat(64),
      "rhc",
      42,
      7,
      0,
      "buy",
      "10000",
      "300000",
      "limit",
      "good-till-time",
      false,
      null,
      1786234200000,
      "vex_assigned_uint48",
      "lighter-preview-v1",
      expect.stringContaining("encrypted_vault_reference"),
      "2026-08-12T00:05:00.000Z",
    ]);
    expect(String(params![20])).not.toContain("private");
    expect(created).toMatchObject({
      intentId: "lighter-exec-1",
      previewId: "lighter-preview-1",
      protocolExecutionId: 99,
      approvalId: "approval-1",
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      credentialRefJson: {
        kind: "encrypted_vault_reference",
        environment: "rhc",
        accountIndex: 42,
        apiKeyIndex: 7,
        vaultCredentialId: "lighter/rhc/account-42/api-key-7",
      },
      createdAt: "2026-08-12T00:00:01.000Z",
      updatedAt: "2026-08-12T00:00:02.000Z",
    });
  });

  it("refuses an execution intent when the preview did not bind a trading API key", async () => {
    await expect(repo.createApprovalPending({
      intentId: "lighter-exec-1",
      preview: { ...PREVIEW, apiKeyIndex: null },
      credentialReadiness: READINESS,
      expiresAt: "2026-08-12T00:05:00.000Z",
    })).rejects.toThrow("preview must include a trading apiKeyIndex");

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it("refuses an execution intent when the credential scope differs from the preview", async () => {
    const otherReadiness = evaluateLighterTradingCredentialReadiness({
      environment: "core",
      accountIndex: 42,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/core/account-42/api-key-7",
    });
    if (!otherReadiness.ready) throw new Error("other readiness should be ready");

    await expect(repo.createApprovalPending({
      intentId: "lighter-exec-1",
      preview: PREVIEW,
      credentialReadiness: otherReadiness,
      expiresAt: "2026-08-12T00:05:00.000Z",
    })).rejects.toThrow("credential readiness must match preview environment/account/api-key");

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it("marks exactly one pending intent decision", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      decision_reason: "user approved exact preview",
      decided_at: new Date("2026-08-12T00:01:00.000Z"),
    }));

    const decided = await repo.markApprovalDecision({
      intentId: "lighter-exec-1",
      decision: "approved",
      approvalId: "approval-1",
      reason: "user approved exact preview",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("UPDATE lighter_order_execution_intents");
    expect(sql).toContain("AND approval_status = 'approval_pending'");
    expect(sql).toContain("RETURNING intent_id");
    expect(params).toEqual([
      "lighter-exec-1",
      "approved",
      "approval-1",
      "user approved exact preview",
    ]);
    expect(decided).toMatchObject({
      approvalStatus: "approved",
      decisionReason: "user approved exact preview",
      decidedAt: "2026-08-12T00:01:00.000Z",
    });
  });

  it("returns null when a decision was already recorded", async () => {
    const decided = await repo.markApprovalDecision({
      intentId: "lighter-exec-1",
      decision: "rejected",
      reason: "operator rejected",
    });

    expect(decided).toBeNull();
  });

  it("attaches one nonce reservation to an approved intent by exact scope", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      nonce_reservation_id: "reservation-1",
      nonce_value: "1784732515923",
    }));

    const attached = await repo.attachNonceReservation({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "reservation-1",
      nonceValue: "1784732515923",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("UPDATE lighter_order_execution_intents");
    expect(sql).toContain("AND session_id = $2");
    expect(sql).toContain("AND environment = $3");
    expect(sql).toContain("AND approval_status = 'approved'");
    expect(sql).toContain("AND execution_state = 'approval_pending'");
    expect(sql).toContain("AND nonce_reservation_id IS NULL");
    expect(params).toEqual([
      "lighter-exec-1",
      "session-1",
      "rhc",
      42,
      7,
      "reservation-1",
      "1784732515923",
    ]);
    expect(attached).toMatchObject({
      nonceReservationId: "reservation-1",
      nonceValue: "1784732515923",
    });
  });

  it("attaches a nonce reservation inside an existing transaction client", async () => {
    const txClient = { tx: true };
    mockQueryOneWith.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      nonce_reservation_id: "reservation-tx",
      nonce_value: "1784732515923",
    }));

    const attached = await repo.attachNonceReservationWith(txClient as never, {
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "reservation-tx",
      nonceValue: "1784732515923",
    });

    const [client, sql] = mockQueryOneWith.mock.calls[0]!;
    expect(client).toBe(txClient);
    expect(sql).toContain("UPDATE lighter_order_execution_intents");
    expect(attached).toMatchObject({
      nonceReservationId: "reservation-tx",
      nonceValue: "1784732515923",
    });
  });

  it("accepts nonce zero when attaching the first reservation for a fresh API key", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      nonce_reservation_id: "reservation-zero",
      nonce_value: "0",
    }));

    const attached = await repo.attachNonceReservation({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "reservation-zero",
      nonceValue: "0",
    });

    expect(mockQueryOne.mock.calls[0]![1]).toEqual([
      "lighter-exec-1",
      "session-1",
      "rhc",
      42,
      7,
      "reservation-zero",
      "0",
    ]);
    expect(attached).toMatchObject({
      nonceReservationId: "reservation-zero",
      nonceValue: "0",
    });
  });

  it("refuses empty reservation ids and malformed nonce values before DB writes", async () => {
    await expect(repo.attachNonceReservation({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "",
      nonceValue: "1784732515923",
    })).rejects.toThrow("reservationId is required");
    await expect(repo.attachNonceReservation({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      accountIndex: 42,
      apiKeyIndex: 7,
      reservationId: "reservation-1",
      nonceValue: "-1",
    })).rejects.toThrow("nonceValue must be a non-negative decimal integer");

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it("marks a nonce-reserved approved intent as signed without payload material", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      execution_state: "signed",
      nonce_reservation_id: "reservation-1",
      nonce_value: "1784732515923",
      signer_tx_hash: "0xabc123",
      signed_at: new Date("2026-08-12T00:02:00.000Z"),
    }));

    const signed = await repo.markSigned({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      nonceReservationId: "reservation-1",
      nonceValue: "1784732515923",
      signerTxHash: "0xabc123",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("SET execution_state = 'signed'");
    expect(sql).toContain("AND approval_status = 'approved'");
    expect(sql).toContain("AND execution_state = 'approval_pending'");
    expect(sql).toContain("AND nonce_reservation_id = $4");
    expect(sql).toContain("AND nonce_value = $5");
    expect(params).toEqual([
      "lighter-exec-1",
      "session-1",
      "rhc",
      "reservation-1",
      "1784732515923",
      "0xabc123",
    ]);
    expect(signed).toMatchObject({
      executionState: "signed",
      signerTxHash: "0xabc123",
      signedAt: "2026-08-12T00:02:00.000Z",
    });
  });

  it("marks a nonce-zero approved intent as signed", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      execution_state: "signed",
      nonce_reservation_id: "reservation-zero",
      nonce_value: "0",
      signer_tx_hash: "0xabc123",
      signed_at: new Date("2026-08-12T00:02:00.000Z"),
    }));

    const signed = await repo.markSigned({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      nonceReservationId: "reservation-zero",
      nonceValue: "0",
      signerTxHash: "0xabc123",
    });

    expect(mockQueryOne.mock.calls[0]![1]).toEqual([
      "lighter-exec-1",
      "session-1",
      "rhc",
      "reservation-zero",
      "0",
      "0xabc123",
    ]);
    expect(signed).toMatchObject({
      executionState: "signed",
      nonceValue: "0",
    });
  });

  it("marks a signed intent as submitted before the provider response is interpreted", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      execution_state: "submitted",
      signer_tx_hash: "0xabc123",
      signed_at: new Date("2026-08-12T00:02:00.000Z"),
      submitted_at: new Date("2026-08-12T00:02:01.000Z"),
    }));

    const submitted = await repo.markSubmitted({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      signerTxHash: "0xabc123",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("SET execution_state = 'submitted'");
    expect(sql).toContain("AND execution_state = 'signed'");
    expect(sql).toContain("AND signer_tx_hash = $4");
    expect(params).toEqual(["lighter-exec-1", "session-1", "rhc", "0xabc123"]);
    expect(submitted).toMatchObject({
      executionState: "submitted",
      signerTxHash: "0xabc123",
      submittedAt: "2026-08-12T00:02:01.000Z",
    });
  });

  it("marks a submitted intent as API accepted without treating it as final execution", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      execution_state: "api_accepted",
      signer_tx_hash: "0xabc123",
      submitted_tx_hash: "0xabc123",
      submit_code: 200,
      submit_message: "accepted",
      predicted_execution_time_ms: 250,
      volume_quota_remaining: "10780",
      signed_at: new Date("2026-08-12T00:02:00.000Z"),
      submitted_at: new Date("2026-08-12T00:02:01.000Z"),
      api_accepted_at: new Date("2026-08-12T00:02:02.000Z"),
    }));

    const accepted = await repo.markApiAccepted({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      signerTxHash: "0xabc123",
      submittedTxHash: "0xabc123",
      submitCode: 200,
      submitMessage: "accepted",
      predictedExecutionTimeMs: 250,
      volumeQuotaRemaining: 10780,
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("SET execution_state = 'api_accepted'");
    expect(sql).toContain("AND execution_state = 'submitted'");
    expect(sql).toContain("AND signer_tx_hash = $4");
    expect(params).toEqual([
      "lighter-exec-1",
      "session-1",
      "rhc",
      "0xabc123",
      "0xabc123",
      200,
      "accepted",
      250,
      10780,
    ]);
    expect(accepted).toMatchObject({
      executionState: "api_accepted",
      submittedTxHash: "0xabc123",
      submitCode: 200,
      submitMessage: "accepted",
      predictedExecutionTimeMs: 250,
      volumeQuotaRemaining: "10780",
      apiAcceptedAt: "2026-08-12T00:02:02.000Z",
    });
  });

  it("marks in-flight submit outcomes ambiguous with bounded structural reasons", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow({
      approval_status: "approved",
      execution_state: "ambiguous",
      ambiguous_reason: "provider_transport_after_submit",
      ambiguous_at: new Date("2026-08-12T00:03:00.000Z"),
    }));

    const ambiguous = await repo.markAmbiguous({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      reason: "provider_transport_after_submit",
    });

    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(sql).toContain("SET execution_state = 'ambiguous'");
    expect(sql).toContain("execution_state IN ('signed','submitted','api_accepted','sequencer_pending')");
    expect(params).toEqual([
      "lighter-exec-1",
      "session-1",
      "rhc",
      "provider_transport_after_submit",
    ]);
    expect(ambiguous).toMatchObject({
      executionState: "ambiguous",
      ambiguousReason: "provider_transport_after_submit",
      ambiguousAt: "2026-08-12T00:03:00.000Z",
    });
  });

  it("refuses signed payload-shaped submit metadata before DB writes", async () => {
    await expect(repo.markApiAccepted({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      signerTxHash: "0xabc123",
      submittedTxHash: "0xabc123",
      submitCode: 200,
      submitMessage: "accepted with tx_info Sig payload",
      predictedExecutionTimeMs: 250,
    })).rejects.toThrow("submitMessage must not contain signed payload material");
    await expect(repo.markAmbiguous({
      intentId: "lighter-exec-1",
      sessionId: "session-1",
      environment: "rhc",
      reason: "secret 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    })).rejects.toThrow("reason must not contain signed payload material");

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it("finds session-scoped intents by id and by live preview", async () => {
    mockQueryOne.mockResolvedValueOnce(dbRow());
    await repo.findByIntentId("session-1", "lighter-exec-1");

    expect(mockQueryOne.mock.calls[0]![0]).toContain("WHERE session_id = $1 AND intent_id = $2");
    expect(mockQueryOne.mock.calls[0]![1]).toEqual(["session-1", "lighter-exec-1"]);

    mockQueryOne.mockResolvedValueOnce(dbRow());
    await repo.findLiveByPreview("session-1", "lighter-preview-1");

    expect(mockQueryOne.mock.calls[1]![0]).toContain("approval_status IN ('approval_pending','approved')");
    expect(mockQueryOne.mock.calls[1]![1]).toEqual(["session-1", "lighter-preview-1"]);
  });
});
