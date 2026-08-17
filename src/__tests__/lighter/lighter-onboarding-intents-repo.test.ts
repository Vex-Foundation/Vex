import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, execute, getPool } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import * as repo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { ensureLighterOnboardingWorkflowEnabledWith } from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { raceGateAgainstWriter } from "../integration/engine/money-gate-race-harness.js";

const RUN = process.env.VEX_LIGHTER_ONBOARDING_DB === "1";
const d = RUN ? describe : describe.skip;

const SESSION_IDS: string[] = [];
const WALLET_ADDRESSES = new Set<string>();
const CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";

beforeAll(async () => {
  if (!RUN) return;
  await runMigrations();
});

afterAll(async () => {
  for (const walletAddress of WALLET_ADDRESSES) {
    await execute(
      "DELETE FROM lighter_onboarding_workflows WHERE environment = 'core' AND wallet_address = LOWER($1)",
      [walletAddress],
    ).catch(() => undefined);
  }
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
  const created = await createDepositOutcome(sessionId, wallet);
  expect(created.outcome).toBe("created");
  return created.intent!;
}

async function createDepositOutcome(sessionId: string, wallet: string) {
  WALLET_ADDRESSES.add(wallet);
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
      preflight: preflight(wallet, "11000000"),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });
  return created;
}

function walletForSession(sessionId: string): string {
  return `0x${createHash("sha256").update(sessionId).digest("hex").slice(0, 40)}`;
}

function preflight(walletAddress: string, amountUnits: string) {
  return {
    observedAt: new Date(),
    walletAddress,
    chainId: 1,
    ethereumBlockNumber: "23456789",
    lighterBlockNumber: "23456780",
    gatewayAddress: CONTRACT,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenSymbol: "USDC" as const,
    settlementTokenDecimals: 6,
    assetIndex: 3,
    routeType: 0,
    amountUnits,
    minimumTransferUnits: "1000000",
    walletBalanceUnits: "50000000",
    walletAllowanceUnits: "0",
    walletNativeBalanceWei: "1000000000000000",
    approvalRequired: true,
  };
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
      repo.markDepositConfirmedWith(client, intent.intentId, {
        txHash: "0x" + "b".repeat(64),
        blockHash: "0x" + "c".repeat(64),
        blockNumber: "23456789",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
      })))?.executionState).toBe("deposit_confirmed");
    const credited = await withSessionControlLock(sessionId, (client) =>
      repo.markDepositCreditedWith(client, intent.intentId, {
        txHash: "0x" + "b".repeat(64),
        blockHash: "0x" + "c".repeat(64),
        blockNumber: "23456789",
        accountIndex: 42,
        walletAddress: intent.walletAddress,
        assetIndex: 3,
        routeType: 0,
        amountUnits: "11000000",
        lighterTxHash: "lighter-tx-hash",
        lighterStatus: 3,
        lighterBlockHeight: 313485202,
        lighterExecutedAt: 1786949159112,
      }));
    expect(credited?.executionState).toBe("credited");
    expect((await repo.findByIntentId(intent.intentId))?.resolvedAccountIndex).toBe(42);
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
        preflight: preflight(wallet.toUpperCase().replace("0X", "0x"), "12000000"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    expect(second.outcome).toBe("live_conflict");
    expect(second.intent?.intentId).toBe(first.intentId);
  });

  it("allows exactly one live deposit across concurrent sessions sharing a wallet", async () => {
    const firstSessionId = await newSession();
    const secondSessionId = await newSession();
    const sharedWallet = walletForSession(`shared-${randomUUID()}`);

    const results = await Promise.all([
      createDepositOutcome(firstSessionId, sharedWallet),
      createDepositOutcome(secondSessionId, sharedWallet),
    ]);

    const created = results.filter((result) => result.outcome === "created");
    const conflicts = results.filter((result) => result.outcome === "live_conflict");
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.intent?.intentId).toBe(created[0]?.intent?.intentId);
  });

  it("proves the compaction race harness detects an unlocked onboarding writer", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);

    const outcome = await raceGateAgainstWriter(sessionId, async () => {
      const client = await getPool().connect();
      try {
        return await client.query(
          "UPDATE lighter_onboarding_intents SET execution_state = 'failed' WHERE intent_id = $1",
          [intent.intentId],
        );
      } finally {
        client.release();
      }
    });

    expect(outcome.writerBlockedUntilCommit).toBe(false);
  });

  it.each([
    ["prepared", "prepared", "deposit_approval_pending"],
    ["approval pending", "approval_pending", "deposit_approval_pending"],
    ["approved", "approved", "deposit_approval_pending"],
    ["preflight validated", "approved", "deposit_preflight_validated"],
    ["allowance verified", "allowance_verified", "allowance_verified"],
    ["approval staged", "approve_submitted", "approve_staged"],
    ["approval confirmed", "approve_confirmed", "approve_confirmed"],
    ["deposit staged", "deposit_submitted", "deposit_staged"],
    ["deposit L1 confirmed", "deposit_submitted", "deposit_l1_confirmed"],
    ["deposit L2 pending", "deposit_confirmed", "deposit_l2_pending"],
    ["ambiguous", "ambiguous", "ambiguous"],
  ])(
    "serializes compaction against the unresolved %s state",
    async (_label, executionState, workflowState) => {
      const sessionId = await newSession();
      const intent = await newDepositIntent(sessionId);
      await execute(
        `UPDATE lighter_onboarding_intents
            SET approval_status = CASE
                  WHEN $2 IN ('prepared', 'approval_pending') THEN 'approval_pending'
                  ELSE 'approved'
                END,
                execution_state = $2,
                decided_at = CASE
                  WHEN $2 IN ('prepared', 'approval_pending') THEN NULL
                  ELSE NOW()
                END
          WHERE intent_id = $1`,
        [intent.intentId, executionState],
      );
      await execute(
        `UPDATE lighter_onboarding_workflows
            SET workflow_state = $3,
                last_stable_state = CASE WHEN $3 = 'ambiguous' THEN 'deposit_staged' ELSE $3 END
          WHERE environment = $1 AND wallet_address = LOWER($2)`,
        [intent.environment, intent.walletAddress, workflowState],
      );

      const outcome = await raceGateAgainstWriter(sessionId, () =>
        withSessionControlLock(sessionId, (client) =>
          repo.markFailedWith(client, intent.intentId, "test terminal state")),
      );

      expect(outcome.writerBlockedUntilCommit).toBe(true);
      expect(outcome.gateKinds).toEqual(["lighter_onboarding_unresolved"]);
      await expect(
        withSessionControlLock(sessionId, (client) =>
          getUnresolvedMoneyStateForSession(client, sessionId)),
      ).resolves.toEqual({ clear: true });
    },
  );

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
