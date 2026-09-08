/**
 * LIVE STEP 1 - register a Lighter trading key on the owner's Robinhood Chain
 * account through the real prepare -> approve -> resume -> reconcile chain.
 *
 * Gated by `VEX_LIGHTER_LIVE_KEY_REGISTRATION=1`. With the flag unset the whole
 * file skips. See `README.md` for the exact command.
 *
 * WHAT THIS PROVES that no fixture test can: that the packaged signer helper
 * generates and encrypts a key, that the vault-derived public key is the one
 * Lighter records, that the EIP-191 ownership message the owner's wallet signs
 * is accepted as a TxType 8 transaction, and that reconciliation reaches
 * `active` against Lighter's own `apiKeys` read rather than against our own
 * self-report (rule 06: verify the world).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness.js")).electronMainStub());

import {
  approveAndResume,
  createLiveSession,
  EXPECTED_ACCOUNT_INDEX,
  flagEnabled,
  installLighterProductionSeams,
  isDryRun,
  LIVE_ENVIRONMENT,
  LIVE_FLAGS,
  openEvidence,
  pollUntil,
  prepareAndEnqueueApproval,
  printInspectionSql,
  readApprovalRecord,
  requireLiveTarget,
  runReadTool,
  type EvidenceWriter,
  type LiveSession,
} from "./harness.js";

const describeLive = flagEnabled(LIVE_FLAGS.keyRegistration) ? describe : describe.skip;

let disposeSeams: (() => void) | null = null;
let session: LiveSession | null = null;
let evidence: EvidenceWriter | null = null;
const approvalIds: string[] = [];

beforeAll(async () => {
  evidence = openEvidence("key-registration");
  const target = await requireLiveTarget();
  if (isDryRun()) {
    const { runMigrations } = await import("@vex-agent/db/migrate.js");
    await runMigrations();
  }
  disposeSeams = await installLighterProductionSeams();
  session = await createLiveSession(target, "keyreg");
  evidence.record("target", {
    environment: LIVE_ENVIRONMENT,
    accountIndex: target.accountIndex,
    walletAddress: target.walletAddress,
    sessionId: session.sessionId,
    dryRun: isDryRun(),
  });
});

afterAll(async () => {
  if (session !== null) printInspectionSql(session.sessionId, approvalIds);
  disposeSeams?.();
  const { closePool } = await import("@vex-agent/db/client.js");
  await closePool();
});

function requireSession(): LiveSession {
  if (session === null) throw new Error("The live session was not created.");
  return session;
}

function requireEvidence(): EvidenceWriter {
  if (evidence === null) throw new Error("The evidence writer was not opened.");
  return evidence;
}

describeLive("Lighter key registration on the owner's Robinhood Chain account", () => {
  it("prepares, approves, signs and reconciles one registration", { timeout: 600_000 }, async () => {
    const live = requireSession();
    const record = requireEvidence();

    const prepared = await prepareAndEnqueueApproval({
      sessionId: live.sessionId,
      publicName: "lighter__key_register_prepare",
      params: { environment: LIVE_ENVIRONMENT },
    });
    approvalIds.push(prepared.approvalId);

    const card = await readApprovalRecord(prepared.approvalId);
    // The card must be UNDECIDED and bound to the resume tool before anybody
    // approves it. A pre-decided row would mean the harness, not the operator,
    // authorized the signature.
    expect(card.queueStatus).toBe("pending");
    expect(card.decision).toBeNull();
    expect(card.executionStatus).toBe("not_started");
    expect(card.source).toBe("agent");
    expect(card.actionKind).toBe("user_wallet_broadcast");
    expect(prepared.followUpToolId).toBe("lighter.key.register");

    const prepareJson = JSON.parse(prepared.prepareOutput) as Record<string, unknown>;
    expect(prepareJson["environment"]).toBe(LIVE_ENVIRONMENT);
    expect(prepareJson["accountIndex"]).toBe(EXPECTED_ACCOUNT_INDEX);
    const intentId = prepareJson["intentId"];
    expect(typeof intentId).toBe("string");

    record.record("prepared", {
      approvalId: prepared.approvalId,
      intentId,
      accountIndex: prepareJson["accountIndex"],
      apiKeyIndex: prepareJson["apiKeyIndex"],
      publicKeyFingerprint: prepareJson["publicKeyFingerprint"],
      registrationNonce: prepareJson["registrationNonce"],
      expiresAt: prepareJson["expiresAt"],
      approvalCard: card,
    });

    if (isDryRun()) {
      // The dry run stops HERE, one step before the decision. `prepareApprove`
      // decides AND dispatches in one production call, so there is no honest
      // way to record the approval without also signing.
      expect(card.preview).not.toBeNull();
      return;
    }

    const dispatched = await approveAndResume(prepared.approvalId);
    expect(dispatched.executionStatus).toBe("succeeded");
    expect(dispatched.toolResult.success, dispatched.toolResult.output).toBe(true);
    record.record("approved-and-signed", {
      approvalId: prepared.approvalId,
      executionStatus: dispatched.executionStatus,
      resumeToolOutput: dispatched.toolResult.output,
    });

    const reconciliation = await pollUntil(
      { attempts: 30, intervalMs: 10_000, what: "key registration active" },
      () => runReadTool({
        sessionId: live.sessionId,
        publicName: "lighter__key_register_status",
        params: { environment: LIVE_ENVIRONMENT, intentId },
      }),
      // `status` is the reconciler's verdict, and "active" is the only value it
      // returns once Lighter shows the exact vault-derived public key, the
      // official client check passes and the nonce is synchronized.
      (attempt) => (attempt.json as Record<string, unknown> | null)?.["status"] === "active",
    );

    const apiKeys = await runReadTool({
      sessionId: live.sessionId,
      publicName: "lighter__api_keys_inspect",
      params: {
        environment: LIVE_ENVIRONMENT,
        accountIndex: EXPECTED_ACCOUNT_INDEX,
        apiKeyIndex: prepareJson["apiKeyIndex"],
        limit: 10,
      },
    });

    record.record("reconciled", {
      approvalId: prepared.approvalId,
      intentId,
      settled: reconciliation.settled,
      // Every attempt, not only the last: on a money path the sequence of
      // provider answers is the evidence.
      attempts: reconciliation.attempts.map((attempt) => attempt.output),
      lighterApiKeysRead: apiKeys.output,
    });

    expect(reconciliation.settled, reconciliation.attempts.at(-1)?.output ?? "no attempt").toBe(true);
    expect(apiKeys.success, apiKeys.output).toBe(true);
  });
});
