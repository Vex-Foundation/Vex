/**
 * Agent Scan activity repo — staged broadcast, CAS finalize, and reads for
 * `agent_activity` (migration `044_agent_activity.sql`; FIX-SPINE round 1
 * hardened the CAS/conditional-state contract per Codex findings 3/5/6/7/9;
 * FIX2-SPINE round 2 added `abortPlannedEvents` per Codex final-review
 * finding 3/C17).
 *
 * Steps 2-4 of the write protocol whose full contract is documented on the
 * sibling `./swap-intent.js` (step 1: pre-broadcast intent creation) — see
 * that file's module doc for the numbered `createAgentActivityIntent` →
 * `markActivityBroadcast` → `markBroadcastAccepted` →
 * `confirmActivityEvent`/`failActivityEvent` sequence every venue handler
 * MUST follow. Every finalizing function here is a CAS write — `WHERE
 * status = 'pending'` — never an unconditional one, and every one returns
 * `{applied, row}` so a caller can tell "I finalized this" from "this was
 * already finalized" (finding 6/C7).
 *
 * These primitives are reused VERBATIM by the bridge API (`./bridge.js`,
 * migration 045, R4) for its Vex-signed legs — they are kind-agnostic CAS
 * writes, not swap-only by SQL shape.
 *
 * W5 Solana staged seam (design `w5-design.md` §2/R2/R2b/R2c, migration 049):
 * `src/tools/solana-ecosystem/shared/solana-transaction/prepare.js`'s
 * `prepareVersionedTx` replaces "sign and send monolithically" with
 * sign-only; the caller persists the derived signature + blockhash evidence
 * via `markActivitySolanaBroadcast` BEFORE calling `submitPreparedTx`
 * (`jupiter-swaps/submit-prepared-tx.js`, `/tx/v1/submit` ONLY). A throw from
 * `prepareVersionedTx` (deserialize failure, the strict sole-signer check, or
 * a blockhash-evidence mismatch) happens AFTER `createAgentActivityIntent`
 * already created the pending row(s) — it is a POST-INTENT failure, so the
 * caller finalizes via `failActivityEvent`/`abortPlannedEvents` below, NEVER
 * `createAgentActivityPreBroadcastFailure` (which would create a duplicate
 * `protocol_executions` row for the same attempt).
 *
 * The stale hashless-intent WALL-CLOCK recovery sweep (`recoverStale-
 * HashlessIntents`) lives in the sibling `./hashless-recovery.js` (C7
 * extraction, keeps this file under the 500-line cap) — see that module's
 * doc for the family-agnostic recovery contract.
 */

import { execute, queryOne, query } from "../../client.js";

import { assertFailureCode, sanitizeFailureReason } from "./validation.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent, AgentActivityFailureCode, BridgeChainFamily, CasResult } from "./types.js";

// ── Types (swap-only inputs) ─────────────────────────────────────────

export interface MarkActivityBroadcastInput {
  txHash: string;
  fromAddress: string;
  nonce: number;
}

export interface ConfirmActivityEventInput {
  executedAmountInHuman?: string;
  executedAmountInRaw?: string;
  executedAmountOutHuman?: string;
  executedAmountOutRaw?: string;
  /** Option-C executed second legs (migration 053) — see `assertYieldConfirmLegs`. */
  executedAmountIn2Human?: string;
  executedAmountIn2Raw?: string;
  executedAmountOut2Human?: string;
  executedAmountOut2Raw?: string;
}

export interface FailActivityEventInput {
  failureCode: AgentActivityFailureCode;
  failureReason: string;
}

// ── Staged broadcast persistence ────────────────────────────────────

/**
 * Persist the SIGNED tx hash + from/nonce BEFORE the RPC submit call
 * (§11.1 step 2). CAS-guarded `WHERE status='pending' AND tx_hash IS NULL`
 * (FIX-SPINE C6 — finding 5) — a repair-sweep, a retry, or a duplicate call
 * can NEVER overwrite an already-staged hash; `applied:false` signals the
 * miss instead.
 */
export async function markActivityBroadcast(
  id: number,
  input: MarkActivityBroadcastInput,
): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3, nonce = $4,
            submit_attempted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
      RETURNING *`,
    [id, input.txHash, input.fromAddress, input.nonce],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markActivityBroadcast") };
}

/**
 * Solana staging variant of `markActivityBroadcast` (B1 nonce matrix): a
 * Vex-signed Solana leg stages its base58 SIGNATURE in `tx_hash` (the Khalani
 * API contract carries signatures in the hash field) with `nonce` left NULL —
 * the 045 `agent_activity_solana_no_nonce` CHECK forbids a Solana nonce. The
 * `chain_family='solana'` predicate makes misuse on an EVM row a CAS miss
 * (`applied:false`), never a wrongly-shaped stage.
 *
 * W5 (design §2/R2, migration 049): the blockhash EVIDENCE `prepareVersionedTx`
 * derives (VERIFY or REPLACE mode — see that module's doc) is persisted in the
 * SAME atomic CAS as the signature, never a separate write — `recentBlockhash`
 * + `lastValidBlockHeight` are REQUIRED here because the 049
 * `agent_activity_solana_staged_has_evidence` CHECK requires both NOT NULL the
 * moment `submit_attempted_at` is set on a `chain_family='solana'` row. A
 * caller that stages a Solana row WITHOUT going through `prepareVersionedTx`
 * (i.e. without real evidence) will fail this CHECK at the DB layer — that is
 * the CHECK doing its job, not a bug in this function.
 */
export async function markActivitySolanaBroadcast(
  id: number,
  input: {
    readonly txHash: string;
    readonly fromAddress: string;
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: number;
  },
): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3,
            recent_blockhash = $4, last_valid_block_height = $5,
            submit_attempted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
        AND chain_family = 'solana'
      RETURNING *`,
    [id, input.txHash, input.fromAddress, input.recentBlockhash, input.lastValidBlockHeight],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markActivitySolanaBroadcast") };
}

/**
 * Stamp `broadcast_at` once the RPC has actually accepted the submission.
 * CAS-guarded `WHERE status='pending' AND tx_hash IS NOT NULL AND
 * broadcast_at IS NULL` (FIX-SPINE C6 — finding 5): cannot run before a hash
 * was staged, cannot run twice.
 */
export async function markBroadcastAccepted(id: number): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET broadcast_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NOT NULL AND broadcast_at IS NULL
      RETURNING *`,
    [id],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markBroadcastAccepted") };
}

// ── CAS finalize ─────────────────────────────────────────────────────

/**
 * `pending -> confirmed`. CAS-guarded; returns `{applied, row}` (FIX-SPINE
 * C7 — finding 6) so a caller (notably the repair sweep, which can race a
 * concurrent finalize) can tell "I just confirmed this" from "this was
 * already confirmed" instead of treating both identically.
 *
 * `event_role='swap'` REQUIRES both executed amounts (FIX-SPINE C8 — finding
 * 3): the row's OWN `event_role` is read first (never trusted from the
 * caller) and validated before the UPDATE is attempted — the DB's
 * `agent_activity_confirmed_swap_has_executed_legs` CHECK is the
 * belt-and-suspenders backstop if this repo function is ever bypassed.
 */
export async function confirmActivityEvent(
  id: number,
  input: ConfirmActivityEventInput,
): Promise<CasResult> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(`agent_activity: confirmActivityEvent — row ${id} does not exist`);
  }
  if (current.eventRole === "swap"
    && (!input.executedAmountInRaw || !input.executedAmountOutRaw)) {
    throw new Error(
      "agent_activity: confirmActivityEvent — event_role 'swap' requires "
        + "executedAmountInRaw + executedAmountOutRaw",
    );
  }
  assertYieldConfirmLegs(current, input);
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(),
            executed_amount_in_human = $2, executed_amount_in_raw = $3,
            executed_amount_out_human = $4, executed_amount_out_raw = $5,
            executed_amount_in2_human = $6, executed_amount_in2_raw = $7,
            executed_amount_out2_human = $8, executed_amount_out2_raw = $9
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [
      id,
      input.executedAmountInHuman ?? null,
      input.executedAmountInRaw ?? null,
      input.executedAmountOutHuman ?? null,
      input.executedAmountOutRaw ?? null,
      input.executedAmountIn2Human ?? null,
      input.executedAmountIn2Raw ?? null,
      input.executedAmountOut2Human ?? null,
      input.executedAmountOut2Raw ?? null,
    ],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "confirmActivityEvent") };
}

/**
 * The repo-level half of migration 053's per-role confirmed-leg contract — the
 * companion change that file's header names as REQUIRED, not optional: the
 * `agent_activity_yield_confirmed_legs` CHECK proves legs are PRESENT, this
 * proves the CALLER supplied them (and, for `yield_claim`, that it supplied no
 * input leg it could not have spent). The guard mirrors the CHECK arm for arm,
 * deliberately: a divergence between the two is how a row starts satisfying one
 * and violating the other.
 *
 * The row's OWN `event_role` and second-leg tokens are read from the persisted
 * row, never taken from the caller — same posture as the `'swap'` guard above.
 */
function assertYieldConfirmLegs(
  current: AgentActivityEvent,
  input: ConfirmActivityEventInput,
): void {
  const role = current.eventRole;
  const fail = (detail: string): never => {
    throw new Error(`agent_activity: confirmActivityEvent — event_role '${role}' ${detail}`);
  };

  if (role === "yield_claim") {
    // A claim sweeps accrued income: nothing is spent, so an executed INPUT is
    // not merely unnecessary, it is evidence the caller decoded the wrong thing.
    if (!input.executedAmountOutRaw) fail("requires executedAmountOutRaw (the credited income)");
    if (input.executedAmountInRaw) fail("must not carry an executed input leg — a claim spends nothing");
    return;
  }
  // `yield_sy` joins the one-in-one-out arm: an SY wrap/unwrap moves exactly one
  // instrument on each side, so it never reaches the Option-C dual checks below.
  if (role === "yield_pt" || role === "yield_yt" || role === "yield_sy") {
    if (!input.executedAmountInRaw || !input.executedAmountOutRaw) {
      fail("requires executedAmountInRaw + executedAmountOutRaw");
    }
    return;
  }
  if (role === "yield_py" || role === "yield_lp") {
    if (!input.executedAmountInRaw || !input.executedAmountOutRaw) {
      fail("requires executedAmountInRaw + executedAmountOutRaw");
    }
    // Dual invariants apply ONLY where the row populated the dual columns.
    if (current.tokenIn2Address && !input.executedAmountIn2Raw) {
      fail("populated a second INPUT leg, so confirming it requires executedAmountIn2Raw");
    }
    if (current.tokenOut2Address && !input.executedAmountOut2Raw) {
      fail("populated a second OUTPUT leg, so confirming it requires executedAmountOut2Raw");
    }
  }
}

/**
 * `pending -> definitively_failed`. CAS-guarded; returns `{applied, row}`
 * (FIX-SPINE C7). `failureReason` is sanitized here (redact + 500-char cap)
 * regardless of what the caller passed (finding 9/C5).
 */
export async function failActivityEvent(
  id: number,
  input: FailActivityEventInput,
): Promise<CasResult> {
  assertFailureCode(input.failureCode);
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = $2, failure_reason = $3,
            updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *`,
    [id, input.failureCode, sanitizeFailureReason(input.failureReason)],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "failActivityEvent") };
}

/**
 * Early-plan-abort finalize (FIX2-SPINE C17 — Codex final-review finding
 * 3): when an upstream leg of a multi-event execution reverts or ends
 * ambiguously, every DOWNSTREAM row that is still `pending` AND was NEVER
 * signed (`tx_hash IS NULL`) is CAS-finalized to `definitively_failed` in one
 * sweep. "Not attempted" is itself a definitive outcome — nothing was ever
 * broadcast for these rows — so this does NOT reopen "ambiguity never
 * terminalizes" (C1): that rule protects a row whose OWN signed submission
 * has an uncertain outcome, never a row that was never signed to begin with.
 * A row that already has a `tx_hash` staged is left untouched — its own
 * repair-sweep path (C1/`agent-activity-repair.ts`) owns finalizing it, since
 * ITS submission may still be in flight or mined.
 *
 * Venue handlers call this on EVERY early return (upstream revert/ambiguity)
 * and in the outer catch (§11.1/C18 — the outer catch must finalize existing
 * rows, never create a second execution). `fromIndex` is the first
 * not-yet-attempted `event_index` in the plan; every row at or after it is a
 * candidate. Never throws for "nothing qualified" — returns `[]`.
 *
 * `listPendingOlderThan` can never pick up a row this function is meant to
 * catch in the interim: that sweep query requires `submit_attempted_at IS NOT
 * NULL`, and `submit_attempted_at` is set ONLY by `markActivityBroadcast`
 * (step 2) — a never-signed row has no `submit_attempted_at`, so it is not a
 * repair-sweep candidate regardless of how long it sits `pending` before this
 * function (or a crash) finalizes or abandons it.
 *
 * `toIndexExclusive` (FIX-ROUND-1 blocker 1, granted minimal widening) bounds the
 * abort to `event_index < toIndexExclusive` so a caller can abort never-signed
 * sibling legs WITHOUT terminalizing a higher-indexed row it must leave pending —
 * specifically the logical `bridge_fill_expected` row after an AMBIGUOUS deposit,
 * whose in-flight guard + W4 null-order-id recovery require it to stay `pending`
 * (aborting it would release the guard while the deposit may have landed, enabling
 * a duplicate bridge). Omitted → the bound is a no-op and the range is `>=
 * fromIndex` exactly as before (every existing caller is byte-unaffected). The
 * bound cannot express what the existing `fromIndex`-only range could, and does
 * not touch any CHECK.
 *
 * INT-TEST NOTE (FIX-A → coordinator/W-SPINE): the CAS suite for the bridge repo
 * (`integration/agent-scan/bridge-cas.int.test.ts`) should gain a case proving
 * `abortPlannedEvents(exec, depositIndex+1, reason, expectedFillIndex)` finalizes
 * the never-signed sibling legs while leaving the `bridge_fill_expected` row
 * `pending` (its `event_index === toIndexExclusive` is excluded).
 */
export async function abortPlannedEvents(
  executionId: number,
  fromIndex: number,
  reason: string,
  toIndexExclusive?: number,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = 'unknown',
            failure_reason = $3, updated_at = NOW()
      WHERE protocol_execution_id = $1 AND event_index >= $2
        AND ($4::int IS NULL OR event_index < $4::int)
        AND status = 'pending' AND tx_hash IS NULL
      RETURNING *`,
    // C17: the stored reason is ALWAYS prefixed "not attempted:" — a single
    // enforcement point, whatever wording the venue caller passed in.
    [executionId, fromIndex, sanitizeFailureReason(`not attempted: ${reason}`), toIndexExclusive ?? null],
  );
  return rows.map(mapRow);
}

// Stale hashless-intent recovery (`recoverStaleHashlessIntents`,
// `HASHLESS_INTENT_RECOVERY_LEASE_MS`) moved to the sibling
// `./hashless-recovery.js` (C7 extraction, kept this file under the repo's
// 500-line file cap) — a wall-clock sweep primitive with its own reason to
// change (recovery policy for abandoned-before-staging rows), distinct from
// the in-execution CAS transitions above. Re-exported unchanged from the
// top-level `agent-activity.ts` facade.

/** Repair-sweep bookkeeping — a receipt lookup found nothing new to report yet. */
export async function touchLastChecked(id: number): Promise<void> {
  await execute(
    `UPDATE agent_activity SET last_checked_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
    [id],
  );
}

// ── Reads ─────────────────────────────────────────────────────────

export async function getActivityEventById(id: number): Promise<AgentActivityEvent | null> {
  const row = await queryOne<Record<string, unknown>>(
    "SELECT * FROM agent_activity WHERE id = $1",
    [id],
  );
  return row ? mapRow(row) : null;
}

/**
 * Repair-sweep candidate set: `pending` rows whose signed submit was
 * attempted more than `olderThanMs` ago, oldest first, capped at `limit`
 * rows (FIX-SPINE C11 — finding 12: the repair sweep must never starve
 * balance/Jupiter sync by loading an unbounded backlog). A row with no
 * `submit_attempted_at` yet (crash before step 2) is not a candidate — there
 * is no hash to check.
 *
 * `chainFamily` is REQUIRED (W5 design REVISION 1 R3 — Codex's
 * non-disjointness finding at this file's prior state): the caller must name
 * which sweep it is, so the EVM repair sweep (`'eip155'`) and the Solana
 * activity sweep (`solana-activity-repair.ts`'s own
 * `listSolanaStagedPending`, a disjoint candidate shape — see below) can
 * never both claim the same row.
 */
export async function listPendingOlderThan(
  olderThanMs: number,
  limit: number,
  chainFamily: BridgeChainFamily,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE status = 'pending'
        AND submit_attempted_at IS NOT NULL
        AND submit_attempted_at < NOW() - make_interval(secs => $1::float8)
        AND chain_family = $3
      ORDER BY submit_attempted_at ASC
      LIMIT $2`,
    [olderThanMs / 1000, limit, chainFamily],
  );
  return rows.map(mapRow);
}

/**
 * Solana activity-sweep candidate set (design `w5-design.md` §4/R3): every
 * LOCALLY-STAGED (`tx_hash IS NOT NULL`) `pending` Solana row, oldest-checked
 * first — `COALESCE(last_checked_at, submit_attempted_at)` so a
 * never-yet-checked row is served before a recently re-checked one (mirrors
 * the bridge sweep's fairness clock). Deliberately UNFILTERED by `kind`: R3
 * corrects §4 to include Solana `bridge_deposit` legs too (the bridge sweep
 * owns ONLY the logical `bridge_fill_expected` row, whose
 * `submit_attempted_at` is always NULL and is therefore never a candidate
 * here) — swap/lend/prediction/bridge-deposit rows share ONE disjoint
 * candidate set by `chain_family` alone. The caller
 * (`solana-activity-repair.ts`) applies its own exponential-backoff
 * eligibility check per row; this query only bounds + orders the batch.
 */
export async function listSolanaStagedPending(limit: number): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE status = 'pending'
        AND chain_family = 'solana'
        AND tx_hash IS NOT NULL
        AND submit_attempted_at IS NOT NULL
      ORDER BY COALESCE(last_checked_at, submit_attempted_at) ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapRow);
}

export interface ListActivityFeedOptions {
  walletAddresses: string[];
  before?: { createdAt: string; id: number };
  limit: number;
}

/** Keyset-paginated (created_at DESC, id DESC) feed for a wallet set — the Agent Scan read surface. */
export async function listActivityFeed(
  options: ListActivityFeedOptions,
): Promise<AgentActivityEvent[]> {
  if (options.walletAddresses.length === 0) return [];
  const params: unknown[] = [options.walletAddresses, options.limit];
  let cursorClause = "";
  if (options.before) {
    params.push(options.before.createdAt, options.before.id);
    cursorClause = `AND (created_at < $3::timestamptz OR (created_at = $3::timestamptz AND id < $4::bigint))`;
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE wallet_address = ANY($1::text[]) ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    params,
  );
  return rows.map(mapRow);
}

/**
 * True iff at least one `agent_activity` row exists for this
 * `protocol_execution_id` — used by the compatibility feed (transactions.ts)
 * to exclude a legacy-failure-half row already represented here (FIX-SPINE
 * C9 — findings 1/2).
 */
export async function existsForExecutionId(protocolExecutionId: number): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM agent_activity WHERE protocol_execution_id = $1) AS exists",
    [protocolExecutionId],
  );
  return row?.exists === true;
}

// ── Internal helpers ─────────────────────────────────────────────────

/** A CAS write missed (row already terminal, or the id genuinely does not exist). */
async function getCurrentRowOrThrow(id: number, caller: string): Promise<AgentActivityEvent> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(`agent_activity: ${caller} — row ${id} does not exist`);
  }
  return current;
}
