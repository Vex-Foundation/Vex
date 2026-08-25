/**
 * THE PENDING-FALLBACK LANE'S SCHEDULING PRIMITIVE (migration 068) — the one
 * place an EVM pending row is selected for observation, and the one place it can
 * leave `pending` without a chain answer.
 *
 * A different reason to change from every sibling: `../swap-lifecycle.js` owns
 * the terminal CASes a chain ANSWER produces, `./swap-lifecycle/verification-
 * bookkeeping.js` owns what we know about a still-pending row, and this module
 * owns WHO IS ALLOWED TO LOOK RIGHT NOW and the one terminal transition that
 * follows from never getting an answer at all.
 *
 * ── Why a claim and not a read ────────────────────────────────────────────
 *
 * Four drivers reach EVM pending rows (the fast-lane wheel, the 30 s executor
 * tick, `drainPendingRuns`, `processNextRun`). A read-then-observe design lets
 * two of them spend an RPC call on the same row, and at a 5 s cadence that is
 * not a rounding error. The claim selects and stamps in ONE statement, so
 * concurrent drivers take disjoint batches.
 *
 * ── Why the claim needs a LEASE, and the lease needs a TOKEN ───────────────
 *
 * `FOR UPDATE SKIP LOCKED` releases its locks when the claim transaction
 * commits — which is BEFORE the RPC the claim was taken for. `evm_claim_lease_
 * until` is what keeps the row claimed across that RPC, and it is FINITE so a
 * process that dies mid-observation self-recovers.
 *
 * But a lease alone is not ownership: a 30 s lease can expire while its RPC is
 * still in flight, a second driver then claims the row legitimately, and the
 * first can come back and either release the SECOND driver's lease or write a
 * stale observation over a fresher one. So every claim mints a token, and every
 * post-RPC write — the terminal CASes, `notePendingReason`, the bookkeeping
 * writers and the release itself — carries `AND evm_claim_token = $token`. A
 * late worker's write then applies to ZERO rows and says so
 * (`sync.evm_claim.lost`) instead of corrupting a fresher observation.
 *
 * ── The phase, and why it is computed in SQL ───────────────────────────────
 *
 * Owner decision A5: 5 s per pending row for its first 10 minutes, then 30 s.
 * The phase is derived from `submit_attempted_at`, which NEVER MOVES. Deriving
 * it from `last_checked_at` — which every observation rewrites — is the bug this
 * repository has now written twice: the computed age resets on every poll and
 * the row never reaches a later phase. Due-ness uses `last_checked_at`; the
 * PHASE uses the immutable anchor. Two clocks, two jobs.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { query, queryOne, queryOneWith } from "../../client.js";
import logger from "@utils/logger.js";
import { settleLinkedActivityRows } from "./linked-transaction-settlement.js";
import { mapRow } from "./mappers.js";
import { resolveActivitySessionByRowId } from "./session-lock.js";
import type { AgentActivityEvent } from "./types.js";
import type { CasResult } from "./types.js";

/** A5: the 5 s phase lasts this long, measured from the row's own immutable submit. */
export const EVM_FAST_PHASE_MS = 10 * 60_000;

/** A5: cadence inside the fast phase. */
export const EVM_FAST_INTERVAL_MS = 5_000;

/** A5: cadence after it, until the row is terminal. */
export const EVM_SLOW_INTERVAL_MS = 30_000;

/** A5: the supported concurrent-pending-row SLA. Beyond it the queue degrades to fair rotation, LOUDLY. */
export const EVM_CLAIM_LIMIT = 25;

/**
 * How long a claim holds its row. Finite on purpose: a killed process's rows
 * become claimable again when it expires, the same recovery shape as the sync
 * worker's stale-run timeout. The observation deadline is strictly shorter, so a
 * live worker never races its own expiry.
 */
export const EVM_CLAIM_LEASE_MS = 30_000;

/**
 * How long a row must stay CONTINUOUSLY non-included before A6 may terminalize
 * it into `superseded_unproven`. Ten minutes of "no node has ever heard of this"
 * on top of the 90 s money gate.
 */
export const NONINCLUSION_TERMINALIZE_AFTER_MS = 10 * 60_000;

/**
 * The interval this row is CURRENTLY checked on, in ms — the same phase decision
 * the claim's SQL makes, available to callers that must SAY it rather than act
 * on it (the progress push, the agent-facing copy).
 *
 * It exists so no surface hard-codes "every 5s": that sentence is false for
 * every row past its fast phase, and stating a cadence we do not hold is a claim
 * beyond the evidence. A missing anchor returns the FAST interval — the
 * conservative direction, since it promises more frequent checking than the row
 * may get rather than less.
 */
export function nextEvmCheckInMs(submitAttemptedAt: string | null, nowMs: number): number {
  if (!submitAttemptedAt) return EVM_FAST_INTERVAL_MS;
  const submittedMs = Date.parse(submitAttemptedAt);
  if (Number.isNaN(submittedMs)) return EVM_FAST_INTERVAL_MS;
  return nowMs - submittedMs < EVM_FAST_PHASE_MS ? EVM_FAST_INTERVAL_MS : EVM_SLOW_INTERVAL_MS;
}

/** A claimed row, plus the token every subsequent write for it must carry. */
export interface ClaimedPendingEvmRow {
  readonly row: AgentActivityEvent;
  readonly claimToken: string;
}

export interface ClaimDuePendingEvmResult {
  readonly claimed: readonly ClaimedPendingEvmRow[];
  /** Rows that were due but did not fit the page — the fair-rotation overflow, reported not hidden. */
  readonly overflowDue: number;
  /** How long the oldest UNCLAIMED due row has been waiting, in ms. `null` when nothing overflowed. */
  readonly oldestUnclaimedWaitMs: number | null;
}

/**
 * The due predicate, shared by the claim and by the overflow count so the two
 * can never disagree about what "due" means.
 *
 * `last_checked_at` is the OBSERVATION clock (due-ness); `submit_attempted_at`
 * is the immutable PHASE anchor. A row never checked is due immediately.
 *
 * PARAMETERISED BY POSITION, not by a fixed `$2`. The two statements bind
 * different leading parameters, and Postgres refuses a statement that declares a
 * parameter it never references — "could not determine data type of parameter
 * $1", which a mocked client cannot reproduce and which only surfaced against a
 * real database. The offset makes the shared fragment fit either caller instead
 * of forcing one of them to bind a placeholder it does not use.
 */
function duePredicateSql(firstPhaseParam: number): string {
  return `
  status = 'pending'
  AND chain_family = 'eip155'
  AND tx_hash IS NOT NULL
  AND submit_attempted_at IS NOT NULL
  AND (evm_claim_lease_until IS NULL OR evm_claim_lease_until < NOW())
  AND COALESCE(last_checked_at, submit_attempted_at) <= NOW() - (
        CASE WHEN NOW() - submit_attempted_at < make_interval(secs => $${firstPhaseParam}::float8)
             THEN make_interval(secs => $${firstPhaseParam + 1}::float8)
             ELSE make_interval(secs => $${firstPhaseParam + 2}::float8)
        END)
`;
}

const PHASE_PARAMS = [
  EVM_FAST_PHASE_MS / 1000,
  EVM_FAST_INTERVAL_MS / 1000,
  EVM_SLOW_INTERVAL_MS / 1000,
] as const;

/**
 * Claim every due EVM pending row, up to `limit`, minting one token per row and
 * taking a finite lease on each — selection, token and lease in ONE statement.
 *
 * `last_checked_at` is deliberately NOT stamped here. It means OBSERVATION
 * FRESHNESS: it orders the fairness queue and drives the "last checked" line the
 * UI renders, so stamping it at claim time would report a check that has not
 * happened yet. The claim stamps the LEASE; the observation stamps the clock.
 */
export async function claimDuePendingEvm(
  limit: number = EVM_CLAIM_LIMIT,
  leaseMs: number = EVM_CLAIM_LEASE_MS,
): Promise<ClaimDuePendingEvmResult> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT id FROM agent_activity
        WHERE ${duePredicateSql(2)}
        ORDER BY COALESCE(last_checked_at, submit_attempted_at) ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE agent_activity a
        SET evm_claim_lease_until = NOW() + make_interval(secs => $5::float8),
            evm_claim_token = gen_random_uuid(),
            updated_at = NOW()
       FROM candidates c
      WHERE a.id = c.id
  RETURNING a.*`,
    [limit, ...PHASE_PARAMS, leaseMs / 1000],
  );

  const claimed = rows.map((raw) => ({
    row: mapRow(raw),
    claimToken: String(raw.evm_claim_token),
  }));

  if (claimed.length < limit) {
    return { claimed, overflowDue: 0, oldestUnclaimedWaitMs: null };
  }
  return { claimed, ...(await measureOverflow()) };
}

/**
 * How many rows are still due beyond the page, and how long the oldest of them
 * has waited.
 *
 * Only asked when the page came back FULL, so the ordinary case pays nothing.
 * `EVM_CLAIM_LIMIT` is the owner's accepted SLA, so row 26 is not a defect — but
 * it must be VISIBLE. Rows beyond the page are served by the same fairness
 * order, so the queue rotates and nothing starves; what degrades is the cadence,
 * and a degradation nobody can see is indistinguishable from a bug.
 */
async function measureOverflow(): Promise<{ overflowDue: number; oldestUnclaimedWaitMs: number | null }> {
  const row = await queryOne<{ due: string; oldest_wait_ms: string | null }>(
    `SELECT COUNT(*)::text AS due,
            (EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(last_checked_at, submit_attempted_at)))) * 1000)::bigint::text
              AS oldest_wait_ms
       FROM agent_activity
      WHERE ${duePredicateSql(1)}`,
    [...PHASE_PARAMS],
  );
  const due = row ? Number(row.due) : 0;
  if (due <= 0) return { overflowDue: 0, oldestUnclaimedWaitMs: null };
  return {
    overflowDue: due,
    oldestUnclaimedWaitMs: row?.oldest_wait_ms === null || row?.oldest_wait_ms === undefined
      ? null
      : Number(row.oldest_wait_ms),
  };
}

/**
 * Release a claim the observation has finished with, so the row's next check is
 * governed by its phase interval rather than by waiting out the lease.
 *
 * FENCED: a worker whose lease already expired and whose row was re-claimed
 * would otherwise release the SECOND driver's lease. Its release matches zero
 * rows instead, which is reported, not silently swallowed.
 */
export async function releaseEvmClaim(id: number, claimToken: string): Promise<boolean> {
  const row = await queryOne<{ id: number }>(
    `UPDATE agent_activity
        SET evm_claim_lease_until = NULL, evm_claim_token = NULL, updated_at = NOW()
      WHERE id = $1 AND evm_claim_token = $2::uuid
      RETURNING id`,
    [id, claimToken],
  );
  if (row) return true;
  logger.debug("sync.evm_claim.lost", { id, caller: "releaseEvmClaim" });
  return false;
}

/**
 * Record that this check observed NON-INCLUSION — start the A6 clock if it is
 * not already running, and leave it exactly where it is if it is.
 *
 * The clock measures a CONTINUOUS RUN of non-inclusion, not the row's age, which
 * is why the "if currently NULL" is load-bearing and why every conclusive
 * contrary observation clears it (`clearNonInclusionClock`).
 */
export async function noteNonInclusionObserved(id: number, claimToken: string): Promise<void> {
  await queryOne<{ id: number }>(
    `UPDATE agent_activity
        SET first_noninclusion_observed_at = COALESCE(first_noninclusion_observed_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND evm_claim_token = $2::uuid
      RETURNING id`,
    [id, claimToken],
  );
}

/**
 * A conclusive CONTRARY observation — a receipt, or the transaction seen in the
 * mempool — resets the A6 clock.
 *
 * Without this reset, a row that was briefly invisible to one node and then
 * observed healthy for an hour would still carry its original clock and could be
 * terminalized on evidence that has since been contradicted.
 */
export async function clearNonInclusionClock(id: number, claimToken: string): Promise<void> {
  await queryOne<{ id: number }>(
    `UPDATE agent_activity
        SET first_noninclusion_observed_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND evm_claim_token = $2::uuid
      RETURNING id`,
    [id, claimToken],
  );
}

/** Why `markSupersededUnproven` wrote nothing. Never a bare `false`. */
export type SupersededMiss = "not_pending" | "claim_lost" | "window_not_elapsed";

export interface SupersededEvidence {
  readonly claimToken: string;
  /** The observation that justifies it — carried onto `pending_reason` and preserved by the transition. */
  readonly reason: "nonce_superseded" | "tx_unknown_to_node";
}

/**
 * `pending → superseded_unproven` (owner decision A6).
 *
 * A NON-FAILURE terminal state: the hash is no longer tracked as in flight and
 * its inclusion/replacement outcome is UNPROVEN. It sets NO `failure_code`, and
 * the closed failure enum is untouched — `confirmation_timeout` stays reserved,
 * as it has been since FIX-SPINE.
 *
 * FIVE HARD GUARDS, all in the statement rather than in the caller, so a caller
 * that gets the policy wrong writes nothing instead of writing a wrong fact:
 *
 * 1. `status = 'pending'` — the ordinary CAS, so a row someone else terminalized
 *    is a miss, not an overwrite.
 * 2. `evm_claim_token = $token` — the same fence as every other post-RPC write.
 * 3. `tx_hash IS NOT NULL AND submit_attempted_at IS NOT NULL` — a row that was
 *    never signed can NEVER enter this state; its terminality belongs to
 *    `abortPlannedEvents`, which knows it was abandoned before broadcast.
 * 4. THE 90 s MONEY GATE, verbatim: inside it the owning handler may still be
 *    decoding its own receipt, and terminalizing under it would forfeit real
 *    executed amounts. Same rule as every other terminalization.
 * 5. The A6 window on the CONTINUOUS non-inclusion run - for
 *    `tx_unknown_to_node` ONLY. Both clocks are required there, hence
 *    `GREATEST`: the gate is whichever finishes last.
 *
 * WHY `nonce_superseded` SKIPS GUARD 5. The window exists because
 * "no node we asked has heard of this hash" is INCONCLUSIVE: the transaction may
 * sit in a mempool we did not ask, so time is what turns silence into evidence.
 * `nonce_superseded` is not silence. It is
 * `eth_getTransactionCount(from, 'latest') > nonce`, which is the node's own
 * statement that a transaction from this sender with this nonce is ALREADY
 * INCLUDED in a block, while this hash has no receipt - so this hash can never
 * land, and no amount of further waiting can change that. Waiting the window out
 * on definitive evidence only kept a row reporting "in flight" for ten more
 * minutes about a transaction the chain had already settled without it. (This is
 * the reference wallets' `#isNonceTaken` rule: a CONFIRMED same-(from, nonce)
 * sibling is conclusive, not suggestive.)
 *
 * The 90 s money gate (guard 4) still applies to BOTH reasons: inside it the
 * owning handler may still be decoding its own receipt, and that is a race with
 * OUR OWN writer rather than a question about the chain.
 *

 * `pending_reason` and the evidence already on the row (`last_verification_
 * reason`, `last_checked_at`, `from_address`, `nonce`) are preserved: the row
 * must still be able to say WHY it ended this way. A6 makes the row terminal,
 * not explained.
 */
export async function markSupersededUnproven(
  id: number,
  evidence: SupersededEvidence,
  handlerWindowMs: number,
  nonInclusionWindowMs: number = NONINCLUSION_TERMINALIZE_AFTER_MS,
): Promise<CasResult & { reason?: SupersededMiss }> {
  const sessionId = await resolveActivitySessionByRowId(id);
  return settleLinkedActivityRows({
    activityId: id,
    sessionId,
    intentOutcome: "superseded_unproven",
    activityTarget: { status: "superseded_unproven" },
    activityWrite: (client) => runMarkSupersededUnproven(
      client,
      id,
      evidence,
      handlerWindowMs,
      nonInclusionWindowMs,
    ),
  });
}

/** Supersession CAS on the caller's existing transaction and session lock. */
export async function markSupersededUnprovenWith(
  client: PoolClient,
  id: number,
  evidence: SupersededEvidence,
  handlerWindowMs: number,
  nonInclusionWindowMs: number = NONINCLUSION_TERMINALIZE_AFTER_MS,
): Promise<CasResult & { reason?: SupersededMiss }> {
  return runMarkSupersededUnproven(
    client,
    id,
    evidence,
    handlerWindowMs,
    nonInclusionWindowMs,
  );
}

async function runMarkSupersededUnproven(
  client: PoolClient,
  id: number,
  evidence: SupersededEvidence,
  handlerWindowMs: number,
  nonInclusionWindowMs: number,
): Promise<CasResult & { reason?: SupersededMiss }> {
  // The non-inclusion window is a guard on INCONCLUSIVE evidence only. A
  // confirmed same-(from, nonce) sibling is conclusive, so it gates on the 90 s
  // money window alone - see guard 5 in this function's doc.
  const conclusive = evidence.reason === "nonce_superseded";
  const windowSql = conclusive
    ? "AND NOW() >= submit_attempted_at + make_interval(secs => $4::float8)"
    : `AND first_noninclusion_observed_at IS NOT NULL
        AND NOW() >= GREATEST(
              submit_attempted_at + make_interval(secs => $4::float8),
              first_noninclusion_observed_at + make_interval(secs => $5::float8))`;
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `UPDATE agent_activity
        SET status = 'superseded_unproven',
            pending_reason = $3,
            updated_at = NOW(),
            evm_claim_lease_until = NULL,
            evm_claim_token = NULL
      WHERE id = $1
        AND status = 'pending'
        AND evm_claim_token = $2::uuid
        AND tx_hash IS NOT NULL
        AND submit_attempted_at IS NOT NULL
        ${windowSql}
      RETURNING *`,
    conclusive
      ? [id, evidence.claimToken, evidence.reason, handlerWindowMs / 1000]
      : [
          id,
          evidence.claimToken,
          evidence.reason,
          handlerWindowMs / 1000,
          nonInclusionWindowMs / 1000,
        ],
  );
  if (row) return { applied: true, row: mapRow(row) };

  const current = await queryOneWith<Record<string, unknown>>(
    client,
    "SELECT * FROM agent_activity WHERE id = $1",
    [id],
  );
  if (!current) {
    throw new Error(`agent_activity: markSupersededUnproven — row ${id} does not exist`);
  }
  const mapped = mapRow(current);
  if (mapped.status !== "pending") return { applied: false, row: mapped, reason: "not_pending" };
  if (mapped.evmClaimToken !== evidence.claimToken) {
    logger.debug("sync.evm_claim.lost", { id, caller: "markSupersededUnproven" });
    return { applied: false, row: mapped, reason: "claim_lost" };
  }
  // Still pending, still ours: the only remaining guards are the time windows -
  // the 90 s money gate for a conclusive `nonce_superseded`, that gate plus the
  // continuous non-inclusion run for `tx_unknown_to_node`.
  return { applied: false, row: mapped, reason: "window_not_elapsed" };
}

/** A fresh token, for callers that need to construct a claim outside the claim query (tests, recovery). */
export function mintClaimToken(): string {
  return randomUUID();
}
