/**
 * `agent_activity` SOLANA activity sweep — a STATUS-ONLY pending-transaction
 * resolver (owner decree 2026-07-30), the Solana twin of
 * `agent-activity-repair.ts`.
 *
 * Sole owner of every `chain_family='solana'` LOCALLY-STAGED row's terminality
 * (Vex-signed Jupiter swap/lend/prediction legs AND Solana `bridge_deposit`
 * origin legs — the bridge order-status sweep, `bridge-activity-repair.ts`,
 * owns ONLY the logical `bridge_fill_expected` row, whose
 * `submit_attempted_at` is always NULL and is therefore never a candidate
 * here). Disjoint from the EVM sweep by construction — see
 * `listSolanaStagedPending` / `listPendingOlderThan`'s `chainFamily` parameter.
 *
 * ONE QUESTION PER ROW: did this signature land, and did it carry an error?
 * `err == null` at `confirmed`/`finalized` commitment → `confirmed` via
 * `confirmActivityEventStatusOnly` (NO amounts written). `err != null` →
 * `definitively_failed`. The sweep decodes NOTHING: no transaction-body
 * settlement decode, no protocol-aware dispatch, no provider history lookup.
 * Amounts are deferred by owner decree; Agent Scan shows the quoted amount
 * labelled "estimated" rather than dressing a quote up as a settlement.
 *
 * PROCESSED IS NOT LANDED, IN BOTH DIRECTIONS: a `processed`-only (or unknown)
 * commitment leaves the row `pending` whether or not it carries an `err` — a
 * processed transaction can still be dropped with its fork, so neither its
 * success NOR its failure is proven yet.
 *
 * ABSENT IS NOT NULL: `err: null` is the chain's proof of success; a status
 * entry or transaction body with NO `err` property at all is a shape we cannot
 * read, and is treated as ambiguity. Coercing absence to `null` would confirm a
 * transaction whose outcome was never actually read.
 *
 * EVERY DEAD-END TOUCHES `last_checked_at`: the candidate query orders by it
 * under a LIMIT, so a row that cannot be resolved this tick (RPC outage,
 * malformed evidence, not-yet-expired) must rotate to the BACK of the queue.
 * Otherwise a handful of permanently-unresolvable rows pin the window and
 * starve every newer pending row behind them.
 *
 * ALSO owns the periodic call site for the stale hashless-intent recovery
 * (`recoverStaleHashlessIntents`, generalized off Solana-only to EVERY chain
 * family) — nothing else calls it periodically, so this sweep's tick recovers
 * stale hashless EVM rows too; see that function's own doc
 * (`../db/repos/agent-activity/hashless-recovery.js`).
 *
 * NO GIVE-UP RAIL: ambiguous evidence (RPC unavailable, signature genuinely not
 * yet found, unhealthy RPC) NEVER terminalizes a row on its own — it stays
 * `pending`, re-checked on the next tick, with an operator-visible escalation
 * log once a row has been pending unusually long (`isSolanaSweepEscalated`).
 * The ONE way absence-of-proof may terminalize a row is the EXPIRY gate below.
 *
 * EXPIRY GATE (literal AND): `getSignatureStatuses`
 * (`searchTransactionHistory:true`) MISS, AND a `finalized` `getTransaction`
 * (`maxSupportedTransactionVersion:0`) ALSO MISS, both over a GENESIS-VERIFIED,
 * SSRF-safe healthy RPC (`solana-rpc-safety.js`), AND the row's OWN persisted
 * `last_valid_block_height` proves the current block height has passed it —
 * only THEN is `failure_code='solana_signature_expired'` written (safe: an
 * expired blockhash can never land). A row with no persisted evidence (a
 * grandfathered pre-049 row) can never be expired — it stays pending forever.
 *
 * MINED FAILURE CARRIES THE ERROR: a terminalized mined failure quotes the
 * chain's OWN `err` in `failure_reason`, serialized by
 * `solana-transaction/onchain-error-summary.js` (deterministic, 200-char
 * bounded). `failure_code` is `mined_revert`, matching the EVM sweep.
 *
 * DUPLICATE-CAS AWARENESS: the finalizers return `{applied, row}` — an
 * `applied:false` means a concurrent process (another sweep instance, or a
 * handler's own late finalize) already settled this row; logged and skipped,
 * never double-counted.
 *
 * TESTABILITY: `repairPendingSolanaActivity` is pure orchestration over an
 * injected `SolanaActivitySweepDeps` port — exactly the external reads this
 * sweep may perform; its PRODUCTION wiring lives in the sibling
 * `./solana-activity-repair-deps.js`. Every DB read/write is imported directly
 * and mocked via `vi.mock` in tests.
 */

import {
  confirmActivityEventStatusOnly,
  failActivityEvent,
  touchLastChecked,
  clearVerificationStall,
  listSolanaStagedPending,
  recoverStaleHashlessIntents,
  HASHLESS_INTENT_RECOVERY_LEASE_MS,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeSolanaOnChainError } from "@tools/solana-ecosystem/shared/solana-transaction/onchain-error-summary.js";
import logger from "@utils/logger.js";

// ── Tunables ──────────────────────────────────────────────────────────────

/** Bounded batch per sweep run (mirrors the EVM/bridge sweeps' own C11 discipline). */
export const SOLANA_SWEEP_BATCH_LIMIT = 25;
export const SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT = 25;

/**
 * Flat re-check cadence, matching the job's own 30s interval (migration 061).
 *
 * This replaced an escalating 60s → 5m → 30m → 2h backoff. That backoff existed
 * when a check meant a transaction-body fetch plus a protocol-aware decode; a
 * status-only check is one batched `getSignatureStatuses` entry, so the cost of
 * re-asking is negligible and a stuck row should not wait hours to be noticed.
 */
export const SOLANA_SWEEP_DUE_INTERVAL_MS = 30_000;

/** Operator-visible escalation threshold (log only — never a failure trigger). */
export const SOLANA_SWEEP_ESCALATION_AGE_MS = 4 * 3_600_000;

/** `true` iff this row has never been checked, or was last checked at least one interval ago. */
export function isSolanaSweepCandidateDue(
  row: Pick<AgentActivityEvent, "submitAttemptedAt" | "lastCheckedAt">,
  nowMs: number,
): boolean {
  if (!row.submitAttemptedAt) return false; // defensive; the candidate query already requires this.
  if (Number.isNaN(Date.parse(row.submitAttemptedAt))) return false;
  if (!row.lastCheckedAt) return true;
  const lastCheckedMs = Date.parse(row.lastCheckedAt);
  if (Number.isNaN(lastCheckedMs)) return true;
  return nowMs - lastCheckedMs >= SOLANA_SWEEP_DUE_INTERVAL_MS;
}

/** `true` once a row has been pending long enough to warrant an operator-visible log (never a failure trigger). */
export function isSolanaSweepEscalated(
  row: Pick<AgentActivityEvent, "submitAttemptedAt">,
  nowMs: number,
): boolean {
  if (!row.submitAttemptedAt) return false;
  const submittedAtMs = Date.parse(row.submitAttemptedAt);
  if (Number.isNaN(submittedAtMs)) return false;
  return nowMs - submittedAtMs >= SOLANA_SWEEP_ESCALATION_AGE_MS;
}

// ── Deps (the ONLY RPC surface this sweep may have) ──────────────────────

export interface SolanaSignatureStatusValue {
  readonly err: unknown;
  readonly confirmationStatus: string | null;
}

/**
 * `"found"` carries a genuine answer. `"not_found"` is a genuine "no such
 * record" answer FROM a trusted RPC (meaningful for the expiry gate).
 * `"unavailable"` means no healthy/verified RPC could be reached, or the
 * response was malformed — NEVER treated as "not found".
 */
export type SolanaRpcLookup<T> =
  | { readonly outcome: "found"; readonly value: T }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" };

export interface SolanaActivitySweepDeps {
  /**
   * BATCHED status lookup — `getSignatureStatuses` takes an array, so one sweep
   * run costs ONE RPC round trip for its whole due batch instead of one per
   * row. The returned array is aligned with the input by index; a `null` entry
   * is a genuine "no such signature" from a trusted RPC. A transport failure or
   * a malformed response is `"unavailable"` for the WHOLE call — never silently
   * reinterpreted as per-row absence.
   */
  readonly getSignatureStatuses: (
    signatures: readonly string[],
  ) => Promise<SolanaRpcLookup<readonly (SolanaSignatureStatusValue | null)[]>>;
  /** Raw `getTransaction` (jsonParsed, finalized, maxSupportedTransactionVersion:0) RPC result. */
  readonly getFinalizedTransaction: (signature: string) => Promise<SolanaRpcLookup<unknown>>;
  readonly getCurrentBlockHeight: () => Promise<SolanaRpcLookup<number>>;
}

export interface SolanaActivitySweepResult {
  readonly recovered: number;
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
}

// ── Orchestration ─────────────────────────────────────────────────────────

export async function repairPendingSolanaActivity(
  deps: SolanaActivitySweepDeps,
): Promise<SolanaActivitySweepResult> {
  const recovered = await recoverStaleHashlessIntents(
    HASHLESS_INTENT_RECOVERY_LEASE_MS,
    SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT,
  );

  const candidates = await listSolanaStagedPending(SOLANA_SWEEP_BATCH_LIMIT);
  const now = Date.now();
  const due = candidates.filter((event) => event.txHash && isSolanaSweepCandidateDue(event, now));
  const notDue = candidates.length - due.length;

  const batch = await resolveSolanaPendingRows(due, deps, now);

  return {
    recovered: recovered.length,
    checked: due.length,
    confirmed: batch.confirmed,
    failed: batch.failed,
    stillPending: notDue + batch.stillPending,
  };
}

export interface SolanaBatchResolution {
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
}

/**
 * Resolve a BATCH of staged Solana rows — the sweep's entire per-row policy,
 * extracted so the Wave P fast lane asks the chain exactly the same question,
 * through exactly the same deps, and terminalizes under exactly the same rules.
 *
 * Batching is preserved across both callers, and is why this takes a list rather
 * than a row: `getSignatureStatuses` accepts an array, so one cycle costs ONE
 * RPC round trip however many lanes are due. A per-row fast lane that called
 * this once per row would multiply Solana RPC load by the lane count — exactly
 * the load risk the fast-lane design bounds everywhere else.
 *
 * The caller selects which rows are due; this function owns what an observation
 * means. Every row it cannot resolve still gets `touchLastChecked`, so the
 * global sweep's fairness ordering stays honest even when the fast lane is the
 * one doing the looking.
 */
export async function resolveSolanaPendingRows(
  due: readonly AgentActivityEvent[],
  deps: SolanaActivitySweepDeps,
  nowMs: number,
): Promise<SolanaBatchResolution> {
  if (due.length === 0) return { confirmed: 0, failed: 0, stillPending: 0 };

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  const statuses = await deps.getSignatureStatuses(due.map((event) => event.txHash!));

  for (const [index, event] of due.entries()) {
    if (isSolanaSweepEscalated(event, nowMs)) {
      logger.warn("solana_activity_repair.long_pending_escalation", {
        id: event.id,
        protocol: event.protocol,
        eventRole: event.eventRole,
        hint: "still pending past the escalation threshold — tracked automatically, never auto-failed on absence of proof",
      });
    }
    const outcome = await processSolanaCandidate(event, statusFor(statuses, index), deps);
    if (outcome === "confirmed") confirmed++;
    else if (outcome === "failed") failed++;
    else if (outcome === "pending") stillPending++;
    // outcome === "duplicate": a concurrent process already settled this row
    // — logged in logDuplicateCas already; never double-counted here.
  }

  return { confirmed, failed, stillPending };
}

/** Project the batched lookup onto ONE row. A short/absent entry is ambiguity, never absence. */
function statusFor(
  batch: SolanaRpcLookup<readonly (SolanaSignatureStatusValue | null)[]>,
  index: number,
): SolanaRpcLookup<SolanaSignatureStatusValue> {
  if (batch.outcome !== "found") return batch;
  const entry = batch.value[index];
  if (entry === undefined) return { outcome: "unavailable" };
  if (entry === null) return { outcome: "not_found" };
  return { outcome: "found", value: entry };
}

type CandidateOutcome = "confirmed" | "failed" | "pending" | "duplicate";

async function processSolanaCandidate(
  event: AgentActivityEvent,
  statusLookup: SolanaRpcLookup<SolanaSignatureStatusValue>,
  deps: SolanaActivitySweepDeps,
): Promise<CandidateOutcome> {
  if (statusLookup.outcome === "unavailable") {
    logUnavailable(event, "signature_status");
    // Rotate even though nothing was learned. This is the WHOLE-BATCH failure
    // path: the adapter declines the entire `getSignatureStatuses` call when any
    // entry is malformed, so without touching, one bad entry (or an RPC outage)
    // would reselect the same oldest `SOLANA_SWEEP_BATCH_LIMIT` rows every tick
    // forever and starve every newer pending row behind them. No terminal state
    // changes here — fail-closed is untouched.
    await touchLastChecked(event.id, "signature_status_unavailable");
    return "pending";
  }

  if (statusLookup.outcome === "found") {
    if (!isLandedStatus(statusLookup.value.confirmationStatus)) {
      // `processed` only (or an unknown commitment): NOT proven either way —
      // the fork carrying it can still be dropped, taking its error with it.
      // The RPC ANSWERED, so this is not a stall — clear the counter, or an
      // ordinary slow transaction would eventually render "verification
      // stalled", which is a lie about what we know.
      await clearVerificationStall(event.id);
      return "pending";
    }
    if (!hasOwnErr(statusLookup.value)) {
      // Landed commitment but no readable `err` field — the adapter already
      // declines this shape; this is the sweep's own belt-and-suspenders, so a
      // hand-built or future port can never confirm on absent evidence.
      logger.warn("solana_activity_repair.unreadable_signature_status", { id: event.id });
      await touchLastChecked(event.id, "unreadable_signature_status");
      return "pending";
    }
    if (isOnChainError(statusLookup.value.err)) {
      return finalizeMinedFailure(
        event,
        `getSignatureStatuses reported an on-chain error: ${summarizeSolanaOnChainError(statusLookup.value.err)}`,
      );
    }
    // Landed, no error. That is the whole question this sweep asks — no
    // transaction body is fetched, because there is nothing left to learn.
    return finalizeStatusOnlyConfirm(event);
  }

  // statusLookup.outcome === "not_found" — the status cache only retains recent
  // signatures, so cross-check `getTransaction` before ANY expiry reasoning
  // (BOTH must miss). Its result is read for `meta.err` PRESENCE only; it is
  // never decoded for amounts.
  const txLookup = await deps.getFinalizedTransaction(event.txHash!);
  if (txLookup.outcome === "unavailable") {
    logUnavailable(event, "get_transaction");
    // Touch even though nothing was learned: the candidate query orders by
    // `last_checked_at` under a LIMIT, so a row whose fallback keeps failing
    // must move to the BACK of the queue or it pins the window and starves
    // every newer pending row behind it.
    await touchLastChecked(event.id, "get_transaction_unavailable");
    return "pending";
  }
  if (txLookup.outcome === "found") {
    const meta = readTransactionMetaErr(txLookup.value);
    if (!meta.present) {
      logger.warn("solana_activity_repair.unreadable_transaction_meta", { id: event.id });
      await touchLastChecked(event.id, "unreadable_transaction_meta");
      return "pending";
    }
    if (isOnChainError(meta.err)) {
      return finalizeMinedFailure(
        event,
        `getTransaction reported meta.err: ${summarizeSolanaOnChainError(meta.err)}`,
      );
    }
    return finalizeStatusOnlyConfirm(event);
  }

  // BOTH missed — the only path that may terminalize on absence-of-proof,
  // and only when the blockhash is PROVABLY expired.
  return finalizeIfExpired(event, deps);
}

/**
 * `meta.err` out of a raw `getTransaction` result — the ONLY thing this sweep
 * reads out of a transaction body.
 *
 * ABSENT IS NOT NULL. The result is `{ present: false }` unless the body
 * actually CARRIES an `err` property; a missing `meta`, a non-object `meta`, or
 * a `meta` without its own `err` key is malformed evidence, and reading it as
 * `err === null` would status-confirm a transaction whose outcome we never
 * read. Only an explicit `err: null` proves success.
 */
function readTransactionMetaErr(raw: unknown): { present: false } | { present: true; err: unknown } {
  if (typeof raw !== "object" || raw === null) return { present: false };
  const meta = (raw as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(meta, "err")) return { present: false };
  return { present: true, err: (meta as Record<string, unknown>).err };
}

async function finalizeStatusOnlyConfirm(event: AgentActivityEvent): Promise<CandidateOutcome> {
  // A SIGNATURE STATUS, never a receipt — Solana has none. The provenance code
  // says so, so a later reader cannot mistake this for a decoded receipt.
  const outcome = await confirmActivityEventStatusOnly(event.id, "receipt_status_only_solana");
  if (outcome.applied) return "confirmed";
  logDuplicateCas(event.id, "confirm");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

async function finalizeIfExpired(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
): Promise<CandidateOutcome> {
  if (event.lastValidBlockHeight === null) {
    // No persisted evidence to reason about expiry from (a grandfathered
    // pre-049 row) — never guess; stays pending, like any other ambiguous row.
    await touchLastChecked(event.id, "no_blockhash_evidence");
    return "pending";
  }
  const heightLookup = await deps.getCurrentBlockHeight();
  if (heightLookup.outcome !== "found") {
    logUnavailable(event, "block_height");
    // Same fairness reason as the `getTransaction` outage above: a row that
    // cannot be resolved must still rotate out of the LIMIT window.
    await touchLastChecked(event.id, "block_height_unavailable");
    return "pending";
  }
  if (heightLookup.value <= event.lastValidBlockHeight) {
    // Both lookups answered and the blockhash is provably still valid — we know
    // exactly where this row stands, so this is not a stall.
    await clearVerificationStall(event.id);
    return "pending"; // not yet expired — the tx may still land.
  }
  const outcome = await failActivityEvent(event.id, {
    failureCode: "solana_signature_expired",
    failureReason:
      `Solana activity sweep: blockhash expired (current block height ${heightLookup.value} `
      + `> persisted last_valid_block_height ${event.lastValidBlockHeight}) with no signature found.`,
  });
  if (outcome.applied) return "failed";
  logDuplicateCas(event.id, "fail");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

async function finalizeMinedFailure(event: AgentActivityEvent, reason: string): Promise<CandidateOutcome> {
  const outcome = await failActivityEvent(event.id, {
    failureCode: "mined_revert",
    failureReason: `Solana activity sweep: ${reason}.`,
  });
  if (outcome.applied) return "failed";
  logDuplicateCas(event.id, "fail");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

function isOnChainError(err: unknown): boolean {
  return err !== null && err !== undefined;
}

/** ABSENT IS NOT NULL — only an entry that CARRIES an `err` field is evidence either way. */
function hasOwnErr(value: SolanaSignatureStatusValue): boolean {
  return Object.prototype.hasOwnProperty.call(value, "err");
}

function isLandedStatus(status: string | null): boolean {
  return status === "confirmed" || status === "finalized";
}

function logUnavailable(
  event: AgentActivityEvent,
  stage: "signature_status" | "get_transaction" | "block_height",
): void {
  logger.warn("solana_activity_repair.rpc_unavailable", { id: event.id, stage });
}

function logDuplicateCas(id: number, attempted: "confirm" | "fail"): void {
  // Not a failure — a concurrent process (another sweep run, or a handler's
  // own late finalize) already settled this row before this sweep got to it.
  logger.info("solana_activity_repair.duplicate_cas_miss", { id, attempted });
}

// ── Production wiring ─────────────────────────────────────────────────────

// `buildProductionSolanaRepairDeps` (the health-gated adapters over this
// port's external reads) lives in the sibling
// `./solana-activity-repair-deps.js` — a different reason to change
// (endpoints/transport/response shapes) from this file's terminality policy.
// RE-EXPORTED here so every existing import site keeps working, including the
// DYNAMIC `await import("./solana-activity-repair.js")` call sites in
// `worker.ts`/`index.ts` that no typecheck would catch.
export { buildProductionSolanaRepairDeps } from "./solana-activity-repair-deps.js";
