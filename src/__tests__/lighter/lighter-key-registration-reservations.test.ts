import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { inspectLighterApiKeySlots } from "@tools/lighter/wallet-funding/api-key-slots.js";
import {
  markLighterKeyGeneratedEncryptedWith,
  reserveLighterApiKeySlotWith,
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
});
