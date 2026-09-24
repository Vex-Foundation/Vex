import { beforeEach, describe, expect, it } from "vitest";

import { inspectLighterApiKeySlots } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { defaultLighterTradingVaultCredentialId } from "@tools/lighter/trading-credentials.js";
import { execute, query, queryOne } from "@vex-agent/db/client.js";
import * as approvals from "@vex-agent/db/repos/approvals.js";
import {
  claimRegistrationSigning,
  findLighterKeyRegistrationIntent,
  markLighterKeyGeneratedEncryptedWith,
  markLighterKeyRegistrationAmbiguousWith,
  markLighterKeyRegistrationApprovalPendingWith,
  markLighterKeyRegistrationApprovedWith,
  markLighterKeyRegistrationExpiredUnconsumedWith,
  markLighterKeyRegistrationTxStagedWith,
  markRegistrationSendAttemptStarted,
  markRegistrationUnsubmitted,
  reserveLighterApiKeySlotWith,
} from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { restartFailedLighterKeyRegistrationWorkflowWith } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { makeSession } from "../setup/fixtures.js";

const WALLET = `0x${"7".repeat(40)}`;
const ACCOUNT_INDEX = 4242;
const PUBLIC_KEY = "ab".repeat(40);

let sessionId: string;

beforeEach(async () => {
  // This lane's global setup creates the database; refuse any other target.
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  await execute("TRUNCATE sessions RESTART IDENTITY CASCADE");
  await execute(
    "DELETE FROM lighter_onboarding_workflows WHERE environment = 'core' AND wallet_address = LOWER($1)",
    [WALLET],
  );
  sessionId = await makeSession();
});

/**
 * Drive the durable path a consent-expired registration actually takes: slot
 * reservation, encrypted key, approval, the single signing claim, and then the
 * refusal that must retire it. Every step is the repository's own public
 * transition against the real schema, because the defect this covers lives in
 * the row projection of the LAST one and nothing short of a real UPDATE with a
 * RETURNING row can produce it.
 */
async function approvedRegistrationIntent(): Promise<string> {
  const now = new Date();
  await execute(
    `INSERT INTO lighter_onboarding_workflows (
       environment, wallet_address, workflow_state, resolved_account_index
     ) VALUES ('core', LOWER($1), 'account_resolved', $2)`,
    [WALLET, ACCOUNT_INDEX],
  );
  const observation = inspectLighterApiKeySlots({
    code: 200,
    api_keys: [{
      account_index: ACCOUNT_INDEX,
      api_key_index: 4,
      nonce: 0,
      public_key: "05".repeat(40),
      transaction_time: 1,
    }],
  }, ACCOUNT_INDEX, now);

  const reserved = await withSessionControlLock(sessionId, (client) => reserveLighterApiKeySlotWith(client, {
    sessionId,
    environment: "core",
    walletAddress: WALLET,
    chainId: 1,
    accountIndex: ACCOUNT_INDEX,
    observation,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    now,
  }));
  expect(reserved.outcome).toBe("created");
  const intentId = reserved.reservation.intentId;
  const scope = {
    environment: reserved.reservation.environment,
    accountIndex: reserved.reservation.accountIndex,
    apiKeyIndex: reserved.reservation.apiKeyIndex,
  };

  const generated = await withSessionControlLock(sessionId, (client) => markLighterKeyGeneratedEncryptedWith(client, {
    intentId,
    reference: {
      kind: "encrypted_vault_reference",
      ...scope,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
    },
    publicKey: PUBLIC_KEY,
    generatedAt: now,
  }));
  expect(generated?.executionState).toBe("key_generated_encrypted");

  const pending = await withSessionControlLock(sessionId, (client) =>
    markLighterKeyRegistrationApprovalPendingWith(client, {
      intentId,
      sessionId,
      registrationNonce: "0",
      observedAt: now,
    }));
  expect(pending?.executionState).toBe("approval_pending");

  const approvalId = `approval-${intentId}`;
  await approvals.enqueue(
    approvalId,
    { command: "execute_tool", args: { toolId: "lighter.key.register", params: { intentId } } },
    "Register a Lighter API key",
    sessionId,
  );
  const approved = await withSessionControlLock(sessionId, (client) =>
    markLighterKeyRegistrationApprovedWith(client, { intentId, sessionId, approvalId }));
  expect(approved?.executionState).toBe("approved");
  return intentId;
}

describe("Lighter key-registration refusal against isolated PostgreSQL", () => {
  it("retires a consent-expired registration, settles its workflow, and refuses a second signing attempt", async () => {
    const intentId = await approvedRegistrationIntent();
    expect(await claimRegistrationSigning({ intentId, sessionId })).toBe(true);

    // The refusal a consent expiry after signing produces. Before the terminal
    // `failed` row was projectable, this call threw inside its transaction and
    // rolled the whole settlement back, leaving the registration stuck.
    await expect(markRegistrationUnsubmitted({
      intentId,
      sessionId,
      reason: "consent_expired_after_signing",
    })).resolves.toBe(true);

    expect(await query<{ execution_state: string; registration_ambiguity_reason: string }>(
      `SELECT execution_state, registration_ambiguity_reason
         FROM lighter_onboarding_intents WHERE intent_id = $1`,
      [intentId],
    )).toEqual([{
      execution_state: "failed",
      registration_ambiguity_reason: "consent_expired_after_signing",
    }]);

    expect(await query<{ workflow_state: string; failure_code: string }>(
      `SELECT workflow_state, failure_code
         FROM lighter_onboarding_workflows
        WHERE environment = 'core' AND wallet_address = LOWER($1)`,
      [WALLET],
    )).toEqual([{ workflow_state: "failed", failure_code: "consent_expired_after_signing" }]);

    // The retired row is readable, not a poison pill for every later read.
    expect(await findLighterKeyRegistrationIntent(intentId)).toMatchObject({
      intentId,
      executionState: "failed",
    });

    // No fresh signing authority: the refusal is terminal, not a retry point.
    expect(await claimRegistrationSigning({ intentId, sessionId })).toBe(false);
    expect(await markRegistrationUnsubmitted({
      intentId,
      sessionId,
      reason: "consent_expired_after_signing",
    })).toBe(false);
  });
});

describe("a failed key registration can start again (isolated PostgreSQL)", () => {
  const TX_HASH = "cd".repeat(40);
  const GRACE_MS = 10 * 60_000;

  function observation(now = new Date()) {
    return inspectLighterApiKeySlots({
      code: 200,
      api_keys: [{
        account_index: ACCOUNT_INDEX,
        api_key_index: 4,
        nonce: 0,
        public_key: "05".repeat(40),
        transaction_time: 1,
      }],
    }, ACCOUNT_INDEX, now);
  }
  const restart = () => withSessionControlLock(sessionId, (client) =>
    restartFailedLighterKeyRegistrationWorkflowWith(client, {
      environment: "core", walletAddress: WALLET, accountIndex: ACCOUNT_INDEX,
    }));
  const reserveFresh = () => withSessionControlLock(sessionId, (client) => reserveLighterApiKeySlotWith(client, {
    sessionId, environment: "core", walletAddress: WALLET, chainId: 1, accountIndex: ACCOUNT_INDEX,
    observation: observation(), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  }));
  async function workflow() {
    return queryOne<{ workflow_state: string; api_key_index: number | null; public_key_fingerprint: string | null; failure_code: string | null }>(
      `SELECT workflow_state, api_key_index, public_key_fingerprint, failure_code
         FROM lighter_onboarding_workflows WHERE environment = 'core' AND wallet_address = LOWER($1)`,
      [WALLET],
    );
  }
  /** A registration whose signed transaction may have been sent and went ambiguous. */
  async function sentAndAmbiguous(expiredAtMs: number): Promise<string> {
    const intentId = await approvedRegistrationIntent();
    expect(await claimRegistrationSigning({ intentId, sessionId })).toBe(true);
    expect(await withSessionControlLock(sessionId, (client) => markLighterKeyRegistrationTxStagedWith(client, {
      intentId, sessionId, txType: 8, txHash: TX_HASH, expiredAt: String(expiredAtMs), stagedAt: new Date(),
    }))).toMatchObject({ executionState: "key_registration_tx_staged" });
    expect(await markRegistrationSendAttemptStarted({ intentId, sessionId, txHash: TX_HASH })).toBe(true);
    expect(await withSessionControlLock(sessionId, (client) => markLighterKeyRegistrationAmbiguousWith(client, {
      intentId, sessionId, txHash: TX_HASH, reason: "send_tx_outcome_unknown",
    }))).toMatchObject({ executionState: "ambiguous" });
    return intentId;
  }

  it("returns a workflow failed by a refused registration to account_resolved, and a fresh slot can be reserved", async () => {
    const intentId = await approvedRegistrationIntent();
    expect(await claimRegistrationSigning({ intentId, sessionId })).toBe(true);
    expect(await markRegistrationUnsubmitted({ intentId, sessionId, reason: "consent_expired_after_signing" })).toBe(true);

    expect(await restart()).toMatchObject({ workflowState: "account_resolved", apiKeyIndex: null, resolvedAccountIndex: ACCOUNT_INDEX });
    expect(await workflow()).toEqual({
      workflow_state: "account_resolved", api_key_index: null, public_key_fingerprint: null, failure_code: null,
    });
    const fresh = await reserveFresh();
    expect(fresh.outcome).toBe("created");
    expect(fresh.reservation.intentId).not.toBe(intentId);
  });

  it("fails a sent registration only after its signed expiry plus the grace, then lets it start again", async () => {
    const intentId = await sentAndAmbiguous(Date.now() - GRACE_MS - 60_000);

    expect(await withSessionControlLock(sessionId, (client) =>
      markLighterKeyRegistrationExpiredUnconsumedWith(client, { intentId, sessionId, graceMs: GRACE_MS })))
      .toMatchObject({ executionState: "failed", registrationAmbiguityReason: "expired_without_nonce_consumption" });
    expect(await workflow()).toMatchObject({ workflow_state: "failed", failure_code: "key_registration_expired_unconsumed" });

    expect(await restart()).toMatchObject({ workflowState: "account_resolved", apiKeyIndex: null });
    expect((await reserveFresh()).outcome).toBe("created");
  });

  it("refuses to fail a sent registration whose signed expiry plus the grace has not passed", async () => {
    const intentId = await sentAndAmbiguous(Date.now() - GRACE_MS + 60_000);

    expect(await withSessionControlLock(sessionId, (client) =>
      markLighterKeyRegistrationExpiredUnconsumedWith(client, { intentId, sessionId, graceMs: GRACE_MS }))).toBeNull();
    expect(await findLighterKeyRegistrationIntent(intentId)).toMatchObject({ executionState: "ambiguous" });
    expect(await workflow()).toMatchObject({ workflow_state: "ambiguous" });
  });

  it("never restarts after a registration that may have been sent and was not proven expired unused", async () => {
    const intentId = await sentAndAmbiguous(Date.now() - GRACE_MS - 60_000);
    // A failure with a send attempt and no expiry proof: the key may be on chain.
    await execute(
      `UPDATE lighter_onboarding_intents SET execution_state = 'failed', registration_ambiguity_reason = 'send_tx_outcome_unknown'
        WHERE intent_id = $1`,
      [intentId],
    );
    await execute(
      "UPDATE lighter_onboarding_workflows SET workflow_state = 'failed' WHERE environment = 'core' AND wallet_address = LOWER($1)",
      [WALLET],
    );

    expect(await restart()).toBeNull();
    expect(await workflow()).toMatchObject({ workflow_state: "failed" });
  });

  it("never restarts a workflow that failed without any key registration", async () => {
    await execute(
      `INSERT INTO lighter_onboarding_workflows (environment, wallet_address, workflow_state, resolved_account_index, api_key_index)
       VALUES ('core', LOWER($1), 'failed', $2, 4)`,
      [WALLET, ACCOUNT_INDEX],
    );
    expect(await restart()).toBeNull();
  });
});
