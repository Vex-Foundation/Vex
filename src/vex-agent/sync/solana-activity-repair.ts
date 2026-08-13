/**
 * `agent_activity` SOLANA activity sweep - the pending-transaction resolver for
 * every locally-staged Solana row, and the Solana twin of
 * `agent-activity-repair.ts`.
 *
 * Sole owner of every `chain_family='solana'` LOCALLY-STAGED row's terminality
 * (Vex-signed Jupiter swap/lend/prediction legs AND Solana `bridge_deposit`
 * origin legs - the bridge order-status sweep, `bridge-activity-repair.ts`,
 * owns ONLY the logical `bridge_fill_expected` row, whose
 * `submit_attempted_at` is always NULL and is therefore never a candidate
 * here). Disjoint from the EVM sweep by construction - see
 * `listSolanaStagedPending` / `listPendingOlderThan`'s `chainFamily` parameter.
 *
 * THE TERMINALITY QUESTION PER ROW: did this signature land, and did it carry an
 * error? `err == null` at `confirmed`/`finalized` commitment → `confirmed`;
 * `err != null` → `definitively_failed`. That question is answered by ONE
 * batched `getSignatureStatuses` entry and nothing else - no protocol-aware
 * dispatch, no provider history lookup.
 *
 * EXECUTED AMOUNTS ARE A SECOND, SEPARATE QUESTION, owned by
 * `./solana-activity-repair/amount-decode-lane.js`: a landing row whose OWN
 * persisted record names its mints (a swap's settlement profile, a
 * lend/prediction row's declared token columns) is worth ONE bounded
 * `getTransaction`, out of which owner-and-mint-bounded SPL balance deltas may
 * prove its legs - both for a swap, per leg for the roles that legitimately move
 * one side. Proven → `confirmActivityEvent` with those amounts. Refused,
 * or nothing to decode → `confirmActivityEventStatusOnly` exactly as before, and
 * Agent Scan shows the quoted amount labelled "estimated" rather than dressing a
 * quote up as a settlement. Evidence never READ (RPC unavailable, fetch budget
 * spent) is not a refusal: the row stays pending rather than spending its
 * one-shot terminal write on amounts it could still have proven.
 *
 * PROCESSED IS NOT LANDED, IN BOTH DIRECTIONS: a `processed`-only (or unknown)
 * commitment leaves the row `pending` whether or not it carries an `err` - a
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
 * family) - nothing else calls it periodically, so this sweep's tick recovers
 * stale hashless EVM rows too; see that function's own doc
 * (`../db/repos/agent-activity/hashless-recovery.js`).
 *
 * NO GIVE-UP RAIL: ambiguous evidence (RPC unavailable, signature genuinely not
 * yet found, unhealthy RPC) NEVER terminalizes a row on its own - it stays
 * `pending`, re-checked on the next tick, with an operator-visible escalation
 * log once a row has been pending unusually long (`isSolanaSweepEscalated`).
 * The ONE way absence-of-proof may terminalize a row is the EXPIRY gate below.
 *
 * EXPIRY GATE (literal AND): `getSignatureStatuses`
 * (`searchTransactionHistory:true`) MISS, AND a `finalized` `getTransaction`
 * (`maxSupportedTransactionVersion:0`) ALSO MISS, both over a GENESIS-VERIFIED,
 * SSRF-safe healthy RPC (`solana-rpc-safety.js`), AND the row's OWN persisted
 * `last_valid_block_height` proves the current block height has passed it -
 * only THEN is `failure_code='solana_signature_expired'` written (safe: an
 * expired blockhash can never land). A row with no persisted evidence (a
 * grandfathered pre-049 row) can never be expired - it stays pending forever.
 *
 * MINED FAILURE CARRIES THE ERROR: a terminalized mined failure quotes the
 * chain's OWN `err` in `failure_reason`, serialized by
 * `solana-transaction/onchain-error-summary.js` (deterministic, 200-char
 * bounded). `failure_code` is `mined_revert`, matching the EVM sweep.
 *
 * DUPLICATE-CAS AWARENESS: the finalizers return `{applied, row}` - an
 * `applied:false` means a concurrent process (another sweep instance, or a
 * handler's own late finalize) already settled this row; logged and skipped,
 * never double-counted.
 *
 * TESTABILITY: `repairPendingSolanaActivity` is pure orchestration over an
 * injected `SolanaActivitySweepDeps` port - exactly the external reads this
 * sweep may perform; its PRODUCTION wiring lives in the sibling
 * `./solana-activity-repair-deps.js`. Every DB read/write is imported directly
 * and mocked via `vi.mock` in tests.
 */

import {
  listSolanaStagedPending,
  recoverStaleHashlessIntents,
  HASHLESS_INTENT_RECOVERY_LEASE_MS,
} from "@vex-agent/db/repos/agent-activity.js";

import {
  isSolanaSweepCandidateDue,
  SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT,
  SOLANA_SWEEP_BATCH_LIMIT,
} from "./solana-activity-repair/candidate-schedule.js";
import { resolveSolanaPendingRows } from "./solana-activity-repair/row-resolution.js";
import type { SolanaActivitySweepDeps, SolanaActivitySweepResult } from "./solana-activity-repair/sweep-port.js";

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

// -- The public surface, unchanged --------------------------------------
//
// Every name below used to be DEFINED here and is now re-exported from the
// module that owns it, so no import site changes - including the DYNAMIC
// `await import("./solana-activity-repair.js")` call sites in
// `worker.ts`/`index.ts` that no typecheck would catch.

export {
  isSolanaSweepCandidateDue,
  isSolanaSweepEscalated,
  SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT,
  SOLANA_SWEEP_BATCH_LIMIT,
  SOLANA_SWEEP_DUE_INTERVAL_MS,
  SOLANA_SWEEP_ESCALATION_AGE_MS,
} from "./solana-activity-repair/candidate-schedule.js";
export { resolveSolanaPendingRows } from "./solana-activity-repair/row-resolution.js";
export type {
  SolanaActivitySweepDeps,
  SolanaActivitySweepResult,
  SolanaBatchResolution,
  SolanaRpcLookup,
  SolanaSignatureStatusValue,
} from "./solana-activity-repair/sweep-port.js";

// `buildProductionSolanaRepairDeps` (the health-gated adapters over this
// port's external reads) lives in the sibling
// `./solana-activity-repair-deps.js` - a different reason to change
// (endpoints/transport/response shapes) from this file's policy.
export { buildProductionSolanaRepairDeps } from "./solana-activity-repair-deps.js";
