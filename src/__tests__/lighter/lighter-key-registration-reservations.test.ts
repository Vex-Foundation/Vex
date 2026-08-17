import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { inspectLighterApiKeySlots } from "@tools/lighter/wallet-funding/api-key-slots.js";
import {
  markLighterKeyRegistrationActiveWith,
  markLighterKeyRegistrationAmbiguousWith,
  markLighterKeyRegistrationApprovalPendingWith,
  markLighterKeyRegistrationApprovedWith,
  markLighterKeyGeneratedEncryptedWith,
  markLighterKeyRegistrationKeyVerifiedWith,
  markLighterKeyRegistrationNonceSynchronizedWith,
  markLighterKeyRegistrationSubmittedWith,
  markLighterKeyRegistrationTxStagedWith,
  reserveLighterApiKeySlotWith,
  renewPristineApprovedLighterKeyRegistrationIntentWith,
  type ReserveLighterApiKeySlotInput,
} from "@vex-agent/db/repos/lighter-key-registration-intents.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";

function observation() {
  return inspectLighterApiKeySlots({
    code: 200,
    api_keys: [{
      account_index: 42,
      api_key_index: 4,
      nonce: 0,
      public_key: "05".repeat(40),
      transaction_time: 1,
    }],
  }, 42, NOW);
}

const INPUT: ReserveLighterApiKeySlotInput = {
  sessionId: "session-1",
  environment: "core",
  walletAddress: WALLET,
  chainId: 1,
  accountIndex: 42,
  observation: observation(),
  expiresAt: new Date("2030-01-01T01:00:00.000Z"),
  now: NOW,
};

function reservationRow(apiKeyIndex = 6) {
  return {
    intent_id: "lighter-onboard-00000000-0000-4000-8000-000000000001",
    session_id: INPUT.sessionId,
    environment: INPUT.environment,
    wallet_address: WALLET.toLowerCase(),
    chain_id: 1,
    resolved_account_index: 42,
    api_key_index: apiKeyIndex,
    slot_observed_at: NOW,
    slot_observation_hash: INPUT.observation.observationHash,
    approval_status: "approval_pending",
    execution_state: "slot_reserved",
    vault_credential_id: null,
    public_key: null,
    public_key_fingerprint: null,
    key_generated_at: null,
    registration_nonce: null,
    registration_nonce_observed_at: null,
    created_at: NOW,
    updated_at: NOW,
    expires_at: INPUT.expiresAt,
  };
}

function workflowRow(state: string) {
  return {
    environment: "core",
    wallet_address: WALLET.toLowerCase(),
    workflow_state: state,
    last_stable_state: state,
    active_deposit_intent_id: null,
    resolved_account_index: 42,
    api_key_index: 6,
    public_key_fingerprint: "a".repeat(64),
    failure_code: null,
    revision: 2,
    created_at: NOW,
    updated_at: NOW,
  };
}

function lifecycleRow(state: string, overrides: Record<string, unknown> = {}) {
  return {
    ...reservationRow(6),
    approval_status: "approved",
    execution_state: state,
    vault_credential_id: "lighter/core/account-42/api-key-6",
    public_key: "ab".repeat(40),
    public_key_fingerprint: "f".repeat(64),
    key_generated_at: NOW,
    registration_nonce: "0",
    registration_nonce_observed_at: NOW,
    registration_tx_type: 8,
    registration_tx_hash: "cd".repeat(40),
    registration_tx_expired_at: "1893456000000",
    registration_tx_staged_at: NOW,
    registration_submitted_tx_hash: null,
    registration_submit_code: null,
    registration_predicted_execution_time_ms: null,
    registration_submit_accepted_at: null,
    registration_ambiguity_reason: null,
    registration_key_verified_at: null,
    registration_client_checked_at: null,
    post_registration_nonce: null,
    registration_nonce_synchronized_at: null,
    registration_activated_at: null,
    ...overrides,
  };
}

describe("Lighter Phase 3 key slot reservation repository", () => {
  it("locks the workflow, excludes DB-held slots, and binds the selected slot", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            workflow_state: "account_resolved",
            resolved_account_index: 42,
            api_key_index: null,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ api_key_index: 5 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [reservationRow(6)], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    };

    const result = await reserveLighterApiKeySlotWith(client as never, INPUT);

    expect(result).toMatchObject({
      outcome: "created",
      reservation: { accountIndex: 42, apiKeyIndex: 6, executionState: "slot_reserved" },
    });
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[2]?.[0]).toContain("ON CONFLICT DO NOTHING");
    expect(client.query.mock.calls[3]?.[0]).toContain("revision = revision + 1");
    expect(client.query.mock.calls[3]?.[1]).toEqual(["core", WALLET, 6, 42]);
  });

  it("returns the durable reservation when another session already owns the workflow slot", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            workflow_state: "account_resolved",
            resolved_account_index: 42,
            api_key_index: 7,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [reservationRow(7)], rowCount: 1 }),
    };

    const result = await reserveLighterApiKeySlotWith(client as never, INPUT);

    expect(result).toMatchObject({ outcome: "live_conflict", reservation: { apiKeyIndex: 7 } });
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it("refuses stale provider evidence before locking the workflow", async () => {
    const client = { query: vi.fn() };

    await expect(reserveLighterApiKeySlotWith(client as never, {
      ...INPUT,
      observation: { ...INPUT.observation, observedAt: new Date("2029-12-31T23:58:00.000Z") },
    })).rejects.toThrow("stale or from the future");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("persists public metadata only after the encrypted-vault step", async () => {
    const generatedRow = {
      ...reservationRow(6),
      execution_state: "key_generated_encrypted",
      vault_credential_id: "lighter/core/account-42/api-key-6",
      public_key: "ab".repeat(40),
      public_key_fingerprint: "a".repeat(64),
      key_generated_at: NOW,
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [generatedRow], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [workflowRow("key_generated_encrypted")], rowCount: 1 }),
    };

    const result = await markLighterKeyGeneratedEncryptedWith(client as never, {
      intentId: generatedRow.intent_id,
      reference: {
        kind: "encrypted_vault_reference",
        environment: "core",
        accountIndex: 42,
        apiKeyIndex: 6,
        vaultCredentialId: "lighter/core/account-42/api-key-6",
      },
      publicKey: `0x${"ab".repeat(40)}`,
      generatedAt: NOW,
    });

    expect(result).toMatchObject({
      executionState: "key_generated_encrypted",
      publicKey: "ab".repeat(40),
      vaultCredentialId: "lighter/core/account-42/api-key-6",
    });
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("execution_state = 'slot_reserved'");
    expect(sql).not.toMatch(/private_key/i);
    expect(JSON.stringify(params)).not.toContain("privateKey");
    expect(client.query.mock.calls[1]?.[0]).toContain("workflow_state = ANY($3)");
  });

  it("binds the public registration nonce before approval and records approval separately", async () => {
    const approvalPendingRow = {
      ...reservationRow(6),
      execution_state: "approval_pending",
      vault_credential_id: "lighter/core/account-42/api-key-6",
      public_key: "ab".repeat(40),
      public_key_fingerprint: "f".repeat(64),
      key_generated_at: NOW,
      registration_nonce: "0",
      registration_nonce_observed_at: NOW,
    };
    const prepareClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [approvalPendingRow], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [workflowRow("key_registration_approval_pending")],
          rowCount: 1,
        }),
    };
    const pending = await markLighterKeyRegistrationApprovalPendingWith(
      prepareClient as never,
      {
        intentId: approvalPendingRow.intent_id,
        sessionId: INPUT.sessionId,
        registrationNonce: "0",
        observedAt: NOW,
      },
    );
    expect(pending).toMatchObject({
      executionState: "approval_pending",
      registrationNonce: "0",
      registrationNonceObservedAt: NOW,
    });
    expect(prepareClient.query.mock.calls[0]?.[0]).toContain(
      "execution_state = 'key_generated_encrypted'",
    );
    expect(prepareClient.query.mock.calls[1]?.[1]?.[2]).toEqual([
      "key_generated_encrypted",
    ]);

    const approvedClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{
          ...approvalPendingRow,
          approval_status: "approved",
          execution_state: "approved",
        }],
        rowCount: 1,
      }),
    };
    const approved = await markLighterKeyRegistrationApprovedWith(
      approvedClient as never,
      {
        intentId: approvalPendingRow.intent_id,
        sessionId: INPUT.sessionId,
        approvalId: "approval-1",
      },
    );
    expect(approved).toMatchObject({
      approvalStatus: "approved",
      executionState: "approved",
      registrationNonce: "0",
    });
    expect(approvedClient.query.mock.calls[0]?.[0]).toContain(
      "approval_status = 'approval_pending'",
    );
  });

  it("renews only an approved intent with no signing or submission evidence", async () => {
    const expiresAt = new Date("2030-01-01T02:00:00.000Z");
    const pristine = lifecycleRow("approved", {
      registration_tx_type: null,
      registration_tx_hash: null,
      registration_tx_expired_at: null,
      registration_tx_staged_at: null,
      expires_at: expiresAt,
    });
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [pristine], rowCount: 1 }),
    };

    await expect(renewPristineApprovedLighterKeyRegistrationIntentWith(client as never, {
      intentId: String(pristine.intent_id),
      sessionId: INPUT.sessionId,
      expiresAt,
    })).resolves.toMatchObject({
      executionState: "approved",
      expiresAt,
    });

    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("approval_status = 'approved'");
    expect(sql).toContain("execution_state = 'approved'");
    expect(sql).toContain("registration_tx_hash IS NULL");
    expect(sql).toContain("registration_submitted_tx_hash IS NULL");
    expect(params).toEqual([pristine.intent_id, INPUT.sessionId, expiresAt]);
  });

  it("refuses an unresolved workflow that has not proven the requested account", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{
          workflow_state: "deposit_l2_pending",
          resolved_account_index: null,
          api_key_index: null,
        }],
        rowCount: 1,
      }),
    };

    await expect(reserveLighterApiKeySlotWith(client as never, INPUT)).rejects.toThrow(
      "does not match the resolved workflow account",
    );
  });

  it("stages only structural TxType 8 identity before recording sendTx acceptance", async () => {
    const stagedClient = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [lifecycleRow("key_registration_tx_staged")],
        rowCount: 1,
      }),
    };
    const staged = await markLighterKeyRegistrationTxStagedWith(stagedClient as never, {
      intentId: String(lifecycleRow("approved").intent_id),
      sessionId: INPUT.sessionId,
      txType: 8,
      txHash: "cd".repeat(40),
      expiredAt: "1893456000000",
      stagedAt: NOW,
    });
    expect(staged).toMatchObject({
      executionState: "key_registration_tx_staged",
      registrationTxType: 8,
      registrationTxHash: "cd".repeat(40),
    });
    const [stageSql, stageParams] = stagedClient.query.mock.calls[0]!;
    expect(stageSql).not.toMatch(/tx_info|l1_sig|signed_payload/i);
    expect(JSON.stringify(stageParams)).not.toMatch(/L1Sig|Sig|privateKey/);

    const submittedClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [lifecycleRow("change_pub_key_submitted", {
            registration_submitted_tx_hash: "cd".repeat(40),
            registration_submit_code: 200,
            registration_predicted_execution_time_ms: "50",
            registration_submit_accepted_at: NOW,
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [workflowRow("change_pub_key_submitted")],
          rowCount: 1,
        }),
    };
    const submitted = await markLighterKeyRegistrationSubmittedWith(
      submittedClient as never,
      {
        intentId: String(lifecycleRow("approved").intent_id),
        sessionId: INPUT.sessionId,
        txHash: "cd".repeat(40),
        submittedTxHash: "cd".repeat(40),
        submitCode: 200,
        predictedExecutionTimeMs: 50,
        acceptedAt: NOW,
      },
    );
    expect(submitted).toMatchObject({
      executionState: "change_pub_key_submitted",
      registrationSubmitCode: 200,
      registrationPredictedExecutionTimeMs: "50",
    });
    expect(submittedClient.query.mock.calls[1]?.[1]?.[2]).toEqual([
      "key_registration_approval_pending",
    ]);
  });

  it("moves ambiguity through exact verification, nonce synchronization, and activation", async () => {
    const intentId = String(lifecycleRow("approved").intent_id);
    const ambiguousClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [lifecycleRow("ambiguous", {
            registration_ambiguity_reason: "send_tx_transport",
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [workflowRow("ambiguous")], rowCount: 1 }),
    };
    await expect(markLighterKeyRegistrationAmbiguousWith(ambiguousClient as never, {
      intentId,
      sessionId: INPUT.sessionId,
      txHash: "cd".repeat(40),
      reason: "send_tx_transport",
    })).resolves.toMatchObject({
      executionState: "ambiguous",
      registrationAmbiguityReason: "send_tx_transport",
    });

    const verifiedClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [lifecycleRow("key_verified", {
            registration_key_verified_at: NOW,
            registration_client_checked_at: NOW,
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [workflowRow("key_verified")], rowCount: 1 }),
    };
    await expect(markLighterKeyRegistrationKeyVerifiedWith(verifiedClient as never, {
      intentId,
      sessionId: INPUT.sessionId,
      publicKey: "ab".repeat(40),
      verifiedAt: NOW,
      clientCheckedAt: NOW,
    })).resolves.toMatchObject({ executionState: "key_verified" });

    const nonceClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [lifecycleRow("nonce_synchronized", {
            registration_key_verified_at: NOW,
            registration_client_checked_at: NOW,
            post_registration_nonce: "1",
            registration_nonce_synchronized_at: NOW,
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [workflowRow("nonce_synchronized")], rowCount: 1 }),
    };
    await expect(markLighterKeyRegistrationNonceSynchronizedWith(nonceClient as never, {
      intentId,
      sessionId: INPUT.sessionId,
      nextNonce: "1",
      synchronizedAt: NOW,
    })).resolves.toMatchObject({
      executionState: "nonce_synchronized",
      postRegistrationNonce: "1",
    });

    const activeClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [lifecycleRow("active", {
            registration_key_verified_at: NOW,
            registration_client_checked_at: NOW,
            post_registration_nonce: "1",
            registration_nonce_synchronized_at: NOW,
            registration_activated_at: NOW,
          })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [workflowRow("ready_to_trade")], rowCount: 1 }),
    };
    await expect(markLighterKeyRegistrationActiveWith(activeClient as never, {
      intentId,
      sessionId: INPUT.sessionId,
      activatedAt: NOW,
    })).resolves.toMatchObject({
      executionState: "active",
      registrationActivatedAt: NOW,
    });
  });

  it("migration adds only structural key-registration evidence and uniqueness guards", async () => {
    const sql = await readFile(new URL(
      "../../vex-agent/db/migrations/097_lighter_key_registration_slots.sql",
      import.meta.url,
    ), "utf8");

    expect(sql).toContain("'slot_reserved'");
    expect(sql).toContain("api_key_index BETWEEN 4 AND 254");
    expect(sql).toContain("uq_lighter_key_registration_live_account");
    expect(sql).toContain("uq_lighter_key_registration_held_slot");
    expect(sql).not.toMatch(/private_key|auth_token|signed_payload/i);
  });

  it("metadata migration excludes private credential material", async () => {
    const sql = await readFile(new URL(
      "../../vex-agent/db/migrations/098_lighter_key_registration_metadata.sql",
      import.meta.url,
    ), "utf8");

    expect(sql).toContain("'key_generated_encrypted'");
    expect(sql).toContain("vault_credential_id");
    expect(sql).toContain("public_key_fingerprint");
    expect(sql).not.toMatch(/private_key|auth_token|signed_payload/i);
  });

  it("approval migration persists only the public nonce contract", async () => {
    const sql = await readFile(new URL(
      "../../vex-agent/db/migrations/099_lighter_key_registration_approval.sql",
      import.meta.url,
    ), "utf8");

    expect(sql).toContain("registration_nonce");
    expect(sql).toContain("281474976710655");
    expect(sql).not.toMatch(/private_key|l1_sig|signed_payload|tx_info/i);
  });

  it("transaction-identity migration forbids storing any signature or signed payload", async () => {
    const sql = await readFile(new URL(
      "../../vex-agent/db/migrations/100_lighter_key_registration_transaction_identity.sql",
      import.meta.url,
    ), "utf8");

    expect(sql).toContain("registration_tx_type = 8");
    expect(sql).toContain("registration_tx_hash ~ '^[0-9a-f]{80}$'");
    expect(sql).toContain("post_registration_nonce = registration_nonce + 1");
    expect(sql).not.toMatch(/private_key|l1_sig|signed_payload|tx_info/i);
  });
});
