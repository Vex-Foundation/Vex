/**
 * `agent_activity` BRIDGE order-status sweep (Phase-2 factory W4; plan
 * R12/B4/B6/C3 + dossier §2). W4 is the SOLE OWNER of every terminal bridge
 * transition (FIX-ROUND-1 architectural decision): the in-turn Khalani/Relay
 * poll reports provider-terminal statuses truthfully in its OUTPUT but NEVER
 * terminalizes a row — only this sweep may move a logical row to
 * confirmed/failed/refunded, and only after full R6 correlation + independent
 * evidence (see below).
 *
 * Companion to the Phase-1 `agent-activity-repair.ts` receipt sweep, NOT a
 * replacement. The two sweeps have DISJOINT candidate sets by construction:
 *
 *   - Phase-1 `repairPendingActivity` polls rows with `submit_attempted_at IS
 *     NOT NULL` (Vex-signed legs — swap legs AND bridge allowance/`bridge_deposit`
 *     legs, once staged). It confirms/fails those from an EVM receipt.
 *   - THIS sweep polls the LOGICAL `bridge_fill_expected` row, whose
 *     `submit_attempted_at` is ALWAYS NULL (it is never staged via
 *     `markActivityBroadcast` — its `tx_hash` is the solver-signed destination
 *     fill hash, set only at verified-confirm time). So the Phase-1 sweep can
 *     never pick up a logical row, and this sweep never touches a Vex-signed leg.
 *
 * WHY A SEPARATE SWEEP (dossier §2 "receipt-truth per side"): a bridge's
 * destination fill is SOLVER-signed and externally observed — its truth is the
 * PROVIDER order status (Khalani `GET /orders/by-id`, Relay `GET
 * /intents/status/v3`), polled by `provider_order_id`, not an EVM receipt for a
 * hash Vex broadcast. The Phase-1 `RepairDeps`/settlement-decoder contract
 * (single receipt → decoded amounts) does not fit; this sweep has its own deps.
 *
 * CANONICAL RELAY STATUS CONTRACT (Blocker 6): the destination fill collection
 * is `txHashes[]`; the origin deposit collection is `inTxHashes[]`; the route is
 * echoed as `originChainId`/`destinationChainId`. `destinationTxHashes[]` is a
 * TOLERATED legacy alias for the destination collection — read but never
 * required. Destination-hash normalization happens in ONE place
 * (`relayDestinationHashes`).
 *
 * NEVER AGE PENDING → FAILED (dossier §2 timeout policy): Khalani publishes no
 * SLA and no webhook; a stuck `published`/`refund_pending`/`delayed` stays
 * `pending` forever, re-checked next sweep. ONLY a terminal PROVIDER status
 * (Khalani filled/refunded/failed, Relay success/failure/refund) may terminalize
 * a row. Age is metadata only (feed "tracking delayed" UX), never a failure
 * trigger.
 *
 * R6 SETTLEMENT CORRELATION BEFORE ANY TERMINAL TRANSITION (Blocker 7): a
 * terminal provider status is checked against the STORED logical row BEFORE the
 * row is confirmed/failed/refunded. The sweep asserts every identity field the
 * provider payload actually CARRIES against the columns Vex actually STORED:
 * order id, quote/route ids, source/destination tokens, author (the depositor),
 * and the origin deposit hash — plus the route chain ids. Any carried-and-stored
 * field that disagrees yields `correlation_mismatch`: the row stays `pending` and
 * an anomaly is logged (never terminalize a mismatched order onto our row). This
 * runs for fills AND for failed/refunded outcomes. Fields the payload OMITS (a
 * keyless Relay status is thin) or that Vex never stored are NAMED-DEGRADED and
 * skipped — never silently "passed". In particular the destination RECIPIENT is
 * not stored on the logical row, so it is NEVER substituted with the source
 * wallet (that would mis-attribute a cross-family fill); its amount-decode
 * correlation is named-degraded instead.
 *
 * INDEPENDENT VERIFICATION BEFORE ANY CONFIRM (B4): a provider `filled`/`success`
 * is NOT trusted on its own. Before `confirmBridgeExpectedFill` the sweep checks:
 * the fill hash is present in the correct destination collection; the returned
 * chain ids match the stored route (a MISSING fill chain is NOT acceptable — the
 * fill must name its destination chain); and the fill is proven on-chain — an EVM
 * `eth_chainId` echo + a succeeded `getTransactionReceipt`, or a Solana
 * `getSignatureStatuses` with `err == null` and a `confirmed`/`finalized`
 * status. A `filled`/`success` WITHOUT a verifiable fill hash keeps the row
 * `pending` + logs an anomaly — a confirmation is NEVER fabricated (dossier §5
 * LOW_CONFIDENCE).
 *
 * ALL PROVIDER FILL HASHES ARE PRESERVED (B2/B8, Blocker 9): the FIRST verified
 * destination fill confirms the logical row; every ADDITIONAL verified fill hash
 * (multi-fill Relay orders return an array) is appended as a
 * `bridge_fill_observed` evidence row via `markBridgeLegObserved` (deduplicated
 * by hash) — the full-leg audit contract.
 *
 * REFUND EVIDENCE IS VERIFIED, THEN WRITTEN, THEN THE ROW IS TERMINALIZED
 * (Blocker 8): a refund tx hash is proven on-chain (like any observed leg) BEFORE
 * a confirmed refund-evidence row is written; the logical row is terminalized
 * `bridge_refunded` ONLY AFTER that evidence write succeeds. An unverifiable
 * refund tx (not mined yet) or a failed evidence write keeps the WHOLE row
 * `pending` for the next sweep — no terminalization, no permanent loss of the
 * refund hash (the provider keeps returning `refunded` + the hash). A terminal
 * refund that carries NO hash at all (keyless Relay — a named dossier gap) is
 * terminalized without an evidence row once route correlation passes.
 *
 * CONFIRM SIDE-EFFECT ORDERING + DURABILITY (Blocker 11, C3): on a VERIFIED
 * pending→confirmed the reveal-clear fires FIRST (in-memory, best-effort), THEN
 * additional fills are appended, THEN the balance-refresh job is enqueued — so an
 * enqueue failure never strands a cleared-vs-uncleared reveal, and the confirmed
 * row is left in a recoverable state. The confirmed-but-unenqueued crash window
 * is closed by `reconcileBalanceEnqueues`, which ALSO clears the reveal for any
 * confirmed relay row it re-enqueues (no arbitrary age cutoff — a bounded fair
 * queue). The enqueue is idempotent at the DATABASE level via a partial unique
 * index on `protocol_sync_runs (sync_job_id, execution_id)` (migration 046) +
 * `ON CONFLICT DO NOTHING`, so two concurrent sweeps can never duplicate a run.
 *
 * ERROR LOGGING: every provider/RPC error text routes through
 * `summarizeProtocolError(err).message` (the canonical scrub boundary), never a
 * bare message — a provider error can carry URLs, bodies, and auth headers.
 * Structured anomaly logs carry only field NAMES + ids, never raw provider values.
 *
 * TESTABILITY: `repairPendingBridges` is pure orchestration over an injected
 * `BridgeRepairDeps` port (mirrors the Phase-1 `RepairDeps` seam). The pure
 * status-mapping, correlation, fairness, and SSRF helpers are exported and
 * unit-pinned; the production wiring (`buildProductionBridgeRepairDeps`) — raw
 * scheduling SQL, provider clients, SSRF-controlled RPC verification, idempotent
 * enqueue, reveal clear — is exercised by the real-Postgres integration suite
 * (`integration/agent-scan/bridge-sweep.int.test.ts`). Bridge sweep reads use a
 * NARROW `BridgeSweepRow` read model (not the full `AgentActivityEvent`) so this
 * module never duplicates the repo's private `mapRow`— it selects only the
 * columns the sweep acts on.
 *
 * Internals split into siblings (Card C5, move-only, once this file crossed
 * the repo's 500-line cap — the RPC-safety extraction below predates this
 * split, from K3): `bridge-activity-repair-contracts.ts` (tunables, the
 * narrow `BridgeSweepRow` read model, provider payload shapes, the injected
 * `BridgeRepairDeps` port, `BridgeObservation`/`StoredBridgeCorrelation`),
 * `bridge-activity-repair-status-map.ts` (the pure Khalani/Relay status →
 * `BridgeObservation` mappers + R6 identity correlation),
 * `bridge-activity-repair-fairness.ts` (the pure fair-scheduling comparator),
 * `bridge-activity-repair-sweep.ts` (the pure `repairPendingBridges`
 * orchestration), `bridge-activity-repair-production-deps.ts`
 * (`buildProductionBridgeRepairDeps` — the raw SQL/provider-client wiring),
 * `bridge-activity-repair-verification.ts` (the B4 on-chain fill/refund
 * verifier). This file stays the public gate — every symbol below is a pure
 * re-export, no behavior change.
 */

import {
  BRIDGE_SWEEP_BATCH_LIMIT,
  KHALANI_EVIDENCE_SOURCE,
  RELAY_EVIDENCE_SOURCE,
  type BridgeObservation,
  type BridgeOrderIdRecoveryCandidate,
  type BridgeRepairDeps,
  type BridgeRepairSweepResult,
  type BridgeSweepRow,
  type ConfirmedBalanceRefreshCandidate,
  type FillVerification,
  type FillVerificationInput,
  type KhalaniOrderTx,
  type KhalaniOrderView,
  type RelayStatusView,
  type StoredBridgeCorrelation,
  type StoredBridgeRoute,
} from "./bridge-activity-repair-contracts.js";
import {
  mapKhalaniOrderOutcome,
  mapRelayStatusOutcome,
  relayDestinationHashes,
} from "./bridge-activity-repair-status-map.js";
import { repairPendingBridges } from "./bridge-activity-repair-sweep.js";
import {
  bridgeScheduleClock,
  compareBridgeFairness,
} from "./bridge-activity-repair-fairness.js";
import { buildProductionBridgeRepairDeps } from "./bridge-activity-repair-production-deps.js";
import {
  isSsrfSafeRpcUrl,
  isPrivateOrLoopbackHost,
  selectVerificationRpcUrls,
} from "./solana-rpc-safety.js";

// Re-exported unchanged (W5 extraction, design REVISION 1 R3): these lived in
// this file before `solana-rpc-safety.ts` lifted them out for reuse by the
// Solana activity sweep (`solana-activity-repair.ts`, K3). Kept as named
// exports here too so this module's existing import path/tests are untouched
// — a pure move, not a behavior change.
export { isSsrfSafeRpcUrl, isPrivateOrLoopbackHost, selectVerificationRpcUrls };

export {
  BRIDGE_SWEEP_BATCH_LIMIT,
  KHALANI_EVIDENCE_SOURCE,
  RELAY_EVIDENCE_SOURCE,
  type BridgeObservation,
  type BridgeOrderIdRecoveryCandidate,
  type BridgeRepairDeps,
  type BridgeRepairSweepResult,
  type BridgeSweepRow,
  type ConfirmedBalanceRefreshCandidate,
  type FillVerification,
  type FillVerificationInput,
  type KhalaniOrderTx,
  type KhalaniOrderView,
  type RelayStatusView,
  type StoredBridgeCorrelation,
  type StoredBridgeRoute,
};

export { mapKhalaniOrderOutcome, mapRelayStatusOutcome, relayDestinationHashes };

export { bridgeScheduleClock, compareBridgeFairness, repairPendingBridges };

export { buildProductionBridgeRepairDeps };
