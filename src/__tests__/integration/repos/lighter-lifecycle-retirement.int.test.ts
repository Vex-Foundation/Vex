import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { execute, getPool, queryOne, withTransaction } from "@vex-agent/db/client.js";
import * as approvals from "@vex-agent/db/repos/approvals.js";
import * as lifecycle from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
import { requireValue } from "../../helpers/require-value.js";
import { makeSession } from "../setup/fixtures.js";

const TARGET = {
  environment: "rhc" as const,
  accountIndex: 4242,
  actionType: "close_position" as const,
  marketIndex: 0,
  providerOrderId: null,
};
const REVALIDATION = { positionBaseAmountInteger: "1000", closeSide: "sell" };
type Authorization = "approval_card" | "full_permission";
type Checkpoint = "approved" | "pre_submit_revalidated";

let sessionId: string;

beforeEach(async () => {
  // The integration harness must have selected its disposable database before
  // any repository call can fall back to a locally running application store.
  expect(process.env.VEX_DB_URL).toBeTruthy();
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name"))
    .toEqual({ name: "vex_test" });
  await execute("TRUNCATE sessions RESTART IDENTITY CASCADE");
  sessionId = await makeSession();
});

async function createPending() {
  return requireValue(await withTransaction((client) => lifecycle.createApprovalPendingWith(client, {
    ...TARGET,
    intentId: `lighter-lifecycle-${randomUUID()}`,
    sessionId,
    matchHash: "a".repeat(64),
    apiKeyIndex: 7,
    requestedBaseAmountInteger: "1000",
    requestedPriceInteger: "200000",
    requestedSide: "sell",
    reduceOnly: true,
    providerSnapshotJson: { positionBaseAmountInteger: "1000" },
    credentialRefJson: {
      kind: "encrypted_vault_reference",
      environment: TARGET.environment,
      accountIndex: TARGET.accountIndex,
      apiKeyIndex: 7,
      vaultCredentialId: "lighter/rhc/account-4242/api-key-7",
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })));
}

async function createAuthorized(
  authorization: Authorization,
  checkpoint: Checkpoint,
  expired = true,
) {
  const pending = await createPending();
  const approvalId = authorization === "approval_card" ? `approval-${pending.intentId}` : null;
  if (approvalId !== null) {
    await approvals.enqueue(approvalId, {
      command: "execute_tool",
      args: { toolId: "lighter.position.close", params: { intentId: pending.intentId } },
    }, "Close the selected position", sessionId);
    expect(await approvals.approve(approvalId)).toMatchObject({ status: "approved" });
  }
  expect(await lifecycle.markApprovalDecision({
    intentId: pending.intentId,
    decision: "approved",
    approvalId,
    reason: authorization,
  })).toMatchObject({ executionState: "approved" });
  if (checkpoint === "pre_submit_revalidated") {
    expect(await lifecycle.markPreSubmitRevalidated({
      intentId: pending.intentId, sessionId, evidence: REVALIDATION,
    })).toMatchObject({ executionState: checkpoint });
  }
  if (expired) {
    await execute("UPDATE lighter_order_lifecycle_intents SET expires_at = NOW() - INTERVAL '1 minute' WHERE intent_id = $1", [pending.intentId]);
  }
  return requireValue(await lifecycle.findByIntentId(sessionId, pending.intentId));
}

function retire(intent: lifecycle.LighterOrderLifecycleIntentRow) {
  return withTransaction((client) => lifecycle.expireStalePreSubmitWith(client, intent));
}

async function expectBlocked(waitingPid: number, blockingPid: number) {
  await expect.poll(async () => {
    const row = await queryOne<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
      [waitingPid, blockingPid],
    );
    return row?.blocked;
  }, { timeout: 5000, interval: 10 }).toBe(true);
}

describe("Lighter lifecycle retirement against isolated PostgreSQL", () => {
  it.each([
    ["approval_card", "approved"],
    ["approval_card", "pre_submit_revalidated"],
    ["full_permission", "approved"],
    ["full_permission", "pre_submit_revalidated"],
  ] as const)("retires expired %s at %s, preserving approval history and refusing replay", async (authorization, checkpoint) => {
    const intent = await createAuthorized(authorization, checkpoint);
    expect(await lifecycle.findLiveTarget(TARGET)).toMatchObject({ intentId: intent.intentId });
    expect(lifecycle.isSafelyExpirablePreSubmit(intent)).toBe(true);

    const expired = requireValue(await retire(intent));
    expect(expired).toMatchObject({
      intentId: intent.intentId,
      executionState: "expired",
      approvalStatus: "approved",
      approvalId: intent.approvalId,
      decidedAt: intent.decidedAt,
      decisionReason: intent.decisionReason,
      preSubmitRevalidationJson: intent.preSubmitRevalidationJson,
      preSubmitRevalidatedAt: intent.preSubmitRevalidatedAt,
      nonceReservationId: null,
      nonceValue: null,
      sendAttemptStartedAt: null,
    });
    if (intent.approvalId !== null) {
      expect(await approvals.getByIdForSession(intent.approvalId, sessionId))
        .toMatchObject({ status: "approved" });
    }
    expect(await lifecycle.findLiveTarget(TARGET)).toBeNull();
    expect(await lifecycle.findAnyLiveOrderMutation(TARGET)).toBeNull();
    expect(await retire(intent)).toBeNull();
    expect(await lifecycle.markApprovalDecision({
      intentId: intent.intentId, decision: "approved", approvalId: intent.approvalId, reason: "replay",
    })).toBeNull();
    expect(await lifecycle.markPreSubmitRevalidated({
      intentId: intent.intentId, sessionId, evidence: REVALIDATION,
    })).toBeNull();
    expect(await lifecycle.attachNonceReservation({
      intentId: intent.intentId, sessionId, reservationId: "replayed-reservation", nonceValue: "12",
    })).toBeNull();

    // Releasing the unique live-position slot requires a fresh prepared intent.
    const replacement = await createPending();
    expect(replacement).toMatchObject({ approvalStatus: "approval_pending", executionState: "approval_pending" });
    expect(await lifecycle.findLiveTarget(TARGET)).toMatchObject({ intentId: replacement.intentId });
  });

  it("expires an untouched pending preparation without inventing approval", async () => {
    const intent = await createPending();
    await execute("UPDATE lighter_order_lifecycle_intents SET expires_at = NOW() - INTERVAL '1 minute' WHERE intent_id = $1", [intent.intentId]);
    expect(await retire(intent)).toMatchObject({
      approvalId: null, approvalStatus: "expired", executionState: "expired",
    });
    expect(await lifecycle.markApprovalDecision({
      intentId: intent.intentId, decision: "approved", approvalId: null, reason: "late approval",
    })).toBeNull();
  });

  it.each(["approved", "pre_submit_revalidated"] as const)("preserves unexpired Full-permission %s", async (checkpoint) => {
    const intent = await createAuthorized("full_permission", checkpoint, false);
    expect(lifecycle.isSafelyExpirablePreSubmit(intent)).toBe(false);
    expect(await retire(intent)).toBeNull();
    expect(await lifecycle.findLiveTarget(TARGET)).toMatchObject({ intentId: intent.intentId, executionState: checkpoint });
  });

  it.each([
    ["send_attempt_started_at", new Date("2026-01-01T00:00:00.000Z")],
    ["nonce_reservation_id", "held-reservation"],
    ["nonce_value", "12"],
  ] as const)("preserves expired prevalidation with %s evidence", async (column, value) => {
    const intent = await createAuthorized("full_permission", "pre_submit_revalidated");
    // Isolate each evidence guard even if the rest of a checkpoint is incomplete.
    await execute(`UPDATE lighter_order_lifecycle_intents SET ${column} = $2 WHERE intent_id = $1`, [intent.intentId, value]);
    const observed = requireValue(await lifecycle.findByIntentId(sessionId, intent.intentId));
    expect(lifecycle.isSafelyExpirablePreSubmit(observed)).toBe(false);
    expect(await retire(intent)).toBeNull();
    expect(await lifecycle.findByIntentId(sessionId, intent.intentId)).toEqual(observed);
    await expect(createPending()).rejects.toMatchObject({ code: "23505", constraint: "idx_lighter_order_lifecycle_live_close" });
  });

  it("refuses a stale caller whose saved target identity does not match", async () => {
    const intent = await createAuthorized("full_permission", "approved");
    for (const overrides of [
      { sessionId: "wrong-session" },
      { matchHash: "b".repeat(64) },
      { environment: "core" as const },
      { accountIndex: 4243 },
      { actionType: "cancel_one" as const },
      { marketIndex: 1 },
      { providerOrderId: "1" },
    ]) {
      expect(await retire({ ...intent, ...overrides })).toBeNull();
    }
    expect(await lifecycle.findByIntentId(sessionId, intent.intentId)).toEqual(intent);
  });

  it("rechecks retirement after a concurrent nonce attachment commits first", async () => {
    const intent = await createAuthorized("full_permission", "pre_submit_revalidated");
    const writer = await getPool().connect();
    const retiree = await getPool().connect();
    let retirement: ReturnType<typeof lifecycle.expireStalePreSubmitWith> | undefined;
    try {
      const writerPid = requireValue((await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
      const retireePid = requireValue((await retiree.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
      await writer.query("BEGIN");
      expect(await lifecycle.attachNonceReservationWith(writer, {
        intentId: intent.intentId, sessionId, reservationId: "concurrent-reservation", nonceValue: "12",
      })).toMatchObject({ executionState: "nonce_reserved" });
      retirement = lifecycle.expireStalePreSubmitWith(retiree, intent);
      await expectBlocked(retireePid, writerPid);
      await writer.query("COMMIT");
      expect(await retirement).toBeNull();
      expect(await lifecycle.findByIntentId(sessionId, intent.intentId)).toMatchObject({
        executionState: "nonce_reserved", nonceReservationId: "concurrent-reservation", nonceValue: "12",
      });
    } finally {
      await writer.query("ROLLBACK");
      await retirement;
      writer.release();
      retiree.release();
    }
  });

  it("refuses a queued nonce attachment after retirement commits first", async () => {
    const intent = await createAuthorized("full_permission", "pre_submit_revalidated");
    const retiree = await getPool().connect();
    const writer = await getPool().connect();
    let attachment: ReturnType<typeof lifecycle.attachNonceReservationWith> | undefined;
    try {
      const retireePid = requireValue((await retiree.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
      const writerPid = requireValue((await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]).pid;
      await retiree.query("BEGIN");
      expect(await lifecycle.expireStalePreSubmitWith(retiree, intent)).toMatchObject({ executionState: "expired" });
      attachment = lifecycle.attachNonceReservationWith(writer, {
        intentId: intent.intentId, sessionId, reservationId: "late-reservation", nonceValue: "12",
      });
      await expectBlocked(writerPid, retireePid);
      await retiree.query("COMMIT");
      expect(await attachment).toBeNull();
      expect(await lifecycle.findByIntentId(sessionId, intent.intentId)).toMatchObject({
        approvalStatus: "approved", executionState: "expired", nonceReservationId: null, nonceValue: null,
      });
    } finally {
      await retiree.query("ROLLBACK");
      await attachment;
      retiree.release();
      writer.release();
    }
  });
});
