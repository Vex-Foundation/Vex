import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePool, execute } from "@vex-agent/db/client.js";
import { runMigrations } from "@vex-agent/db/migrate.js";
import * as repo from "@vex-agent/db/repos/lighter-onboarding-intents.js";

const RUN = process.env.VEX_LIGHTER_ONBOARDING_DB === "1";
const d = RUN ? describe : describe.skip;

const SESSION_IDS: string[] = [];
const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
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
  const row = await repo.createDepositApprovalPending({
    sessionId,
    environment: "core",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: CONTRACT,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11000000",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expect(row).not.toBeNull();
  return row!;
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

    const approved = await repo.markApprovalDecision({ intentId: intent.intentId, decision: "approved" });
    expect(approved?.approvalStatus).toBe("approved");
    expect(approved?.executionState).toBe("approved");

    expect((await repo.markApproveSubmitted(intent.intentId, "0x" + "a".repeat(64)))?.executionState).toBe("approve_submitted");
    expect((await repo.markApproveConfirmed(intent.intentId))?.executionState).toBe("approve_confirmed");
    expect((await repo.markDepositSubmitted(intent.intentId, "0x" + "b".repeat(64)))?.executionState).toBe("deposit_submitted");
    expect((await repo.markDepositConfirmed(intent.intentId))?.executionState).toBe("deposit_confirmed");
    const credited = await repo.markCredited(intent.intentId, 800001);
    expect(credited?.executionState).toBe("credited");
    expect(credited?.resolvedAccountIndex).toBe(800001);
  });

  it("refuses an out-of-order transition (no deposit before approve confirmed)", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await repo.markApprovalDecision({ intentId: intent.intentId, decision: "approved" });
    // Skipping approve submit/confirm must not advance.
    const skipped = await repo.markDepositSubmitted(intent.intentId, "0x" + "c".repeat(64));
    expect(skipped).toBeNull();
    expect((await repo.findByIntentId(intent.intentId))?.executionState).toBe("approved");
  });

  it("lists unresolved intents and excludes credited/failed", async () => {
    const sessionId = await newSession();
    const live = await newDepositIntent(sessionId);
    const done = await newDepositIntent(sessionId);
    await repo.markFailed(done.intentId, "test failed");

    const unresolved = await repo.listUnresolved("core");
    const ids = unresolved.map((r) => r.intentId);
    expect(ids).toContain(live.intentId);
    expect(ids).not.toContain(done.intentId);
  });

  it("markApprovalDecision only acts on approval_pending", async () => {
    const sessionId = await newSession();
    const intent = await newDepositIntent(sessionId);
    await repo.markApprovalDecision({ intentId: intent.intentId, decision: "approved" });
    const second = await repo.markApprovalDecision({ intentId: intent.intentId, decision: "rejected" });
    expect(second).toBeNull();
  });
});
