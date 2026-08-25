import { describe, expect, it, vi } from "vitest";

import {
  expireStaleApprovalPendingWith,
  findByIntentIdForWalletWith,
  findLatestForWalletWith,
  hasPendingApprovalForIntentWith,
  isSafelyExpirableApprovalPending,
  isSafelyReemittableApprovalPending,
  type LighterWithdrawalIntentRow,
} from "@vex-agent/db/repos/lighter-withdrawal-intents.js";

function intent(
  overrides: Partial<LighterWithdrawalIntentRow> = {},
): LighterWithdrawalIntentRow {
  return {
    approvalStatus: "approval_pending",
    executionState: "approval_pending",
    protocolExecutionId: null,
    approvalId: null,
    decisionReason: null,
    decidedAt: null,
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceReservationId: null,
    nonceValue: null,
    signerTxHash: null,
    signerExpiryMs: null,
    signedAt: null,
    submissionStagedAt: null,
    submittedTxHash: null,
    submitCode: null,
    submitMessage: null,
    predictedExecutionTimeMs: null,
    volumeQuotaRemaining: null,
    apiAcceptedAt: null,
    providerTxStatus: null,
    providerTxEvidenceJson: null,
    withdrawalHistoryId: null,
    withdrawalHistoryStatus: null,
    withdrawalHistoryJson: null,
    ambiguousReason: null,
    claimMode: null,
    claimApprovalId: null,
    claimTxHash: null,
    claimReplacementTxHash: null,
    destinationTxHash: null,
    destinationBlockNumber: null,
    destinationBlockHash: null,
    destinationConfirmations: null,
    destinationEvidenceJson: null,
    l2ExecutedAt: null,
    claimableAt: null,
    destinationConfirmedAt: null,
    lastCheckedAt: null,
    settlementScanFromBlock: null,
    withdrawalHistoryTimestamp: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  } as LighterWithdrawalIntentRow;
}

function reemittableIntent(
  overrides: Partial<LighterWithdrawalIntentRow> = {},
): LighterWithdrawalIntentRow {
  return intent({
    intentId: "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    protocolExecutionId: null,
    decisionReason: null,
    decidedAt: null,
    preSubmitRevalidationJson: null,
    preSubmitRevalidatedAt: null,
    nonceValue: null,
    signedAt: null,
    apiAcceptedAt: null,
    environment: "rhc",
    endpoint: "https://api.rh.lighter.xyz",
    signingChainId: 466324,
    settlementChainId: 4663,
    settlementNetworkName: "Robinhood Chain mainnet",
    accountIndex: 10_231,
    apiKeyIndex: 7,
    walletAddress: "0x1111111111111111111111111111111111111111",
    destinationAddress: "0x1111111111111111111111111111111111111111",
    assetIndex: 3,
    assetSymbol: "USDG",
    assetDecimals: 6,
    settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    routeType: 0,
    amountUnits: "1000000",
    minimumWithdrawalUnits: "1000000",
    withdrawalDelaySeconds: 1200,
    gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
    gatewayImplementation: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
    gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    expiresAt: "2030-01-01T00:05:00.000Z",
    ...overrides,
  });
}

function freshPreview() {
  return {
    identity: { sessionId: "session-1" },
    snapshot: {
      environment: "rhc",
      endpoint: "https://api.rh.lighter.xyz",
      signingChainId: 466324,
      settlementChainId: 4663,
      settlementNetworkName: "Robinhood Chain mainnet",
      accountIndex: 10_231,
      apiKeyIndex: 7,
      walletAddress: "0x1111111111111111111111111111111111111111",
      destinationAddress: "0x1111111111111111111111111111111111111111",
      assetIndex: 3,
      assetSymbol: "USDG",
      assetDecimals: 6,
      settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      routeType: 0,
      amountUnits: "1000000",
      minimumWithdrawalUnits: "1000000",
      withdrawalDelaySeconds: 1200,
      gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
      gatewayImplementationAddress: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
      gatewayCodeHash: `0x${"1".repeat(64)}`,
      settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    },
  } as never;
}

describe("Lighter withdrawal approval-pending expiry", () => {
  it("expires only a past-due intent with no approval or signing evidence", () => {
    const now = Date.parse("2030-01-01T00:01:00.000Z");
    expect(isSafelyExpirableApprovalPending(intent(), now)).toBe(true);
    expect(isSafelyExpirableApprovalPending(intent({ expiresAt: "2030-01-01T00:02:00.000Z" }), now)).toBe(false);
    expect(isSafelyExpirableApprovalPending(intent({ approvalId: "approval-1" }), now)).toBe(false);
    expect(isSafelyExpirableApprovalPending(intent({ approvalStatus: "approved" }), now)).toBe(false);
    expect(isSafelyExpirableApprovalPending(intent({ executionState: "nonce_reserved" }), now)).toBe(false);
    expect(isSafelyExpirableApprovalPending(intent({ signerTxHash: "signed-hash" }), now)).toBe(false);
    expect(isSafelyExpirableApprovalPending(intent({ submissionStagedAt: "2030-01-01T00:00:30.000Z" }), now)).toBe(false);
    expect(isSafelyExpirableApprovalPending(intent({ submittedTxHash: "submitted-hash" }), now)).toBe(false);
    for (const evidence of [
      { protocolExecutionId: 1 },
      { decisionReason: "approved" },
      { decidedAt: "2030-01-01T00:00:10.000Z" },
      { preSubmitRevalidationJson: {} },
      { preSubmitRevalidatedAt: "2030-01-01T00:00:20.000Z" },
      { nonceValue: "1" },
      { signerExpiryMs: 1_893_456_000_000 },
      { signedAt: "2030-01-01T00:00:30.000Z" },
      { submitCode: 200 },
      { submitMessage: "accepted" },
      { predictedExecutionTimeMs: 1_893_456_000_000 },
      { volumeQuotaRemaining: "1" },
      { apiAcceptedAt: "2030-01-01T00:00:40.000Z" },
      { providerTxStatus: 1 },
      { providerTxEvidenceJson: {} },
      { withdrawalHistoryId: "history-1" },
      { withdrawalHistoryStatus: "pending" },
      { withdrawalHistoryJson: {} },
      { ambiguousReason: "provider timeout" },
      { claimMode: "manual" as const },
      { claimApprovalId: "claim-approval-1" },
      { claimTxHash: "claim-hash" },
      { claimReplacementTxHash: "replacement-hash" },
      { destinationTxHash: "destination-hash" },
      { destinationBlockNumber: "1" },
      { destinationBlockHash: "block-hash" },
      { destinationConfirmations: 1 },
      { destinationEvidenceJson: {} },
      { l2ExecutedAt: "2030-01-01T00:00:50.000Z" },
      { claimableAt: "2030-01-01T00:00:50.000Z" },
      { destinationConfirmedAt: "2030-01-01T00:00:50.000Z" },
      { lastCheckedAt: "2030-01-01T00:00:50.000Z" },
      { settlementScanFromBlock: "1" },
      { withdrawalHistoryTimestamp: 1_893_456_000 },
    ] satisfies Array<Partial<LighterWithdrawalIntentRow>>) {
      expect(isSafelyExpirableApprovalPending(intent(evidence), now)).toBe(false);
    }
  });

  it("uses an exact evidence-free compare-and-set before releasing the account scope", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows: [], rowCount: 0 })),
    };
    await expect(expireStaleApprovalPendingWith(client as never, {
      intentId: "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
      sessionId: "session-old",
      environment: "rhc",
      accountIndex: 10_231,
    })).resolves.toBeNull();

    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("approval_status = 'approval_pending'");
    expect(sql).toContain("execution_state = 'approval_pending'");
    expect(sql).toContain("expires_at <= NOW()");
    expect(sql).toContain("protocol_execution_id IS NULL");
    expect(sql).toContain("approval_id IS NULL");
    expect(sql).toContain("pre_submit_revalidation_json IS NULL");
    expect(sql).toContain("nonce_reservation_id IS NULL");
    expect(sql).toContain("signer_tx_hash IS NULL");
    expect(sql).toContain("submission_staged_at IS NULL");
    expect(sql).toContain("submitted_tx_hash IS NULL");
    expect(sql).toContain("api_accepted_at IS NULL");
    expect(sql).toContain("provider_tx_evidence_json IS NULL");
    expect(sql).toContain("destination_evidence_json IS NULL");
    expect(params).toEqual([
      "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
      "session-old",
      "rhc",
      10_231,
    ]);
  });

  it("re-emits only an unexpired same-session intent with identical fresh terms and no durable action evidence", () => {
    const now = Date.parse("2030-01-01T00:01:00.000Z");
    expect(isSafelyReemittableApprovalPending(reemittableIntent(), freshPreview(), now)).toBe(true);
    expect(isSafelyReemittableApprovalPending(
      reemittableIntent({ sessionId: "session-2" }), freshPreview(), now,
    )).toBe(false);
    expect(isSafelyReemittableApprovalPending(
      reemittableIntent({ expiresAt: "2030-01-01T00:00:00.000Z" }), freshPreview(), now,
    )).toBe(false);
    for (const changed of [
      { protocolExecutionId: 1 },
      { approvalId: "approval-1" },
      { preSubmitRevalidationJson: {} },
      { nonceReservationId: "reservation-1", nonceValue: "1" },
      { signerTxHash: "signed-hash" },
      { signerExpiryMs: 1_893_456_000_000 },
      { submissionStagedAt: "2030-01-01T00:00:30.000Z" },
      { submittedTxHash: "submitted-hash" },
      { submitCode: 200 },
      { providerTxEvidenceJson: {} },
      { withdrawalHistoryId: "history-1" },
      { ambiguousReason: "provider timeout" },
      { claimApprovalId: "claim-approval-1" },
      { destinationTxHash: "destination-hash" },
      { destinationEvidenceJson: {} },
      { apiAcceptedAt: "2030-01-01T00:00:30.000Z" },
      { amountUnits: "2000000" },
      { gatewayImplementation: "0x1111111111111111111111111111111111111111" },
    ] satisfies Array<Partial<LighterWithdrawalIntentRow>>) {
      expect(isSafelyReemittableApprovalPending(
        reemittableIntent(changed), freshPreview(), now,
      )).toBe(false);
    }
  });

  it("detects an already-live exact withdrawal approval before re-emission", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _params: readonly unknown[]) => ({
        rows: [{ present: true }],
        rowCount: 1,
      })),
    };
    await expect(hasPendingApprovalForIntentWith(
      client as never,
      "session-1",
      "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
    )).resolves.toBe(true);
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("q.status = 'pending'");
    expect(sql).toContain("'lighter.withdraw'");
    expect(sql).toContain("->>'intentId' = $2");
    expect(params).toEqual([
      "session-1",
      "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("recovers an exact earlier-session intent only within the selected wallet scope", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows: [], rowCount: 0 })),
    };
    await expect(findByIntentIdForWalletWith(
      client as never,
      "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
      "0x1111111111111111111111111111111111111111",
    )).resolves.toBeNull();
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).not.toContain("WHERE session_id");
    expect(sql).toContain("LOWER(wallet_address) = LOWER($2)");
    expect(sql).toContain("LOWER(destination_address) = LOWER($2)");
    expect(params).toEqual([
      "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
      "0x1111111111111111111111111111111111111111",
    ]);
  });

  it("recovers the latest wallet-scoped intent when a new session has no local row", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _params: readonly unknown[]) => ({ rows: [], rowCount: 0 })),
    };
    await expect(findLatestForWalletWith(
      client as never,
      "0x1111111111111111111111111111111111111111",
    )).resolves.toBeNull();
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).not.toContain("session_id =");
    expect(sql).toContain("LOWER(wallet_address) = LOWER($1)");
    expect(sql).toContain("LOWER(destination_address) = LOWER($1)");
    expect(sql).toContain("execution_state NOT IN");
    expect(sql).toContain(") DESC, created_at DESC");
    expect(params).toEqual(["0x1111111111111111111111111111111111111111"]);
  });
});
