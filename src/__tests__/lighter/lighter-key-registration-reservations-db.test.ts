import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inspectLighterApiKeySlots } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { defaultLighterTradingVaultCredentialId } from "@tools/lighter/trading-credentials.js";
import { closePool, execute, query } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import {
  markLighterKeyRegistrationApprovalPendingWith,
  markLighterKeyGeneratedEncryptedWith,
  reserveLighterApiKeySlotWith,
} from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

const RUN = process.env.VEX_LIGHTER_ONBOARDING_DB === "1";
const d = RUN ? describe : describe.skip;
const SESSION_IDS: string[] = [];
const WALLETS = new Set<string>();

beforeAll(async () => {
  if (RUN) await runMigrations();
});

afterAll(async () => {
  for (const sessionId of SESSION_IDS) {
    await execute("DELETE FROM sessions WHERE id = $1", [sessionId]).catch(() => undefined);
  }
  for (const walletAddress of WALLETS) {
    await execute(
      "DELETE FROM lighter_onboarding_workflows WHERE environment = 'core' AND wallet_address = LOWER($1)",
      [walletAddress],
    ).catch(() => undefined);
  }
  if (RUN) await closePool();
});

async function newSession(): Promise<string> {
  const sessionId = `lighter-key-slot-test-${randomUUID()}`;
  await execute("INSERT INTO sessions (id, permission) VALUES ($1, 'restricted')", [sessionId]);
  SESSION_IDS.push(sessionId);
  return sessionId;
}

d("Lighter Phase 3 API-key slot reservation database boundary", () => {
  it("serializes two sessions onto one durable account slot", async () => {
    const firstSessionId = await newSession();
    const secondSessionId = await newSession();
    const walletAddress = `0x${createHash("sha256")
      .update(firstSessionId)
      .digest("hex")
      .slice(0, 40)}`;
    const accountIndex = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16) + 1;
    WALLETS.add(walletAddress);
    await execute(
      `INSERT INTO lighter_onboarding_workflows (
         environment, wallet_address, workflow_state, resolved_account_index
       ) VALUES ('core', LOWER($1), 'account_resolved', $2)`,
      [walletAddress, accountIndex],
    );

    const now = new Date();
    const observation = inspectLighterApiKeySlots({
      code: 200,
      api_keys: [{
        account_index: accountIndex,
        api_key_index: 4,
        nonce: 0,
        public_key: "05".repeat(40),
        transaction_time: 1,
      }],
    }, accountIndex, now);
    const reserve = (sessionId: string) => withSessionControlLock(sessionId, (client) =>
      reserveLighterApiKeySlotWith(client, {
        sessionId,
        environment: "core",
        walletAddress,
        chainId: 1,
        accountIndex,
        observation,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        now,
      }));

    const outcomes = await Promise.all([
      reserve(firstSessionId),
      reserve(secondSessionId),
    ]);

    expect(outcomes.map((item) => item.outcome).sort()).toEqual([
      "created",
      "live_conflict",
    ]);
    expect(new Set(outcomes.map((item) => item.reservation.intentId)).size).toBe(1);
    expect(new Set(outcomes.map((item) => item.reservation.apiKeyIndex))).toEqual(new Set([5]));

    const rows = await query<{ intent_id: string; api_key_index: number }>(
      `SELECT intent_id, api_key_index
         FROM lighter_onboarding_intents
        WHERE environment = 'core'
          AND resolved_account_index = $1
          AND capability = 'key_registration'`,
      [accountIndex],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.api_key_index).toBe(5);

    const ownerSessionId = outcomes.find((item) => item.outcome === "created")?.reservation.sessionId;
    if (ownerSessionId === undefined) throw new Error("expected one created reservation");
    const moneyState = await withSessionControlLock(ownerSessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, ownerSessionId));
    expect(moneyState).toMatchObject({
      clear: false,
      reasons: [expect.objectContaining({
        kind: "lighter_onboarding_unresolved",
        detail: "slot_reserved",
      })],
    });

    const createdReservation = outcomes.find((item) => item.outcome === "created")?.reservation;
    if (createdReservation === undefined) throw new Error("expected a created reservation");
    const scope = {
      environment: createdReservation.environment,
      accountIndex: createdReservation.accountIndex,
      apiKeyIndex: createdReservation.apiKeyIndex,
    };
    const generated = await withSessionControlLock(ownerSessionId, (client) =>
      markLighterKeyGeneratedEncryptedWith(client, {
        intentId: createdReservation.intentId,
        reference: {
          kind: "encrypted_vault_reference",
          ...scope,
          vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
        },
        publicKey: "ab".repeat(40),
        generatedAt: now,
      }));
    expect(generated).toMatchObject({
      executionState: "key_generated_encrypted",
      vaultCredentialId: "lighter/core/account-" + accountIndex + "/api-key-5",
      publicKey: "ab".repeat(40),
      publicKeyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const workflow = await query<{
      workflow_state: string;
      api_key_index: number;
      public_key_fingerprint: string;
    }>(
      `SELECT workflow_state, api_key_index, public_key_fingerprint
         FROM lighter_onboarding_workflows
        WHERE environment = 'core' AND wallet_address = LOWER($1)`,
      [walletAddress],
    );
    expect(workflow[0]).toMatchObject({
      workflow_state: "key_generated_encrypted",
      api_key_index: 5,
      public_key_fingerprint: generated?.publicKeyFingerprint,
    });

    const approvalPending = await withSessionControlLock(ownerSessionId, (client) =>
      markLighterKeyRegistrationApprovalPendingWith(client, {
        intentId: createdReservation.intentId,
        sessionId: ownerSessionId,
        registrationNonce: "0",
        observedAt: now,
      }));
    expect(approvalPending).toMatchObject({
      executionState: "approval_pending",
      registrationNonce: "0",
      registrationNonceObservedAt: now,
    });
    const approvalWorkflow = await query<{
      workflow_state: string;
      public_key_fingerprint: string;
    }>(
      `SELECT workflow_state, public_key_fingerprint
         FROM lighter_onboarding_workflows
        WHERE environment = 'core' AND wallet_address = LOWER($1)`,
      [walletAddress],
    );
    expect(approvalWorkflow[0]).toMatchObject({
      workflow_state: "key_registration_approval_pending",
      public_key_fingerprint: generated?.publicKeyFingerprint,
    });
  });
});
