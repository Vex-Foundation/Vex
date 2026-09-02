/**
 * Integration: `getUnresolvedMoneyStateForSession` against real Postgres.
 *
 * This reader is the safe-moment gate for the compaction APPLY cutover — a
 * `clear: true` answer authorises rewriting the session transcript. Every
 * predicate therefore gets a POSITIVE case (it blocks) and, where a near-miss
 * shape exists, a NEGATIVE one (it must NOT block), because the expensive
 * failure mode for a gate like this is a fixture that only ever encodes the
 * empty collection.
 *
 * Real SQL, real CHECK constraints, real `NOW()`. Mocked SQL would prove
 * nothing about a predicate whose whole job is to match production rows.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { getPool } from "@vex-agent/db/client.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import type { MoneyStateReason } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { execute, queryOne } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/** Run the reader the only way it may be used: bound to a real transaction. */
async function readMoneyState(sessionId: string) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    return await getUnresolvedMoneyStateForSession(client, sessionId);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function kindsFor(sessionId: string): Promise<MoneyStateReason["kind"][]> {
  const state = await readMoneyState(sessionId);
  return state.clear ? [] : state.reasons.map((r) => r.kind).sort();
}

// ── fixture writers (raw SQL: the reader's contract is with the schema) ──

async function insertQueueRow(
  sessionId: string,
  status: "pending" | "approved" | "rejected",
): Promise<string> {
  const id = randomUUID();
  await execute(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id)
     VALUES ($1, '{}'::jsonb, 'because', $2, $3)`,
    [id, status, sessionId],
  );
  return id;
}

async function insertIntent(
  approvalId: string,
  sessionId: string,
  fields: { decision?: string | null; executionStatus?: string } = {},
): Promise<void> {
  await execute(
    `INSERT INTO approval_intents
       (approval_id, session_id, action_kind, risk_level, preview_json, policy_json,
        decision, decided_at, execution_status)
     VALUES ($1, $2, 'user_wallet_broadcast', 'high', '{}'::jsonb, '{}'::jsonb,
             $3, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END, $4)`,
    [approvalId, sessionId, fields.decision ?? null, fields.executionStatus ?? "not_started"],
  );
}

async function insertWalletIntent(
  sessionId: string,
  fields: { status: string; expiresInMs?: number; txHash?: string | null },
): Promise<string> {
  const intentId = randomUUID();
  await execute(
    `INSERT INTO wallet_intents
       (intent_id, session_id, wallet_address, network, to_address, amount,
        preview_json, status, expires_at, tx_hash)
     VALUES ($1, $2, '0xwallet', 'eip155', '0xdest', '1',
             '{"label":"send","criticalArgs":{}}'::jsonb, $3,
             NOW() + ($4::text || ' milliseconds')::interval, $5)`,
    [intentId, sessionId, fields.status, String(fields.expiresInMs ?? 600_000), fields.txHash ?? null],
  );
  return intentId;
}

async function insertProtocolExecution(
  sessionId: string | null,
  executionStatus: "intent" | "succeeded" | "failed",
): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO protocol_executions
       (tool_id, namespace, session_id, params, result, success, external_refs, execution_status)
     VALUES ('swap_execute', 'agentscan', $1, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, $2)
     RETURNING id`,
    [sessionId, executionStatus],
  );
  return row?.id ?? 0;
}

async function insertAgentActivity(
  sessionId: string,
  status: "pending" | "confirmed" | "definitively_failed",
): Promise<void> {
  const executionId = await insertProtocolExecution(sessionId, "succeeded");
  await execute(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_role, kind, protocol, chain_id,
        wallet_address, session_id, status, from_address, nonce, tx_hash, confirmed_at,
        executed_amount_in_raw, executed_amount_out_raw, failure_code)
     VALUES ($1, 'swap', 'swap', 'kyberswap', 8453, '0xwallet', $2, $3,
             CASE WHEN $3 = 'pending' THEN NULL ELSE '0xwallet' END,
             CASE WHEN $3 = 'pending' THEN NULL ELSE 1 END,
             CASE WHEN $3 = 'pending' THEN NULL ELSE $4::text END,
             CASE WHEN $3 = 'confirmed' THEN NOW() ELSE NULL END,
             CASE WHEN $3 = 'confirmed' THEN '1' ELSE NULL END,
             CASE WHEN $3 = 'confirmed' THEN '1' ELSE NULL END,
             CASE WHEN $3 = 'definitively_failed' THEN 'unknown' ELSE NULL END)`,
    [executionId, sessionId, status, `0xhash-${executionId}`],
  );
}

async function insertLighterOnboardingIntent(
  sessionId: string,
  fields: {
    approvalStatus: "approval_pending" | "approved";
    executionState: string;
    expiresInMs?: number;
  },
): Promise<string> {
  const intentId = `lighter-onboard-${randomUUID()}`;
  await execute(
    `INSERT INTO lighter_onboarding_intents
       (intent_id, session_id, environment, capability, wallet_address, chain_id,
        deposit_contract, deposit_to, asset_index, route_type, amount_units,
        approval_status, execution_state, decided_at, expires_at)
     VALUES ($1, $2, 'core', 'deposit', '0x1111111111111111111111111111111111111111', 1,
             '0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7',
             '0x1111111111111111111111111111111111111111', 3, 0, '11000000',
             $3, $4, CASE WHEN $3 = 'approved' THEN NOW() ELSE NULL END,
             NOW() + ($5::text || ' milliseconds')::interval)`,
    [
      intentId,
      sessionId,
      fields.approvalStatus,
      fields.executionState,
      String(fields.expiresInMs ?? 600_000),
    ],
  );
  return intentId;
}

/**
 * A `wallet_wrap_intents` row (migration 096). Written as raw SQL like every
 * other fixture here so the reader is exercised against the TABLE's own CHECKs
 * rather than through a repo that could share a mistake with it.
 */
async function insertWrapIntent(
  sessionId: string,
  fields: { status: string; expiresInMs?: number; txHash?: string | null; failureStage?: string },
): Promise<string> {
  const intentId = randomUUID();
  await execute(
    `INSERT INTO wallet_wrap_intents
       (intent_id, session_id, wallet_address, chain_alias, chain_id, direction,
        wrapped_native_address, wrapped_native_symbol, wrapped_native_decimals,
        amount_raw, payload_json, preview_json, fee_bounds_json,
        proposal_digest, proposal_digest_version, status, failure_stage,
        expires_at, tx_hash)
     VALUES ($1, $2, '0xwallet', 'base', 8453, 'wrap',
             '0x4200000000000000000000000000000000000006', 'WETH', 18,
             '1', '{"to":"0x4200000000000000000000000000000000000006",
                    "data":"0xd0e30db0","valueWei":"1"}'::jsonb,
             '{"label":"wrap","criticalArgs":{}}'::jsonb, '{}'::jsonb,
             repeat('a', 64), 'v1', $3, $4,
             NOW() + ($5::text || ' milliseconds')::interval, $6)`,
    [
      intentId,
      sessionId,
      fields.status,
      fields.failureStage ?? null,
      String(fields.expiresInMs ?? 600_000),
      fields.txHash ?? null,
    ],
  );
  return intentId;
}

describe("getUnresolvedMoneyStateForSession", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  it("reports clear for a session with no money-path rows at all", async () => {
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  // ── 1. approval queue ──────────────────────────────────────────────

  it("blocks on a pending approval_queue row that HAS an intent", async () => {
    const approvalId = await insertQueueRow(sessionId, "pending");
    await insertIntent(approvalId, sessionId, { decision: null });
    expect(await kindsFor(sessionId)).toEqual(["approval_queue_pending"]);
  });

  it("blocks on a LEGACY queue-only pending row with NO intent", async () => {
    // The defect this pins: an intent-first join cannot see this row, and the
    // gate would report clear while an approval sits on the operator's screen.
    await insertQueueRow(sessionId, "pending");
    const state = await readMoneyState(sessionId);
    expect(state.clear).toBe(false);
    if (state.clear) return;
    expect(state.reasons).toEqual([
      expect.objectContaining({ kind: "approval_queue_pending", detail: "queue_pending" }),
    ]);
  });

  it("blocks on an undecided intent whose queue row is already resolved", async () => {
    const approvalId = await insertQueueRow(sessionId, "approved");
    await insertIntent(approvalId, sessionId, { decision: null });
    const state = await readMoneyState(sessionId);
    expect(state.clear).toBe(false);
    if (state.clear) return;
    expect(state.reasons).toEqual([
      expect.objectContaining({ kind: "approval_queue_pending", detail: "intent_undecided" }),
    ]);
  });

  it("does NOT double-count an intent-backed pending queue row", async () => {
    const approvalId = await insertQueueRow(sessionId, "pending");
    await insertIntent(approvalId, sessionId, { decision: null });
    const state = await readMoneyState(sessionId);
    expect(state.clear).toBe(false);
    if (state.clear) return;
    expect(state.reasons).toHaveLength(1);
  });

  it("is clear once the approval is rejected and the queue row resolved", async () => {
    const approvalId = await insertQueueRow(sessionId, "rejected");
    await insertIntent(approvalId, sessionId, { decision: "rejected" });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  // ── 2. approved-but-unfinished execution ───────────────────────────

  for (const executionStatus of ["not_started", "dispatching", "indeterminate"] as const) {
    it(`blocks on an approved intent with execution_status='${executionStatus}'`, async () => {
      const approvalId = await insertQueueRow(sessionId, "approved");
      await insertIntent(approvalId, sessionId, { decision: "approved", executionStatus });
      const state = await readMoneyState(sessionId);
      expect(state.clear).toBe(false);
      if (state.clear) return;
      expect(state.reasons).toEqual([
        expect.objectContaining({ kind: "approval_in_flight", detail: executionStatus }),
      ]);
    });
  }

  for (const executionStatus of ["succeeded", "failed"] as const) {
    it(`is clear for an approved intent that reached '${executionStatus}'`, async () => {
      const approvalId = await insertQueueRow(sessionId, "approved");
      await insertIntent(approvalId, sessionId, { decision: "approved", executionStatus });
      await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
    });
  }

  // ── 3-4. wallet intents ────────────────────────────────────────────

  it("blocks on an UNEXPIRED pending wallet intent", async () => {
    await insertWalletIntent(sessionId, { status: "pending", expiresInMs: 600_000 });
    expect(await kindsFor(sessionId)).toEqual(["wallet_intent_live"]);
  });

  it("does NOT block on an EXPIRED pending wallet intent", async () => {
    // `consumeIfPending` filters `expires_at > NOW()`, so this row can never
    // be claimed — blocking on it would park the session forever.
    await insertWalletIntent(sessionId, { status: "pending", expiresInMs: -1_000 });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  it("blocks on a consuming wallet intent even past its expiry", async () => {
    // `consuming` has no expiry semantics — a signature may genuinely be in
    // flight regardless of the original TTL.
    await insertWalletIntent(sessionId, { status: "consuming", expiresInMs: -1_000 });
    expect(await kindsFor(sessionId)).toEqual(["wallet_intent_live"]);
  });

  for (const status of ["review_required", "audit_failed"] as const) {
    it(`blocks on a '${status}' wallet intent CARRYING a tx hash`, async () => {
      await insertWalletIntent(sessionId, { status, txHash: "0xdeadbeef" });
      const state = await readMoneyState(sessionId);
      expect(state.clear).toBe(false);
      if (state.clear) return;
      expect(state.reasons).toEqual([
        expect.objectContaining({ kind: "wallet_confirmation_unknown", detail: status }),
      ]);
    });
  }

  it("is clear for a failed wallet intent with NO tx hash (never broadcast)", async () => {
    await insertWalletIntent(sessionId, { status: "failed", txHash: null });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  it("is clear for an executed or cancelled wallet intent", async () => {
    await insertWalletIntent(sessionId, { status: "executed", txHash: "0xok" });
    await insertWalletIntent(sessionId, { status: "cancelled" });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  // ── 5. protocol executions ─────────────────────────────────────────

  it("blocks on a protocol_executions row still in 'intent'", async () => {
    await insertProtocolExecution(sessionId, "intent");
    expect(await kindsFor(sessionId)).toEqual(["protocol_execution_intent"]);
  });

  it("is clear once the protocol execution is finalized", async () => {
    await insertProtocolExecution(sessionId, "succeeded");
    await insertProtocolExecution(sessionId, "failed");
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  it("KNOWN GAP: a session-less protocol intent is invisible to the session gate", async () => {
    // Documented in the module header — widening to a global scan would block
    // unrelated sessions. Pinned so the gap cannot change silently.
    await insertProtocolExecution(null, "intent");
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  // ── 6. Lighter onboarding intents ─────────────────────────────────

  it("blocks on an unexpired pending Lighter onboarding approval", async () => {
    await insertLighterOnboardingIntent(sessionId, {
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
    });
    expect(await kindsFor(sessionId)).toEqual(["lighter_onboarding_unresolved"]);
  });

  it("does not block on an expired, never-approved Lighter preparation", async () => {
    await insertLighterOnboardingIntent(sessionId, {
      approvalStatus: "approval_pending",
      executionState: "approval_pending",
      expiresInMs: -1_000,
    });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  for (const executionState of [
    "approved",
    "allowance_verified",
    "approve_submitted",
    "approve_confirmed",
    "deposit_submitted",
    "deposit_confirmed",
    "ambiguous",
  ]) {
    it(`blocks on approved Lighter onboarding state '${executionState}'`, async () => {
      await insertLighterOnboardingIntent(sessionId, {
        approvalStatus: "approved",
        executionState,
      });
      const state = await readMoneyState(sessionId);
      expect(state.clear).toBe(false);
      if (state.clear) return;
      expect(state.reasons).toEqual([
        expect.objectContaining({
          kind: "lighter_onboarding_unresolved",
          detail: executionState,
        }),
      ]);
    });
  }

  for (const executionState of ["credited", "failed"]) {
    it(`is clear for terminal Lighter onboarding state '${executionState}'`, async () => {
      await insertLighterOnboardingIntent(sessionId, {
        approvalStatus: "approved",
        executionState,
      });
      await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
    });
  }

  // ── 7. agent activity ──────────────────────────────────────────────

  it("blocks on a pending agent_activity row", async () => {
    await insertAgentActivity(sessionId, "pending");
    expect(await kindsFor(sessionId)).toEqual(["agent_activity_pending"]);
  });

  it("is clear once the agent_activity row reaches a terminal state", async () => {
    await insertAgentActivity(sessionId, "confirmed");
    await insertAgentActivity(sessionId, "definitively_failed");
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  // ── cross-cutting ──────────────────────────────────────────────────

  it("reports every distinct reason when several predicates hit at once", async () => {
    await insertQueueRow(sessionId, "pending");
    const approvalId = await insertQueueRow(sessionId, "approved");
    await insertIntent(approvalId, sessionId, {
      decision: "approved",
      executionStatus: "dispatching",
    });
    await insertWalletIntent(sessionId, { status: "consuming" });
    await insertWalletIntent(sessionId, { status: "audit_failed", txHash: "0xabc" });
    await insertProtocolExecution(sessionId, "intent");
    await insertLighterOnboardingIntent(sessionId, {
      approvalStatus: "approved",
      executionState: "deposit_confirmed",
    });
    await insertAgentActivity(sessionId, "pending");

    expect(await kindsFor(sessionId)).toEqual([
      "agent_activity_pending",
      "approval_in_flight",
      "approval_queue_pending",
      "lighter_onboarding_unresolved",
      "protocol_execution_intent",
      "wallet_confirmation_unknown",
      "wallet_intent_live",
    ]);
  });

  // ── wallet_wrap_intents (migration 096) ────────────────────────────
  //
  // A THIRD money state machine with its own table. It was invisible to this
  // gate until fix round C, which meant a compaction cutover could rewrite the
  // transcript out from under a wrap that was mid-flight.

  it("blocks on an in-flight wrap: consuming, unexpired pending, or unconfirmed", async () => {
    await insertWrapIntent(sessionId, { status: "consuming" });
    expect(await kindsFor(sessionId)).toEqual(["wallet_wrap_intent_live"]);

    await resetDb();
    sessionId = await makeSession();
    await insertWrapIntent(sessionId, { status: "pending" });
    expect(await kindsFor(sessionId)).toEqual(["wallet_wrap_intent_live"]);

    await resetDb();
    sessionId = await makeSession();
    await insertWrapIntent(sessionId, { status: "broadcast_unconfirmed", txHash: "0xabc" });
    // `broadcast_unconfirmed` is the DISTINCT durable status for "the bytes are
    // on the network and we cannot yet prove the outcome", so it blocks until a
    // repair lane settles it.
    expect(await kindsFor(sessionId)).toEqual(["wallet_wrap_intent_live"]);
  });

  it("an EXPIRED pending wrap is dead and does NOT block", async () => {
    // `claimIfPendingWith` filters on `expires_at > NOW()`, so this row can
    // never be claimed by anything. Blocking on it would wedge the gate.
    await insertWrapIntent(sessionId, { status: "pending", expiresInMs: -1_000 });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  it("proven and honestly-terminal wrap rows RELEASE the gate", async () => {
    await insertWrapIntent(sessionId, { status: "executed", txHash: "0xabc" });
    await insertWrapIntent(sessionId, {
      status: "failed",
      failureStage: "chain_reverted",
      txHash: "0xdef",
    });
    await insertWrapIntent(sessionId, { status: "superseded_unproven", txHash: "0x123" });
    // The staged-evidence write failed BEFORE broadcast, so nothing was signed.
    await insertWrapIntent(sessionId, { status: "audit_failed" });
    await insertWrapIntent(sessionId, { status: "cancelled" });
    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
  });

  it("is scoped to ONE session — another session's in-flight work never blocks", async () => {
    const otherSession = await makeSession();
    await insertQueueRow(otherSession, "pending");
    await insertWalletIntent(otherSession, { status: "consuming" });
    await insertProtocolExecution(otherSession, "intent");
    await insertLighterOnboardingIntent(otherSession, {
      approvalStatus: "approved",
      executionState: "deposit_submitted",
    });
    await insertWrapIntent(otherSession, { status: "consuming" });
    await insertAgentActivity(otherSession, "pending");

    await expect(readMoneyState(sessionId)).resolves.toEqual({ clear: true });
    expect((await kindsFor(otherSession)).length).toBe(6);
  });

  it("bounds the reason list without changing the verdict", async () => {
    for (let i = 0; i < 55; i++) {
      await insertQueueRow(sessionId, "pending");
    }
    const state = await readMoneyState(sessionId);
    expect(state.clear).toBe(false);
    if (state.clear) return;
    expect(state.reasons).toHaveLength(50);
  });
});
