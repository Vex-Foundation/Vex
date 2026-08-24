/**
 * THE BINDING, PROVEN THROUGH THE REAL PATH, on real PostgreSQL.
 *
 * The rule this file exists to enforce is the one the reviewer wrote down: the
 * binding must never be INJECTED into the enqueue seam by a test. So nothing
 * here constructs a `PreparedApprovalBinding`. The REAL confirm handler is
 * called, it rebuilds the binding from the durable intent row, and the result
 * it produces - whole, untouched - is what the REAL Studio enqueue seam
 * receives, exactly as `runStudioCall` hands it over.
 *
 * What is then asserted is what a human and a dispatch actually see:
 *
 *   - the approval CARD carries the decoded effect and the INTENT's own expiry,
 *     not `{walletFamily, intentId}` and not the one-hour default TTL;
 *   - the stored envelope carries the proposal binding, so the canonical
 *     REQUEST DIGEST covers the proposal - recomputing it over the stored value
 *     reproduces the digest written at enqueue;
 *   - the approved RESUME compares against that approval-bound digest: a
 *     resume under an approval granted for a DIFFERENT proposal refuses, with
 *     nothing signed and the intent still pending.
 *
 * NOT COVERED HERE, and stated rather than implied: `runStudioCall` itself (the
 * readiness barrier, the scope snapshot, the waiter broker). It lives in the
 * Electron main package and passes the handler's result to this seam WHOLE -
 * `vex-app/src/main/studio/__tests__/approval-service.test.ts` pins that one
 * hop. Everything the binding does happens on this side of it.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as intentsRepo from "@vex-agent/db/repos/wallet-transaction-intents.js";
import { PROPOSAL_DIGEST_VERSION } from "@vex-agent/db/contracts/wallet-transaction-intent.js";
import { enqueueStudioApprovalIntent } from "@vex-agent/mcp/approvals.js";
import { computeRequestDigest } from "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { handleWalletEvmTransactionConfirm } from "@vex-agent/tools/internal/wallet/transaction/confirm-evm.js";
import { digestOfIntent } from "@vex-agent/tools/internal/wallet/transaction/revalidate.js";
import { canonicalTransactionPreview } from "@vex-agent/tools/internal/wallet/transaction/preview.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x2222222222222222222222222222222222222222";

/** A restricted Studio-shaped context: no approval yet, so the gate must stop. */
function restrictedContext(sessionId: string): InternalToolContext {
  return baseContext(sessionId, { approved: false });
}

/**
 * The context the enqueue's POLICY SNAPSHOT actually reads. Written out rather
 * than cast from `{}`: the snapshot is persisted on the intent row, so a
 * half-built context fails at the JSONB boundary, which is the boundary doing
 * its job.
 */
function baseContext(
  sessionId: string,
  overrides: Partial<InternalToolContext>,
): InternalToolContext {
  return {
    sessionId,
    loadedDocuments: new Map<string, string>(),
    sessionPermission: "restricted",
    approved: false,
    missionRunId: null,
    missionId: null,
    planMode: false,
    sessionKind: "chat",
    contextUsageBand: "normal",
    walletResolution: { source: "session", sessionId },
    walletPolicy: { kind: "none" },
    ...overrides,
  } as unknown as InternalToolContext;
}

/** The same context after the user approved, naming the approval it resumes. */
function approvedContext(sessionId: string, approvalId: string): InternalToolContext {
  return baseContext(sessionId, { approved: true, approvalId });
}

/**
 * One prepared ERC-20 approval intent with a REAL proposal digest - the digest
 * this build computes over the row, so the confirm handler's own recompute
 * matches rather than being satisfied by a fixture constant.
 */
const DECODED = {
  family: "eip155" as const,
  role: "approve" as const,
  standard: "erc20" as const,
  functionName: "approve",
  contract: TOKEN,
  criticalArgs: { spender: SPENDER, token: TOKEN, amountRaw: "1000000" },
  unlimitedApproval: false,
  warnings: [] as string[],
};

const FEE_BOUNDS = {
  mode: "eip1559" as const,
  gasLimit: "60000",
  maxFeePerGasWei: "1000000000",
  maxPriorityFeePerGasWei: "1000000",
  maxTotalFeeWei: "60000000000000",
};

/**
 * The CANONICAL card for the fixture row. Derived, never hand-written: V2 folds
 * it into the digest and the binding refuses a row whose stored card is not the
 * one its own bound fields render, so a hand-written approximation would be
 * indistinguishable from the edit the refusal exists to catch.
 */
const CANONICAL_PREVIEW = canonicalTransactionPreview({
  family: "eip155",
  chainAlias: "base",
  decoded: DECODED,
  feeBounds: FEE_BOUNDS,
});

async function prepareApprovalIntent(sessionId: string): Promise<intentsRepo.WalletTransactionIntent> {
  const intentId = `wtx-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await withSessionControlLock(sessionId, (client) =>
    intentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: WALLET,
      family: "eip155",
      chainAlias: "base",
      chainId: 8453,
      payload: { family: "eip155", evm: { to: TOKEN, data: "0x095ea7b3", valueWei: "0" } },
      decoded: DECODED,
      preview: CANONICAL_PREVIEW,
      feeBounds: FEE_BOUNDS,
      // Any valid 64-char hex; the real digest is written by the UPDATE below.
      proposalDigest: "0".repeat(64),
      proposalDigestVersion: PROPOSAL_DIGEST_VERSION,
      recentBlockhash: null,
      lastValidBlockHeight: null,
      expiresAt,
    }),
  );
  const draft = await intentsRepo.getById(intentId, sessionId);
  if (draft === null) throw new Error("intent did not persist");
  await execute(
    "UPDATE wallet_transaction_intents SET proposal_digest = $2 WHERE intent_id = $1",
    [intentId, digestOfIntent(draft)],
  );
  const row = await intentsRepo.getById(intentId, sessionId);
  if (row === null) throw new Error("intent did not persist");
  return row;
}

async function makeProject(sessionId: string): Promise<string> {
  const projectId = randomUUID();
  await execute(
    `INSERT INTO projects (id, name, slug, root_path, permission, backing_session_id, scope_version)
     VALUES ($1, 'demo', $2, $2, 'restricted', $3, 1)`,
    [projectId, `p-${projectId.slice(0, 8)}`, sessionId],
  );
  return projectId;
}

/** The Studio enqueue, given the handler's own result. Nothing is fabricated. */
async function enqueueThroughStudio(
  projectId: string,
  sessionId: string,
  result: ToolResult,
) {
  return enqueueStudioApprovalIntent({
    scope: {
      projectId,
      scopeVersion: 1,
      permission: "restricted",
      backingSessionId: sessionId,
      wallets: { evm: null, solana: null },
    },
    call: {
      name: "WalletEvmTransactionConfirm",
      args: { intentId: String(result.preparedApprovalBinding?.resource.intentId ?? "") },
      toolCallId: "call-1",
    },
    result,
    toolContext: restrictedContext(sessionId),
    readStudioRuntimeAvailability: () => ({ available: true }),
  });
}

describe("the prepared-approval binding, confirm handler -> Studio enqueue -> approval row", () => {
  beforeEach(async () => {
    await resetDb();
    // `resetDb` truncates every table, and the Studio dispatch fence is a
    // singleton row migration 086 seeds once. Without it the enqueue gate
    // correctly refuses "cannot verify the runtime is dispatchable", which is
    // the gate working, not a fixture detail worth hiding.
    await execute(
      "INSERT INTO studio_runtime_gate (id, dispatch_generation) VALUES (1, 1) ON CONFLICT (id) DO NOTHING",
    );
  });

  it("stops for approval having rebuilt the binding from the durable row", async () => {
    const sessionId = await makeSession();
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );

    expect(result.pendingApproval).toBe(true);
    const binding = result.preparedApprovalBinding;
    expect(binding).toBeDefined();
    // Rebuilt from the ROW: the digest, the expiry and the decoded preview all
    // come from what was persisted at prepare, not from a caller.
    expect(binding?.proposalDigest).toBe(intent.proposalDigest);
    expect(binding?.intentExpiresAt).toBe(intent.expiresAt);
    expect(binding?.resource).toEqual({
      table: "wallet_transaction_intents",
      intentId: intent.intentId,
    });
    expect(binding?.preview.label).toContain("approve");

    // NOTHING moved: the intent is still pending and nothing was claimed.
    const after = await intentsRepo.getById(intent.intentId, sessionId);
    expect(after?.status).toBe("pending");
  });

  it("writes an approval card carrying the decoded effect and the INTENT's own expiry", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") {
      throw new Error(`expected an enqueue, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }

    const intentRow = await queryOne<{ preview_json: Record<string, unknown>; expires_at: Date }>(
      "SELECT preview_json, expires_at FROM approval_intents WHERE approval_id = $1",
      [outcome.approvalId],
    );
    const card = intentRow?.preview_json as {
      toolName: string;
      criticalArgs: Record<string, unknown>;
    };
    expect(card.criticalArgs.effect).toBe(intent.preview.label);
    expect(card.criticalArgs.spender).toBe(SPENDER);
    expect(card.criticalArgs.intentId).toBe(intent.intentId);
    // The APPROVAL cannot outlive the proposal it would broadcast: the intent's
    // own expiry floors the enqueue path's default TTL.
    expect(new Date(intentRow?.expires_at ?? 0).toISOString()).toBe(intent.expiresAt);
  });

  it("folds the proposal digest into the canonical request digest", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    const queue = await queryOne<{ tool_call: Record<string, unknown> }>(
      "SELECT tool_call FROM approval_queue WHERE id = $1",
      [outcome.approvalId],
    );
    const stored = queue?.tool_call ?? {};
    const bound = stored.proposalBinding as { proposalDigest: string; resource: { intentId: string } };
    expect(bound.proposalDigest).toBe(intent.proposalDigest);
    expect(bound.resource.intentId).toBe(intent.intentId);

    const digestRow = await queryOne<{ request_digest: string | null }>(
      "SELECT request_digest FROM approval_intents WHERE approval_id = $1",
      [outcome.approvalId],
    );
    // The digest the dispatch will recompute is a digest OVER the envelope that
    // carries the binding, so changing the proposal changes it.
    expect(digestRow?.request_digest).toBe(computeRequestDigest(stored));
    const withoutBinding = { ...stored };
    delete withoutBinding.proposalBinding;
    expect(computeRequestDigest(withoutBinding)).not.toBe(digestRow?.request_digest);
  });

  it("the approved resume refuses an approval granted for a DIFFERENT proposal", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const approved = await prepareApprovalIntent(sessionId);
    const other = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: approved.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    // Resume the OTHER intent under this approval. Same session, same tool,
    // same shape - and an approval that was never granted for it.
    const resumed = await handleWalletEvmTransactionConfirm(
      { intentId: other.intentId },
      approvedContext(sessionId, outcome.approvalId),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toContain("different prepared action");
    const still = await intentsRepo.getById(other.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  // ── V2: the CARD is bound, and both durable copies of it are checked ──

  it("refuses at the approval gate when preview_json was edited BEFORE enqueue", async () => {
    const sessionId = await makeSession();
    const intent = await prepareApprovalIntent(sessionId);

    // The row's own digest still recomputes correctly under V1 rules: nothing
    // the old preimage covered has moved. Only the SENTENCE a human would read
    // has, which is exactly what V2 exists to catch.
    await execute(
      "UPDATE wallet_transaction_intents SET preview_json = $2 WHERE intent_id = $1",
      [
        intent.intentId,
        JSON.stringify({
          label: `approve: let ${SPENDER} spend 1 (raw) of ${TOKEN}`,
          criticalArgs: { ...CANONICAL_PREVIEW.criticalArgs },
        }),
      ],
    );

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );

    expect(result.success).toBe(false);
    expect(result.pendingApproval).toBeFalsy();
    expect(result.preparedApprovalBinding).toBeUndefined();
    expect(result.output).toContain("was changed after the transaction was prepared");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  it("refuses the dispatch when the approval ENVELOPE's preview was edited after enqueue", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    const queue = await queryOne<{ tool_call: Record<string, unknown> }>(
      "SELECT tool_call FROM approval_queue WHERE id = $1",
      [outcome.approvalId],
    );
    const stored = queue?.tool_call ?? {};
    const bound = stored.proposalBinding as Record<string, unknown>;
    const preview = bound.preview as { label: string; criticalArgs: Record<string, unknown> };
    await execute("UPDATE approval_queue SET tool_call = $2 WHERE id = $1", [
      outcome.approvalId,
      JSON.stringify({
        ...stored,
        proposalBinding: {
          ...bound,
          preview: { ...preview, label: "Send 1 wei to a friendly address" },
        },
      }),
    ]);

    const resumed = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      approvedContext(sessionId, outcome.approvalId),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toContain("is not the description this transaction produces");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  it("refuses the dispatch when the durable approval CARD was edited after enqueue", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    const cardRow = await queryOne<{ preview_json: Record<string, unknown> }>(
      "SELECT preview_json FROM approval_intents WHERE approval_id = $1",
      [outcome.approvalId],
    );
    const card = cardRow?.preview_json as { toolName: string; criticalArgs: Record<string, unknown> };
    await execute("UPDATE approval_intents SET preview_json = $2 WHERE approval_id = $1", [
      outcome.approvalId,
      JSON.stringify({
        ...card,
        criticalArgs: { ...card.criticalArgs, amountRaw: "1" },
      }),
    ]);

    const resumed = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      approvedContext(sessionId, outcome.approvalId),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toContain("is not the card this transaction produces");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  it("refuses the dispatch when the card's TOOL NAME - what the UI renders as the TITLE - was edited", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    const cardRow = await queryOne<{ preview_json: Record<string, unknown> }>(
      "SELECT preview_json FROM approval_intents WHERE approval_id = $1",
      [outcome.approvalId],
    );
    const card = cardRow?.preview_json as { toolName: string; criticalArgs: Record<string, unknown> };
    expect(card.toolName).toBe("WalletEvmTransactionConfirm");
    // EVERY money fact stays true. Only the TITLE changes - which is precisely
    // the edit that shows a human a harmless heading over an envelope that still
    // dispatches the transaction.
    await execute("UPDATE approval_intents SET preview_json = $2 WHERE approval_id = $1", [
      outcome.approvalId,
      JSON.stringify({ ...card, toolName: "WalletBalanceRead" }),
    ]);

    const resumed = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      approvedContext(sessionId, outcome.approvalId),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toContain("is not the card this transaction produces");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  it("refuses the dispatch when a NAMESPACE was added to the durable card", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    const cardRow = await queryOne<{ preview_json: Record<string, unknown> }>(
      "SELECT preview_json FROM approval_intents WHERE approval_id = $1",
      [outcome.approvalId],
    );
    const card = cardRow?.preview_json as Record<string, unknown>;
    // This lane's card carries NO namespace, and the renderer shows what the row
    // has. An ADDED field is the classic misleading-card shape: every true fact
    // still present, plus one more line the user reads as authoritative.
    expect(card.namespace).toBeUndefined();
    await execute("UPDATE approval_intents SET preview_json = $2 WHERE approval_id = $1", [
      outcome.approvalId,
      JSON.stringify({ ...card, namespace: "kyberswap" }),
    ]);

    const resumed = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      approvedContext(sessionId, outcome.approvalId),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toContain("is not the card this transaction produces");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  it("carries the CANONICAL card in the envelope, so the request digest covers the sentence", async () => {
    const sessionId = await makeSession();
    const projectId = await makeProject(sessionId);
    const intent = await prepareApprovalIntent(sessionId);

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );
    const outcome = await enqueueThroughStudio(projectId, sessionId, result);
    if (outcome.kind !== "enqueued") throw new Error("expected an enqueue");

    const queue = await queryOne<{ tool_call: Record<string, unknown> }>(
      "SELECT tool_call FROM approval_queue WHERE id = $1",
      [outcome.approvalId],
    );
    const stored = queue?.tool_call ?? {};
    const bound = stored.proposalBinding as {
      preview: { label: string; criticalArgs: Record<string, unknown> };
      proposalDigestVersion: string;
    };
    expect(bound.proposalDigestVersion).toBe("v2");
    expect(bound.preview.label).toBe(CANONICAL_PREVIEW.label);
    expect(bound.preview.criticalArgs).toEqual(CANONICAL_PREVIEW.criticalArgs);

    // Changing the sentence changes the digest the dispatch recomputes.
    const withOtherLabel = {
      ...stored,
      proposalBinding: { ...bound, preview: { ...bound.preview, label: "something else" } },
    };
    expect(computeRequestDigest(withOtherLabel)).not.toBe(computeRequestDigest(stored));
  });

  it("refuses a v1 digest row BY NAME rather than reporting proposal drift", async () => {
    const sessionId = await makeSession();
    const intent = await prepareApprovalIntent(sessionId);
    await execute(
      "UPDATE wallet_transaction_intents SET proposal_digest_version = 'v1' WHERE intent_id = $1",
      [intent.intentId],
    );

    const result = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      restrictedContext(sessionId),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('carries proposal digest version "v1"');
    expect(result.output).toContain('this build computes "v2"');
    expect(result.output).toContain("rather than reported as proposal drift");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });

  it("an approved resume that names NO approval refuses rather than signing", async () => {
    const sessionId = await makeSession();
    const intent = await prepareApprovalIntent(sessionId);

    const resumed = await handleWalletEvmTransactionConfirm(
      { intentId: intent.intentId },
      baseContext(sessionId, { approved: true }),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toContain("names no approval");
    const still = await intentsRepo.getById(intent.intentId, sessionId);
    expect(still?.status).toBe("pending");
  });
});
