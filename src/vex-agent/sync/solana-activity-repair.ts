/**
 * `agent_activity` SOLANA activity sweep (W5 design `w5-design.md` §4,
 * REVISION 1 R3, REVISION 2 R2b/R2c — Batch 4/K3). Sole owner of every
 * `chain_family='solana'` LOCALLY-STAGED row's terminality (Vex-signed
 * Jupiter swap/lend/prediction legs AND Solana `bridge_deposit` origin legs
 * — the bridge order-status sweep, `bridge-activity-repair.ts`, owns ONLY
 * the logical `bridge_fill_expected` row, whose `submit_attempted_at` is
 * always NULL and is therefore never a candidate here). Disjoint from the
 * EVM repair sweep (`agent-activity-repair.ts`, now `chain_family='eip155'`
 * scoped) by construction — see `listSolanaStagedPending` /
 * `listPendingOlderThan`'s `chainFamily` parameter (R3, Codex's
 * non-disjointness finding).
 *
 * ALSO owns the periodic call site for the stale hashless-intent recovery
 * (`recoverStaleHashlessIntents`, K2 primitive, generalized off Solana-only
 * to EVERY chain family by C7) — nothing else calls it periodically, so
 * this sweep's tick now recovers stale hashless EVM rows too, as a direct
 * consequence of sharing the one periodic caller; see that function's own
 * doc (`../db/repos/agent-activity/hashless-recovery.js`) for the
 * family-agnostic contract.
 *
 * NO GIVE-UP RAIL (R3 supersedes §4's original MAX_CHECKS text): ambiguous
 * evidence (RPC unavailable, signature genuinely not yet found, unhealthy
 * RPC) NEVER terminalizes a row on its own — it stays `pending` forever,
 * re-checked with EXPONENTIAL BACKOFF (`solanaSweepBackoffIntervalMs`,
 * `last_checked_at`-driven, no counter column needed) + an operator-visible
 * escalation log once a row has been pending unusually long
 * (`isSolanaSweepEscalated`). The ONE way absence-of-proof may terminalize a
 * row is the EXPIRY gate below — never a timeout on its own.
 *
 * EXPIRY GATE (R3, literal AND): `getSignatureStatuses`
 * (`searchTransactionHistory:true`) MISS, AND a `finalized` `getTransaction`
 * (`maxSupportedTransactionVersion:0`) ALSO MISS, both over a
 * GENESIS-VERIFIED, SSRF-safe healthy RPC (`solana-rpc-safety.js`, extracted
 * from `bridge-activity-repair.ts` for this exact reuse), AND the row's OWN
 * persisted `last_valid_block_height` (K2's staged-seam evidence) proves the
 * current block height has passed it — only THEN is
 * `failure_code='solana_signature_expired'` written (safe: an expired
 * blockhash can never land). A row with no persisted evidence (a
 * grandfathered pre-049 row, per K1's `NOT VALID` migration decision) can
 * never be expired — it stays pending forever, matching R3's "malformed/
 * missing evidence fails closed" instruction verbatim.
 *
 * SETTLEMENT DECODING (`solana-settlement-dispatch.js`): a landed transaction
 * with `meta.err===null` is decoded by the decoder the ROW selects — its
 * persisted settlement profile picks a protocol-aware decoder, everything else
 * takes the generic owner+mint balance-delta path; `event_role='swap'`
 * requires BOTH legs proven (044:134, `confirmActivityEvent`'s own DB-level
 * guard is the backstop). A decoder decline (undecodable success) NEVER
 * guesses — the row stays `pending` and an anomaly is logged, mirroring the
 * EVM sweep's own "no settlement decoder" contract. Proven magnitudes are
 * stored raw AND as exact decimals (`solana-executed-amount-human.js`, using
 * the row's own persisted decimals) so a confirmed row is readable.
 *
 * DUPLICATE-CAS AWARENESS: `confirmActivityEvent`/`failActivityEvent` return
 * `{applied, row}` — an `applied:false` means a concurrent process (another
 * sweep instance, or a handler's own late finalize) already settled this row;
 * logged and skipped, never double-counted.
 *
 * TESTABILITY: `repairPendingSolanaActivity` is pure orchestration over an
 * injected `SolanaActivitySweepDeps` port — exactly the three RPC reads this
 * sweep may perform (mirrors `RepairDeps`/`BridgeRepairDeps`'s "ONE
 * dependency surface" discipline). Every DB read/write
 * (`listSolanaStagedPending`, `confirmActivityEvent`, `failActivityEvent`,
 * `touchLastChecked`, `recoverStaleHashlessIntents`) is imported
 * directly and mocked via `vi.mock` in tests, matching
 * `agent-activity-repair-error-scrubbing.test.ts`'s established pattern.
 */

import {
  confirmActivityEvent,
  failActivityEvent,
  touchLastChecked,
  listSolanaStagedPending,
  recoverStaleHashlessIntents,
  HASHLESS_INTENT_RECOVERY_LEASE_MS,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { parseSolanaTransactionResult } from "./solana-settlement-decoders.js";
import { decodeSolanaSettlement } from "./solana-settlement-dispatch.js";
import { withExactExecutedAmountHuman } from "./solana-executed-amount-human.js";
import { confirmSolanaMainnetGenesis, solanaRpcCall } from "./solana-rpc-safety.js";
import { loadConfig } from "@config/store.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

// ── Tunables ──────────────────────────────────────────────────────────────

/** Bounded batch per sweep run (mirrors the EVM/bridge sweeps' own C11 discipline). */
export const SOLANA_SWEEP_BATCH_LIMIT = 25;
export const SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT = 25;

/**
 * Exponential-ish backoff WITHOUT a counter column: the poll cadence is a
 * pure function of elapsed age since `submit_attempted_at`, computed fresh
 * every sweep run from timestamps alone (`last_checked_at` marks when this
 * row was last actually looked at). Solana finality is typically seconds, so
 * a fresh row is re-checked every tick; a row still unresolved after longer
 * waits backs off to reduce RPC load without ever giving up.
 */
const SOLANA_SWEEP_BACKOFF_STEPS: ReadonlyArray<{ readonly maxAgeMs: number; readonly intervalMs: number }> = [
  { maxAgeMs: 10 * 60_000, intervalMs: 60_000 }, // < 10 min old: every tick (~60s)
  { maxAgeMs: 60 * 60_000, intervalMs: 5 * 60_000 }, // < 1h old: every 5 min
  { maxAgeMs: 4 * 3_600_000, intervalMs: 30 * 60_000 }, // < 4h old: every 30 min
];
const SOLANA_SWEEP_MAX_BACKOFF_MS = 2 * 3_600_000; // beyond 4h: every 2h
/** Operator-visible escalation threshold (R3 "log + feed 'tracking delayed'"). */
export const SOLANA_SWEEP_ESCALATION_AGE_MS = 4 * 3_600_000;

export function solanaSweepBackoffIntervalMs(ageMs: number): number {
  for (const step of SOLANA_SWEEP_BACKOFF_STEPS) {
    if (ageMs < step.maxAgeMs) return step.intervalMs;
  }
  return SOLANA_SWEEP_MAX_BACKOFF_MS;
}

/** `true` iff this row has waited at least its current backoff interval since it was last checked (or first staged, if never checked). */
export function isSolanaSweepCandidateDue(
  row: Pick<AgentActivityEvent, "submitAttemptedAt" | "lastCheckedAt">,
  nowMs: number,
): boolean {
  if (!row.submitAttemptedAt) return false; // defensive; the candidate query already requires this.
  const submittedAtMs = Date.parse(row.submitAttemptedAt);
  if (Number.isNaN(submittedAtMs)) return false;
  const basisMs = row.lastCheckedAt ? Date.parse(row.lastCheckedAt) : submittedAtMs;
  if (Number.isNaN(basisMs)) return false;
  const ageMs = Math.max(0, nowMs - submittedAtMs);
  return nowMs - basisMs >= solanaSweepBackoffIntervalMs(ageMs);
}

/** `true` once a row has been pending long enough to warrant an operator-visible log (never a failure trigger — R3). */
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
  readonly getSignatureStatus: (signature: string) => Promise<SolanaRpcLookup<SolanaSignatureStatusValue>>;
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
  let checked = 0;
  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  for (const event of candidates) {
    if (!isSolanaSweepCandidateDue(event, now)) {
      stillPending++;
      continue;
    }
    if (isSolanaSweepEscalated(event, now)) {
      logger.warn("solana_activity_repair.long_pending_escalation", {
        id: event.id,
        protocol: event.protocol,
        eventRole: event.eventRole,
        hint: "still pending past the escalation threshold — tracked automatically, never auto-failed on absence of proof",
      });
    }
    checked++;
    const outcome = await processSolanaCandidate(event, deps);
    if (outcome === "confirmed") confirmed++;
    else if (outcome === "failed") failed++;
    else if (outcome === "pending") stillPending++;
    // outcome === "duplicate": a concurrent process already settled this row
    // — logged in logDuplicateCas already; never double-counted here.
  }

  return { recovered: recovered.length, checked, confirmed, failed, stillPending };
}

type CandidateOutcome = "confirmed" | "failed" | "pending" | "duplicate";

async function processSolanaCandidate(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
): Promise<CandidateOutcome> {
  const signature = event.txHash;
  if (!signature) return "pending"; // defensive; the candidate query already requires tx_hash IS NOT NULL.

  const statusLookup = await deps.getSignatureStatus(signature);

  if (statusLookup.outcome === "unavailable") {
    logUnavailable(event, "signature_status");
    return "pending";
  }

  if (statusLookup.outcome === "found") {
    if (isOnChainError(statusLookup.value.err)) {
      return finalizeMinedFailure(event, "getSignatureStatuses reported an on-chain error");
    }
    if (isLandedStatus(statusLookup.value.confirmationStatus)) {
      return handleLandedTransaction(event, deps);
    }
    await touchLastChecked(event.id);
    return "pending"; // e.g. "processed" only — not yet confirmed/finalized.
  }

  // statusLookup.outcome === "not_found" — cross-check getTransaction before
  // ANY expiry reasoning (R3: BOTH must miss).
  const txLookup = await deps.getFinalizedTransaction(signature);
  if (txLookup.outcome === "unavailable") {
    logUnavailable(event, "get_transaction");
    return "pending";
  }
  if (txLookup.outcome === "found") {
    return finalizeFromParsedTransaction(event, txLookup.value);
  }

  // BOTH missed — the only path that may terminalize on absence-of-proof,
  // and only when the blockhash is PROVABLY expired.
  return finalizeIfExpired(event, deps);
}

async function handleLandedTransaction(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
): Promise<CandidateOutcome> {
  const txLookup = await deps.getFinalizedTransaction(event.txHash!);
  if (txLookup.outcome === "unavailable") {
    logUnavailable(event, "get_transaction");
    return "pending";
  }
  if (txLookup.outcome === "not_found") {
    // Status said landed but the transaction body is unavailable — genuinely
    // undecodable; never guess a confirm without the body to decode from.
    logger.warn("solana_activity_repair.landed_status_no_transaction_body", { id: event.id });
    await touchLastChecked(event.id);
    return "pending";
  }
  return finalizeFromParsedTransaction(event, txLookup.value);
}

async function finalizeFromParsedTransaction(
  event: AgentActivityEvent,
  rawResult: unknown,
): Promise<CandidateOutcome> {
  const parsed = parseSolanaTransactionResult(rawResult);
  if (!parsed) {
    logger.warn("solana_activity_repair.unparseable_transaction", { id: event.id });
    await touchLastChecked(event.id);
    return "pending";
  }
  if (isOnChainError(parsed.err)) {
    return finalizeMinedFailure(event, "getTransaction reported meta.err");
  }
  const decoded = decodeSolanaSettlement({
    parsedTransaction: parsed,
    eventRole: event.eventRole,
    walletAddress: event.walletAddress,
    tokenInAddress: event.tokenInAddress,
    tokenOutAddress: event.tokenOutAddress,
    routeProvenance: event.routeProvenance,
  });
  if (!decoded) {
    logger.warn("solana_activity_repair.undecodable_success", {
      id: event.id,
      eventRole: event.eventRole,
      protocol: event.protocol,
      hint: "on-chain success but the registered decoder declined — leaving row pending",
    });
    await touchLastChecked(event.id);
    return "pending";
  }
  const outcome = await confirmActivityEvent(
    event.id,
    // Raw magnitudes are the decoder's proof; the exact-decimal siblings come
    // from the row's OWN persisted decimals (no extra lookup, no provider call)
    // so a confirmed row is readable, matching the EVM sweep's convention.
    withExactExecutedAmountHuman(decoded, {
      tokenInDecimals: event.tokenInDecimals,
      tokenOutDecimals: event.tokenOutDecimals,
    }),
  );
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
    // pre-049 row, per K1's NOT VALID migration decision) — never guess;
    // stays pending forever, exactly like any other ambiguous row.
    await touchLastChecked(event.id);
    return "pending";
  }
  const heightLookup = await deps.getCurrentBlockHeight();
  if (heightLookup.outcome !== "found") {
    logUnavailable(event, "block_height");
    return "pending";
  }
  if (heightLookup.value <= event.lastValidBlockHeight) {
    await touchLastChecked(event.id);
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

/**
 * Production deps: the single configured `cfg.solana.rpcUrl` (the SAME
 * trusted endpoint `prepareVersionedTx`/`getSolanaConnection` already use for
 * strictly MORE consequential operations — signing and broadcasting), health
 * -verified via the genesis-hash echo (`solana-rpc-safety.js`) ONCE per sweep
 * run and cached for every candidate this run processes (avoids one genesis
 * round-trip per RPC call). `null`/unhealthy genesis ⇒ every RPC dep in this
 * run reports `"unavailable"` — the sweep then leaves every candidate
 * pending, never guessing from an unverified endpoint.
 */
export function buildProductionSolanaRepairDeps(): SolanaActivitySweepDeps {
  let healthyRpcUrl: Promise<string | null> | null = null;
  const resolveHealthyRpcUrl = (): Promise<string | null> => {
    if (!healthyRpcUrl) {
      healthyRpcUrl = (async () => {
        const rpcUrl = loadConfig().solana.rpcUrl;
        return (await confirmSolanaMainnetGenesis(rpcUrl)) ? rpcUrl : null;
      })();
    }
    return healthyRpcUrl;
  };

  return {
    getSignatureStatus: async (signature) => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        const result = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
          [signature],
          { searchTransactionHistory: true },
        ]);
        const value = isRecord(result) ? result.value : undefined;
        const entry = Array.isArray(value) ? value[0] : undefined;
        if (entry === null || entry === undefined) return { outcome: "not_found" };
        if (!isRecord(entry)) return { outcome: "unavailable" };
        const confirmationStatus = typeof entry.confirmationStatus === "string" ? entry.confirmationStatus : null;
        return { outcome: "found", value: { err: entry.err ?? null, confirmationStatus } };
      } catch (err) {
        logger.debug("solana_activity_repair.signature_status_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },

    getFinalizedTransaction: async (signature) => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        const result = await solanaRpcCall(rpcUrl, "getTransaction", [
          signature,
          { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ]);
        if (result === null || result === undefined) return { outcome: "not_found" };
        return { outcome: "found", value: result };
      } catch (err) {
        logger.debug("solana_activity_repair.get_transaction_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },

    getCurrentBlockHeight: async () => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        // `commitment: "finalized"` (not the confirmation guide's general
        // "confirmed" polling suggestion): finalized height always lags
        // confirmed height by a slot or two, so this can only ever make
        // expiry HARDER to prove, never easier — the conservative choice for
        // an irreversible `definitively_failed` write.
        const result = await solanaRpcCall(rpcUrl, "getBlockHeight", [{ commitment: "finalized" }]);
        if (typeof result !== "number" || !Number.isFinite(result)) return { outcome: "unavailable" };
        return { outcome: "found", value: result };
      } catch (err) {
        logger.debug("solana_activity_repair.block_height_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
