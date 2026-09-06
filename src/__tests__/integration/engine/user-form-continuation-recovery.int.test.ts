/**
 * Integration: the launch-form continuation across the STAMP → LEASE → TURN
 * sequence, and the two interleavings that used to lose it.
 *
 * ## The corner
 *
 * `resumeAgentAfterUserForm` appends the form's tool result, stamps
 * `result_message_id`, THEN claims the session lease, THEN runs the turn. Two
 * things go wrong if eligibility is keyed off that stamp:
 *
 *   (a) STOP AFTER STAMP, BEFORE LEASE. The stop transaction sees no live lease
 *       (not claimed yet), no approval lifecycle, and no outstanding form (the
 *       stamp is written) — so it proves "nothing will observe a request",
 *       retires it, and the dispatch's own gate then finds nothing and runs a
 *       full model turn on a session the operator stopped. On the launch path.
 *
 *   (b) LEASE BUSY / CRASH / RESTART AFTER STAMP. The turn never runs, and the
 *       durable scan — using the same predicate — can no longer see the row.
 *       The agent's turn is parked forever holding an ANSWERED tool call that
 *       nobody will ever deliver. An in-process retry ladder cannot fix this:
 *       a crash has no process left to retry in.
 *
 * Both close on one correction: eligibility is `resume_consumed_at IS NULL` —
 * a COMPLETED resumed turn — not "the result has been written".
 *
 * Real Postgres, because both properties are about what one transaction can see
 * of another's committed state, and about a row surviving a process that is
 * gone. A mocked client has neither.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import { closeUserFormContinuation } from "@vex-agent/engine/core/user-form-runtime.js";
import { withTransaction } from "@vex-agent/db/client.js";
import {
  casMarkUserFormResumeConsumedWith,
  listOutstandingUserFormResumes,
} from "@vex-agent/db/repos/token-launch-intents.js";
import {
  claimSessionLease,
  enqueueSessionStopRequest,
  gateOnOperatorStopTransaction,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

const INTENT = "intent-form-recovery";

/** Statuses the schema requires a `tx_hash` for. */
const BROADCAST_STATUSES = new Set(["broadcast_pending", "confirmed"]);

/** Statuses that precede (or abandon) authorization, so carry none. */
const UNAUTHORIZED_STATUSES = new Set([
  "awaiting_user_form",
  "cancelled",
  "expired",
]);

interface IntentRow {
  readonly result_message_id: number | null;
  readonly resume_consumed_at: Date | null;
}

async function seedForm(
  sessionId: string,
  overrides: {
    readonly intentId?: string;
    readonly status?: string;
    readonly resultMessageId?: number | null;
    readonly resumeConsumed?: boolean;
  } = {},
): Promise<string> {
  const intentId = overrides.intentId ?? INTENT;
  await execute(
    // `protocol` and `paired_asset` are STATED, not defaulted: migration 108
    // dropped the `trench` DEFAULT along with the launchpad, and
    // `token_launch_intents_pools_has_pair` requires the pair on a pools.fun row.
    // The continuation machinery under test is launchpad-agnostic, so this is
    // fixture furniture on the venue that still launches.
    `INSERT INTO token_launch_intents
       (intent_id, session_id, origin, status, chain_id, wallet_address,
        name, symbol, tool_call_id, result_message_id, expires_at,
        resume_consumed_at, tx_hash, authorization_id, authorization_kind,
        protocol, paired_asset)
     VALUES ($1, $2, 'agent_requested_form', $3, 8453,
             '0x0000000000000000000000000000000000000001',
             'Vex Coin', 'VEX', 'call_abc', $4, NOW() + interval '1 hour', $5,
             $6, $7, $8, 'pools_fun', 'weth')`,
    [
      intentId,
      sessionId,
      overrides.status ?? "confirmed",
      overrides.resultMessageId ?? null,
      overrides.resumeConsumed === true ? new Date().toISOString() : null,
      // `token_launch_intents_broadcast_has_hash`: a broadcast or confirmed
      // intent must carry the hash it was broadcast with.
      BROADCAST_STATUSES.has(overrides.status ?? "confirmed") ? "0xdead" : null,
      // `token_launch_intents_live_has_authorization`: anything past the form
      // stage carries the authorization it was executed under.
      UNAUTHORIZED_STATUSES.has(overrides.status ?? "confirmed")
        ? null
        : "auth-1",
      UNAUTHORIZED_STATUSES.has(overrides.status ?? "confirmed")
        ? null
        : "user_submit",
    ],
  );
  return intentId;
}

async function readIntent(intentId: string): Promise<IntentRow> {
  const rows = await query<IntentRow>(
    "SELECT result_message_id, resume_consumed_at FROM token_launch_intents WHERE intent_id = $1",
    [intentId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`intent ${intentId} vanished`);
  return row;
}

/** The completion CAS, on its own transaction. */
async function consume(intentId: string, sessionId: string): Promise<boolean> {
  return withTransaction((client) =>
    casMarkUserFormResumeConsumedWith(client, intentId, sessionId));
}

async function openSessionScopedStops(sessionId: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(
    `SELECT id FROM runtime_control_requests
      WHERE session_id = $1 AND kind = 'stop_terminal'
        AND mission_run_id IS NULL AND status IN ('pending','observed')`,
    [sessionId],
  );
}

describe("user-form continuation — stamp/lease/turn interleavings", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── (a) Stop after the stamp, before the lease ────────────────

  it("a Stop landing after the stamp is RETAINED and then consumed exactly once", async () => {
    const sessionId = await makeSession();
    // The state the resume is in at the instant it has written the result and
    // has not yet claimed the lease.
    await seedForm(sessionId, { resultMessageId: 4242 });

    const stop = await enqueueSessionStopRequest({ sessionId });

    // RETAINED — something still owes a turn, so the request must survive for
    // that turn's gate to find.
    expect(stop.outcome).toBe("queued");
    expect(await openSessionScopedStops(sessionId)).toHaveLength(1);

    // The dispatch's gate is what observes it. It reports `stopped`, so no
    // model turn runs…
    const gate = await gateOnOperatorStopTransaction({
      sessionId,
      missionRunId: null,
    });
    expect(gate).toEqual({
      kind: "stopped",
      runStatus: "cancelled",
      scope: "session",
    });

    // …and the request is consumed EXACTLY ONCE: a second consultation is
    // clear, so the stop cannot terminate some later, unrelated work.
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
    expect(
      await gateOnOperatorStopTransaction({ sessionId, missionRunId: null }),
    ).toEqual({ kind: "clear" });
  });

  it("a Stop is NOT retained once the continuation has completed", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242, resumeConsumed: true });

    const stop = await enqueueSessionStopRequest({ sessionId });

    expect(stop).toEqual({ outcome: "applied" });
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
  });

  // ── (b) restart / lease-busy recovery ─────────────────────────

  /**
   * The row a crashed or lease-blocked process leaves behind. Keyed off the
   * result stamp it was invisible; keyed off completion it is exactly what the
   * floor is for.
   */
  it("the durable scan finds a STAMPED-but-unconsumed form", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });

    const outstanding = await listOutstandingUserFormResumes();

    expect(outstanding.map((i) => i.intentId)).toEqual([INTENT]);
    // The scan reports WHICH half is owed: the result exists, so only the
    // dispatch is missing — re-appending would answer one tool call twice.
    expect(outstanding[0]?.resultMessageId).toBe(4242);
    expect(outstanding[0]?.resumeConsumedAt).toBeNull();
  });

  /**
   * A live status must NOT hide the dispatch-only half. An `unconfirmed`
   * outcome writes its result while the intent is still `broadcast_pending`,
   * which IS a live status — applying the settled filter to this half would
   * make exactly those rows invisible to their own recovery.
   */
  it("finds a stamped row even while its intent is still LIVE", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, {
      status: "broadcast_pending",
      resultMessageId: 4242,
    });

    const outstanding = await listOutstandingUserFormResumes();

    expect(outstanding.map((i) => i.intentId)).toEqual([INTENT]);
  });

  /**
   * The other half is still status-gated: while the human can act on the form,
   * there is nothing honest to tell the model.
   */
  it("does NOT surface an unanswered form the user can still fill in", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { status: "awaiting_user_form" });

    expect(await listOutstandingUserFormResumes()).toHaveLength(0);
  });

  it("drops out of the scan once the continuation completes", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });

    expect(await consume(INTENT, sessionId)).toBe(true);

    expect(await listOutstandingUserFormResumes()).toHaveLength(0);
    expect((await readIntent(INTENT)).resume_consumed_at).not.toBeNull();
  });

  it("the completion marker is write-once — a loser records nothing", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });

    expect(await consume(INTENT, sessionId)).toBe(true);
    const first = (await readIntent(INTENT)).resume_consumed_at;

    // A second pass — the retry ladder, the sweep, a duplicate IPC — must be a
    // no-op rather than a fabricated second completion.
    expect(await consume(INTENT, sessionId)).toBe(false);
    expect((await readIntent(INTENT)).resume_consumed_at).toEqual(first);
  });

  /**
   * Session-scoped like every other intents write: a caller naming the wrong
   * session must MISS, even with the right intent id.
   */
  it("refuses to consume across sessions", async () => {
    const sessionId = await makeSession();
    const other = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });

    expect(await consume(INTENT, other)).toBe(false);
    expect((await readIntent(INTENT)).resume_consumed_at).toBeNull();
  });

  /**
   * A lease held by unrelated work is exactly the `lease_busy` case: the turn
   * does not run, nothing is consumed, and the row stays recoverable.
   */
  it("a busy lease leaves the continuation owed and recoverable", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });
    await claimSessionLease({
      sessionId,
      ownerId: "unrelated-runner",
      processKind: "electron_main",
      ttlMs: 60_000,
    });

    // Nothing consumed the continuation, so the floor still owns it.
    expect((await readIntent(INTENT)).resume_consumed_at).toBeNull();
    expect(await listOutstandingUserFormResumes()).toHaveLength(1);
  });

  // ── the CLOSING interleaving ──────────────────────────────────

  /**
   * THE INTERLEAVING EVIDENCE (Codex final review turn 3, defect 1).
   *
   * A Stop landing after the turn finished but before the continuation was
   * marked consumed. At that instant the form is still outstanding, so the
   * request is legitimately RETAINED — and it must not survive the closing
   * decision, or it later refuses unrelated work.
   *
   * Driven through the REAL closing boundary, against real Postgres, because
   * the property is what one committed transaction can see of another's state.
   */
  it("a Stop landing before completion is consumed BY the closing decision", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });
    // A lease, as the dispatch holds one — this is what makes the stop retain.
    const claim = await claimSessionLease({
      sessionId,
      ownerId: "launch-form-owner",
      processKind: "electron_main",
      ttlMs: 60_000,
    });
    if (claim.outcome !== "claimed") throw new Error("lease claim failed");

    // The operator presses Stop in the gap.
    expect((await enqueueSessionStopRequest({ sessionId })).outcome).toBe("queued");
    expect(await openSessionScopedStops(sessionId)).toHaveLength(1);

    await closeUserFormContinuation({
      sessionId,
      leaseHandle: {
        lease: claim.lease,
        ownerId: "launch-form-owner",
        release: async () => {
          await execute("DELETE FROM runner_leases WHERE session_id = $1", [
            sessionId,
          ]);
        },
      },
      consume: (client) =>
        casMarkUserFormResumeConsumedWith(client, INTENT, sessionId).then(
          () => undefined,
        ),
    });

    // THE POINT: the stop did not outlive the continuation that owed it.
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
    // …and the continuation really is finished, so nothing re-selects it.
    expect((await readIntent(INTENT)).resume_consumed_at).not.toBeNull();
    expect(await listOutstandingUserFormResumes()).toHaveLength(0);
  });

  /**
   * The other arm: a Stop landing in the RELEASE window — after the closing
   * commit, while the lease is briefly still live. Retained at that instant,
   * orphaned the moment the lease goes. The post-release consultation retires
   * it, so a later unrelated turn is not refused by it.
   */
  it("a Stop landing in the release window does not haunt later work", async () => {
    const sessionId = await makeSession();
    await seedForm(sessionId, { resultMessageId: 4242 });
    const claim = await claimSessionLease({
      sessionId,
      ownerId: "launch-form-owner",
      processKind: "electron_main",
      ttlMs: 60_000,
    });
    if (claim.outcome !== "claimed") throw new Error("lease claim failed");

    await closeUserFormContinuation({
      sessionId,
      leaseHandle: {
        lease: claim.lease,
        ownerId: "launch-form-owner",
        release: async () => {
          // The Stop arrives exactly here: the closing commit is done, the
          // lease is not yet gone.
          await enqueueSessionStopRequest({ sessionId });
          await execute("DELETE FROM runner_leases WHERE session_id = $1", [
            sessionId,
          ]);
        },
      },
      consume: (client) =>
        casMarkUserFormResumeConsumedWith(client, INTENT, sessionId).then(
          () => undefined,
        ),
    });

    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
    // The session's NEXT piece of work is free to proceed.
    expect(
      await gateOnOperatorStopTransaction({ sessionId, missionRunId: null }),
    ).toEqual({ kind: "clear" });
  });
});
