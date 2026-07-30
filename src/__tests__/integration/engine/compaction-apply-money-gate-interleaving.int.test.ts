/**
 * Integration: money-state writers vs the compaction safe-moment gate —
 * TWO REAL POSTGRES CLIENTS, never mocked SQL.
 *
 * The gate (`getUnresolvedMoneyStateForSession`) is only sound if every writer
 * it observes serializes with it on the session control lock. A single-client
 * test cannot show that: it would prove the query returns rows, not that the
 * two transactions cannot interleave. So each case here runs the real race —
 * client A opens the apply-side transaction and takes the lock, client B
 * attempts the writer — and asserts the strict order the contract promises:
 *
 *   EITHER the gate saw B's row and deferred the cutover,
 *   OR B's write landed strictly AFTER A committed.
 *
 * Never "both happened at once".
 *
 * The race itself lives in `./money-gate-race-harness.ts`, shared with the
 * sibling writer-group suites so every writer is raced the same way. Each file
 * keeps its OWN non-participating baseline.
 *
 * SCOPE: the wallet writers (`wallet_intents` create / consume / markExecuted /
 * markFailed / markAuditFailed / cancel). The approval writers live in
 * `compaction-apply-money-gate-approval-writers.int.test.ts`, the protocol
 * executions in `…-protocol-executions.int.test.ts`, and the agent-activity
 * writers in `…-agent-activity.int.test.ts`.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { getPool } from "@vex-agent/db/client.js";
import * as walletIntentsRepo from "@vex-agent/db/repos/wallet-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { raceGateAgainstWriter } from "./money-gate-race-harness.js";

const TTL_MS = 600_000;

/** Seed an intent directly, bypassing the lock — fixture setup, not a race. */
async function seedIntent(
  sessionId: string,
  status: "pending" | "consuming",
): Promise<string> {
  const intentId = `intent-${randomUUID()}`;
  await withSessionControlLock(sessionId, (client) =>
    walletIntentsRepo.createWith(client, {
      intentId,
      sessionId,
      walletAddress: "0xwallet",
      network: "eip155",
      chainAlias: "base",
      toAddress: "0xdest",
      amount: "1",
      token: null,
      previewJson: { label: "send", criticalArgs: {} },
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    }),
  );
  if (status === "consuming") {
    const claimed = await withSessionControlLock(sessionId, (client) =>
      walletIntentsRepo.consumeIfPendingWith(client, intentId, sessionId),
    );
    expect(claimed).not.toBeNull();
  }
  return intentId;
}

async function statusOf(intentId: string, sessionId: string): Promise<string> {
  const row = await walletIntentsRepo.getById(intentId, sessionId);
  return row?.status ?? "missing";
}

describe("money-state writers participate in the session control lock", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  it("baseline: a NON-participating writer proves the harness detects the failure", async () => {
    // Same race, but the writer bypasses the lock entirely. It must slip past —
    // otherwise every assertion below would pass vacuously.
    const intentId = await seedIntent(sessionId, "pending");
    const outcome = await raceGateAgainstWriter(sessionId, async () => {
      const client = await getPool().connect();
      try {
        return await walletIntentsRepo.cancelIfPendingWith(client, intentId, sessionId);
      } finally {
        client.release();
      }
    });
    expect(outcome.writerBlockedUntilCommit).toBe(false);
  });

  // ── writer 1: create (prepare.ts) ──────────────────────────────────

  it("wallet create blocks until the gate transaction commits", async () => {
    const intentId = `intent-${randomUUID()}`;
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(sessionId, (client) =>
        walletIntentsRepo.createWith(client, {
          intentId,
          sessionId,
          walletAddress: "0xwallet",
          network: "eip155",
          chainAlias: "base",
          toAddress: "0xdest",
          amount: "1",
          token: null,
          previewJson: { label: "send", criticalArgs: {} },
          expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        }),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // Strict order: the gate could not see a row that did not exist yet, and
    // the row exists only after the cutover committed.
    expect(outcome.gateKinds).toEqual([]);
    expect(await statusOf(intentId, sessionId)).toBe("pending");
  });

  // ── writer 2: consumeIfPending (confirm.ts, pre-signing) ───────────

  it("wallet consumeIfPending blocks, and the gate sees the pre-existing pending row", async () => {
    const intentId = await seedIntent(sessionId, "pending");
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(sessionId, (client) =>
        walletIntentsRepo.consumeIfPendingWith(client, intentId, sessionId),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    // This row was already live, so the gate correctly defers the cutover.
    expect(outcome.gateKinds).toEqual(["wallet_intent_live"]);
    expect(await statusOf(intentId, sessionId)).toBe("consuming");
  });

  // ── writer 3: markExecuted (finalize.ts) ───────────────────────────

  it("wallet markExecuted blocks until the gate transaction commits", async () => {
    const intentId = await seedIntent(sessionId, "consuming");
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(sessionId, (client) =>
        walletIntentsRepo.markExecutedWith(client, intentId, sessionId, "0xhash-exec"),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["wallet_intent_live"]);
    expect(await statusOf(intentId, sessionId)).toBe("executed");
  });

  // ── writer 4: markFailed (finalize.ts) ─────────────────────────────

  it("wallet markFailed blocks until the gate transaction commits", async () => {
    const intentId = await seedIntent(sessionId, "consuming");
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(sessionId, (client) =>
        walletIntentsRepo.markFailedWith(
          client,
          intentId,
          sessionId,
          "BroadcastError:abc123",
          "0xhash-failed",
        ),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["wallet_intent_live"]);
    expect(await statusOf(intentId, sessionId)).toBe("failed");
    // A failure carrying a hash is STILL unresolved money state afterwards.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after.clear).toBe(false);
  });

  // ── writer 5: markAuditFailed (finalize.ts) ────────────────────────

  it("wallet markAuditFailed blocks until the gate transaction commits", async () => {
    const intentId = await seedIntent(sessionId, "consuming");
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(sessionId, (client) =>
        walletIntentsRepo.markAuditFailedWith(
          client,
          intentId,
          sessionId,
          "0xhash-audit",
          "StatusMismatch:no_consuming_row",
        ),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["wallet_intent_live"]);
    expect(await statusOf(intentId, sessionId)).toBe("audit_failed");
  });

  // ── writer 6: cancelIfPending (vex-app IPC) ────────────────────────

  it("wallet cancelIfPending blocks until the gate transaction commits", async () => {
    const intentId = await seedIntent(sessionId, "pending");
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(sessionId, (client) =>
        walletIntentsRepo.cancelIfPendingWith(client, intentId, sessionId),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(true);
    expect(outcome.gateKinds).toEqual(["wallet_intent_live"]);
    expect(await statusOf(intentId, sessionId)).toBe("cancelled");
    // Cancellation clears the gate for the NEXT apply attempt.
    const after = await withSessionControlLock(sessionId, (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );
    expect(after).toEqual({ clear: true });
  });

  // ── cross-session ──────────────────────────────────────────────────

  it("does NOT serialize a writer for a DIFFERENT session", async () => {
    // The lock is session-keyed; unrelated sessions must not queue behind an
    // apply, or one compacting session would stall every other wallet action.
    const otherSession = await makeSession();
    const intentId = `intent-${randomUUID()}`;
    const outcome = await raceGateAgainstWriter(sessionId, () =>
      withSessionControlLock(otherSession, (client) =>
        walletIntentsRepo.createWith(client, {
          intentId,
          sessionId: otherSession,
          walletAddress: "0xwallet",
          network: "eip155",
          chainAlias: "base",
          toAddress: "0xdest",
          amount: "1",
          token: null,
          previewJson: { label: "send", criticalArgs: {} },
          expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        }),
      ),
    );

    expect(outcome.writerBlockedUntilCommit).toBe(false);
    expect(outcome.gateKinds).toEqual([]);
  });
});
