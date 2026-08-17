import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, execute } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import * as repo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { ensureLighterOnboardingWorkflowEnabledWith } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

const RUN = process.env.VEX_LIGHTER_ONBOARDING_DB === "1";
const d = RUN ? describe : describe.skip;

const SESSION_IDS: string[] = [];
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";

beforeAll(async () => {
  if (!RUN) return;
  await runMigrations();
});

afterAll(async () => {
  for (const id of SESSION_IDS) {
    await execute("DELETE FROM sessions WHERE id = $1", [id]).catch(() => undefined);
  }
  if (RUN) await closePool();
});

async function newSession(): Promise<string> {
  const id = `lighter-onboard-test-${randomUUID()}`;
  await execute("INSERT INTO sessions (id, permission) VALUES ($1, 'restricted')", [id]);
  SESSION_IDS.push(id);
  return id;
}

async function newDepositIntent(sessionId: string) {
  const wallet = walletForSession(sessionId);
  const created = await withSessionControlLock(sessionId, async (client) => {
    await ensureLighterOnboardingWorkflowEnabledWith(client, "core", wallet);
    return repo.createOrFindLiveDepositApprovalPendingWith(client, {
      sessionId,
      environment: "core",
      walletAddress: wallet,
      chainId: 1,
      depositContract: CONTRACT,
      depositTo: wallet,
      assetIndex: 3,
      routeType: 0,
      amountUnits: "11000000",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });
  expect(created.outcome).toBe("created");
  return created.intent!;
}

function walletForSession(sessionId: string): string {
  return `0x${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
}

d("lighter_onboarding_intents repo", () => {
  it("creates a deposit intent in approval_pending", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    expect(intent.capability).toBe("deposit");
    expect(intent.approvalStatus).toBe("approval_pending");
    expect(intent.executionState).toBe("approval_pending");
    expect(intent.assetIndex).toBe(3);
    expect(intent.amountUnits).toBe("11000000");
  });

  it("walks the full deposit lifecycle through guarded CAS transitions", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);

    const approved = await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    expect(approved?.approvalStatus).toBe("approved");
    expect(approved?.executionState).toBe("approved");

    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markApproveSubmittedWith(client, intent.intentId, "0x" + "a".repeat(64))))?.executionState).toBe("approve_submitted");
    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markApproveConfirmedWith(client, intent.intentId)))?.executionState).toBe("approve_confirmed");
    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, "0x" + "b".repeat(64))))?.executionState).toBe("deposit_submitted");
    expect((await withSessionControlLock(sessionId, (client) =>
      repo.markDepositConfirmedWith(client, intent.intentId)))?.executionState).toBe("deposit_confirmed");
    const credited = await withSessionControlLock(sessionId, (client) =>
      repo.markCreditedWith(client, intent.intentId, 800001));
    expect(credited?.executionState).toBe("credited");
    expect(credited?.resolvedAccountIndex).toBe(800001);
  });

  it("refuses an out-of-order transition (no deposit before approve confirmed)", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    // Skipping approve submit/confirm must not advance.
    const skipped = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositSubmittedWith(client, intent.intentId, "0x" + "c".repeat(64)));
    expect(skipped).toBeNull();
    expect((await repo.findByIntentId(intent.intentId))?.executionState).toBe("approved");
  });

  it("records a sufficient existing allowance without inventing an approval transaction", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));

    const verified = await withSessionControlLock(sessionId, (client) =>
      repo.markAllowanceVerifiedWith(client, intent.intentId));
    expect(verified?.executionState).toBe("allowance_verified");
    expect(verified?.approveTxHash).toBeNull();
    expect(
      (await withSessionControlLock(sessionId, (client) =>
        repo.markDepositSubmittedWith(client, intent.intentId, "0x" + "d".repeat(64))))?.executionState,
    ).toBe("deposit_submitted");
  });

  it("returns the authoritative live intent instead of creating a duplicate deposit", async () => {
    const sessionId = await newSession();
    const first = await newDepositIntent(sessionId);
    const wallet = walletForSession(sessionId);
    const second = await withSessionControlLock(sessionId, (client) =>
      repo.createOrFindLiveDepositApprovalPendingWith(client, {
        sessionId,
        environment: "core",
        walletAddress: wallet.toUpperCase().replace("0X", "0x"),
        chainId: 1,
        depositContract: CONTRACT,
        depositTo: wallet,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "12000000",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    expect(second.outcome).toBe("live_conflict");
    expect(second.intent?.intentId).toBe(first.intentId);
  });

  it("lists unresolved intents and excludes credited/failed", async () => {
    const sessionId = await newSession();
    const live = await newDepositIntent(sessionId);
    const doneSessionId = await newSession();
    const done = await newDepositIntent(doneSessionId);
    await withSessionControlLock(doneSessionId, (client) =>
      repo.markFailedWith(client, done.intentId, "test failed"));

    const unresolved = await repo.listUnresolved("core");
    const ids = unresolved.map((r) => r.intentId);
    expect(ids).toContain(live.intentId);
    expect(ids).not.toContain(done.intentId);
  });

  it("markApprovalDecision only acts on approval_pending", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "approved" }));
    const second = await withSessionControlLock(sessionId, (client) =>
      repo.markApprovalDecisionWith(client, { intentId: intent.intentId, decision: "rejected" }));
    expect(second).toBeNull();
  });
});
