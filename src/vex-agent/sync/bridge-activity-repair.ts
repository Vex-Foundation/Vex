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
 * module never duplicates the repo's private `mapRow` — it selects only the
 * columns the sweep acts on.
 */

import {
  confirmBridgeExpectedFill,
  failActivityEvent,
  markBridgeLegObserved,
  attachProviderOrderId,
  type BridgeChainFamily,
  type CasResult,
  type MarkBridgeLegObservedResult,
  type AttachProviderOrderIdResult,
} from "@vex-agent/db/repos/agent-activity.js";
import { clearRelayRouteReveal } from "@vex-agent/tools/registry/relay-reveal.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

// ── Tunables ──────────────────────────────────────────────────────────────

/**
 * Bounded batch per queue per sweep run (Phase-1 C11 parity): the sweep does
 * serial provider + RPC calls inside the shared sync worker — an unbounded
 * backlog would starve balance/settlement sync sharing the same drain. Any
 * remainder is picked up on the next periodic tick.
 */
export const BRIDGE_SWEEP_BATCH_LIMIT = 25;

/** Provider evidence-source markers persisted on confirmed/observed bridge rows (R6 provenance). */
export const KHALANI_EVIDENCE_SOURCE = "khalani_order_status";
export const RELAY_EVIDENCE_SOURCE = "relay_intent_status";

/** Provider-native Solana chain ids (Khalani vs Relay diverge) — used only to infer a row's chain family for explorer-link resolution. */
const SOLANA_CHAIN_IDS: ReadonlySet<number> = new Set([20011000000, 792703809]);

/**
 * Solana mainnet-beta genesis hash — an immutable cluster identity constant. The
 * Solana analog of the EVM `eth_chainId` echo: before trusting a registry RPC to
 * report a signature status, the sweep confirms the endpoint actually serves
 * mainnet-beta, so a swapped/re-pointed endpoint cannot fake a confirmation.
 */
const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// ── Narrow read model (only the logical-row columns the sweep acts on) ──────

/** The subset of the logical `bridge_fill_expected` row the sweep reads. Keeps this module free of the repo's private `mapRow`. */
export interface BridgeSweepRow {
  readonly id: number;
  readonly protocolExecutionId: number;
  readonly protocol: string;
  readonly providerOrderId: string | null;
  readonly fromChainId: number | null;
  readonly toChainId: number | null;
  /** The logical row's own chain_family = the DESTINATION family (the fill executes on the destination chain). */
  readonly destChainFamily: BridgeChainFamily;
  /** Requested SOURCE token (R6 `from_token` correlation input). */
  readonly tokenInAddress: string | null;
  /** Requested DESTINATION token (R6 `to_token` correlation input). */
  readonly tokenOutAddress: string | null;
  /** The depositor / author — the source wallet Vex signed the deposit from (R6 `author` correlation). */
  readonly walletAddress: string;
  /** The sibling `bridge_deposit` leg's staged hash (R6 `deposit_hash` correlation), if any. */
  readonly depositTxHash: string | null;
  /** Quote id persisted in `route_provenance` at intent time (R6 `quote_id` correlation), if any. */
  readonly quoteId: string | null;
  /** Route id persisted in `route_provenance` at intent time (R6 `route_id` correlation), if any. */
  readonly routeId: string | null;
  readonly sessionId: string | null;
  readonly normalizedRoute: string | null;
  readonly lastAttemptedAt: string | null;
  readonly createdAt: string;
}

// ── Provider payload shapes the sweep reads (already client-validated) ──────

/** A single Khalani `transactions{deposit,fill,refund}` entry (subset the sweep reads). */
export interface KhalaniOrderTx {
  readonly txHash?: string;
  readonly chainId?: number;
  readonly amount?: string;
}

/** The Khalani order fields the sweep's status mapping + R6 correlation depend on (client-validated upstream). */
export interface KhalaniOrderView {
  readonly id?: string;
  readonly status: string;
  readonly fromChainId: number;
  readonly toChainId: number;
  readonly quoteId?: string;
  readonly routeId?: string;
  readonly fromToken?: string;
  readonly toToken?: string;
  /** The depositor address (R6 `author`). */
  readonly author?: string;
  /** Origin deposit hash echoed by the provider (R6 `deposit_hash`). */
  readonly depositTxHash?: string;
  readonly transactions: Readonly<Record<string, KhalaniOrderTx | undefined>>;
}

/**
 * The Relay `/intents/status/v3` fields the sweep's status mapping + R6
 * correlation depend on. Canonical: `txHashes[]` (destination), `inTxHashes[]`
 * (origin), `originChainId`/`destinationChainId` (route echo). `destinationTxHashes[]`
 * is a tolerated legacy alias for the destination collection.
 */
export interface RelayStatusView {
  readonly status: string;
  /** Canonical DESTINATION fill collection. */
  readonly txHashes?: readonly string[];
  /** Canonical ORIGIN deposit collection (R6 `deposit_hash`). */
  readonly inTxHashes?: readonly string[];
  /** Tolerated legacy alias for the destination collection — read, never required. */
  readonly destinationTxHashes?: readonly string[];
  /** Route echo (B4 route match input). Omitted on some payloads → named-degraded, defer to the RPC chain echo. */
  readonly originChainId?: number;
  readonly destinationChainId?: number;
}

// ── Deps (injected port — everything the pure orchestration cannot do itself) ─

/** A pending logical row awaiting recovery of its provider order id (crash after deposit broadcast, before attach — R5). */
export interface BridgeOrderIdRecoveryCandidate {
  readonly executionId: number;
  readonly protocol: string;
  readonly walletAddress: string;
  readonly depositTxHash: string;
  readonly fromChainId: number;
  readonly toChainId: number;
}

/** A confirmed logical bridge row still needing its balance-refresh job enqueued (C3 recovery). */
export interface ConfirmedBalanceRefreshCandidate {
  readonly executionId: number;
  readonly protocol: string;
  /** Session + route are carried so the recovery path can ALSO clear a stranded relay reveal (Blocker 11). */
  readonly sessionId: string | null;
  readonly normalizedRoute: string | null;
}

/** Input to the B4 independent on-chain leg verification (a fill OR a refund — same receipt/signature proof). */
export interface FillVerificationInput {
  readonly txHash: string;
  /** The chain the leg MUST have executed on (fill → stored destination; refund → stored origin). */
  readonly expectedChainId: number;
  readonly chainFamily: BridgeChainFamily;
  /** The owning protocol — selects the RIGHT provider registry for RPC selection (relay `/chains` vs khalani `/v1/chains`). */
  readonly protocol: string;
  /** Stored destination token — executed amounts are trusted ONLY if transfer evidence decodes against it. */
  readonly tokenOutAddress: string | null;
  /**
   * Stored recipient (self-custodial destination address). NULL when Vex never
   * stored a recipient on the logical row — the amount-decode correlation is then
   * named-degraded; the source wallet is NEVER substituted (Blocker 7).
   */
  readonly recipient: string | null;
}

/** Result of the B4 verification. Executed amounts are present ONLY when decoded against the stored token + recipient (Q2). */
export interface FillVerification {
  readonly verified: boolean;
  readonly reason?: string;
  readonly executedAmountInHuman?: string;
  readonly executedAmountInRaw?: string;
  readonly executedAmountOutHuman?: string;
  readonly executedAmountOutRaw?: string;
}

export interface BridgeRepairDeps {
  // ── Fair-scheduled candidate reads (bounded) ──
  /** Pending logical rows with a `provider_order_id`, oldest-touched first (COALESCE(last_attempted_at, created_at) ASC), bounded. */
  listSweepCandidates(limit: number): Promise<BridgeSweepRow[]>;
  /** Pending Khalani logical rows with a staged deposit hash but NULL `provider_order_id` (R5 recovery queue), bounded, same fairness. */
  listOrderIdRecoveryCandidates(limit: number): Promise<BridgeOrderIdRecoveryCandidate[]>;
  /** Confirmed logical bridge rows whose execution still has no balance-refresh run (C3 confirm→enqueue crash recovery), bounded, fair-ordered. */
  listConfirmedNeedingBalanceRefresh(limit: number): Promise<ConfirmedBalanceRefreshCandidate[]>;

  // ── Scheduling writes ──
  /** `last_attempted_at = NOW()` on the logical row — EVERY attempt, including transport failures (B6). */
  touchAttempt(executionId: number): Promise<void>;
  /** `last_checked_at = NOW()` + `provider_status` on the logical row — ONLY after a successful provider observation (B6). */
  touchChecked(executionId: number, providerStatus: string): Promise<void>;

  // ── Provider status (null = transport failure; the row stays pending) ──
  fetchKhalaniOrder(orderId: string): Promise<KhalaniOrderView | null>;
  fetchRelayStatus(requestId: string): Promise<RelayStatusView | null>;

  // ── Null-order-id recovery (lookup-only; never re-signs/re-broadcasts) ──
  recoverKhalaniOrderId(candidate: BridgeOrderIdRecoveryCandidate): Promise<string | null>;

  // ── B4 independent on-chain verification (SSRF-controlled RPC selection lives here) ──
  verifyFill(input: FillVerificationInput): Promise<FillVerification>;

  // ── Repo CAS writes (wrap W-SPINE primitives; injected so the orchestration stays pure) ──
  confirmExpectedFill(input: {
    executionId: number;
    txHash: string;
    evidenceSource: string;
    providerStatus: string;
    executedAmountInHuman?: string;
    executedAmountInRaw?: string;
    executedAmountOutHuman?: string;
    executedAmountOutRaw?: string;
  }): Promise<CasResult>;
  failLogical(
    logicalRowId: number,
    failureCode: "bridge_failed" | "bridge_refunded",
    failureReason: string,
  ): Promise<CasResult>;
  /** Append an EXTRA verified destination fill (multi-fill orders, Blocker 9). Dedup by hash. */
  appendFillObserved(input: {
    executionId: number;
    protocol: string;
    chainId: number;
    chainFamily: BridgeChainFamily;
    txHash: string;
    evidenceSource: string;
    providerStatus: string;
  }): Promise<MarkBridgeLegObservedResult>;
  /** Append origin-side refund evidence (written CONFIRMED — the caller MUST have verified it first, Blocker 8). Dedup by hash. */
  appendRefundEvidence(input: {
    executionId: number;
    protocol: string;
    chainId: number;
    chainFamily: BridgeChainFamily;
    txHash: string;
    evidenceSource: string;
    providerStatus: string;
  }): Promise<MarkBridgeLegObservedResult>;
  attachOrderId(input: { executionId: number; providerOrderId: string }): Promise<AttachProviderOrderIdResult>;

  // ── Side effects on verified confirm ──
  /** Idempotent by execution id (DB-enforced, migration 046) — safe to call for the same execution repeatedly (C3 recovery relies on this). */
  enqueueBalanceRefresh(input: { namespace: string; executionId: number }): Promise<void>;
  /** Best-effort, same-process only (an in-memory Map). Called ONLY on a VERIFIED pending→confirmed of a relay-originated bridge (B5). */
  clearRelayReveal(sessionId: string, routeKey: string): void;
}

export interface BridgeRepairSweepResult {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly refunded: number;
  readonly recovered: number;
  readonly balanceReconciled: number;
  readonly stillPending: number;
}

// ── Pure status mapping (dossier §2 table) ──────────────────────────────────

/**
 * The mapped outcome of a provider observation. Terminal outcomes may terminalize
 * the logical row; `pending`/`filled_no_hash`/`chain_mismatch`/`correlation_mismatch`
 * never do (the last three are anomalies that keep the row pending + log).
 */
export type BridgeObservation =
  | { readonly kind: "pending"; readonly providerStatus: string }
  | {
      readonly kind: "confirmable";
      readonly providerStatus: string;
      /** ALL destination fill hashes (ordered) — the first verified one confirms, the rest become observed rows (Blocker 9). */
      readonly fillTxHashes: readonly string[];
      readonly destChainId: number;
      readonly destChainFamily: BridgeChainFamily;
    }
  // Provider says filled/success but no destination fill hash is present — dossier
  // §5: keep pending + anomaly, NEVER fabricate a confirmation.
  | { readonly kind: "filled_no_hash"; readonly providerStatus: string }
  // Provider's returned chain ids do not match the stored route (or a fill omits
  // its destination chain) — B4 anomaly.
  | { readonly kind: "chain_mismatch"; readonly providerStatus: string }
  // A carried-and-stored R6 identity field disagrees with the stored row (Blocker
  // 7) — never terminalize a mismatched order onto our row.
  | { readonly kind: "correlation_mismatch"; readonly providerStatus: string; readonly field: string }
  | {
      readonly kind: "refunded";
      readonly providerStatus: string;
      readonly refundTxHash: string | null;
      readonly refundChainId: number;
      readonly refundChainFamily: BridgeChainFamily;
    }
  | { readonly kind: "failed"; readonly providerStatus: string };

/** The stored route an observation is checked against (from the logical row). */
export interface StoredBridgeRoute {
  readonly fromChainId: number;
  readonly fromChainFamily: BridgeChainFamily;
  readonly toChainId: number;
  readonly toChainFamily: BridgeChainFamily;
}

/**
 * The full stored identity a terminal provider observation is correlated against
 * (R6). `route` is the chain endpoints; the remaining fields are the columns Vex
 * persisted at intent time. A field left `null` was never stored — its
 * correlation is NAMED-DEGRADED (skipped), never silently passed.
 */
export interface StoredBridgeCorrelation {
  readonly route: StoredBridgeRoute;
  readonly providerOrderId: string | null;
  readonly tokenInAddress: string | null;
  readonly tokenOutAddress: string | null;
  readonly author: string;
  readonly depositTxHash: string | null;
  readonly quoteId: string | null;
  readonly routeId: string | null;
}

const KHALANI_PENDING: ReadonlySet<string> = new Set(["created", "deposited", "published", "refund_pending"]);

function readTx(
  transactions: Readonly<Record<string, KhalaniOrderTx | undefined>>,
  key: string,
): KhalaniOrderTx | undefined {
  const tx = transactions[key];
  return tx && typeof tx === "object" ? tx : undefined;
}

/** Family-aware identity equality: EVM addresses/hashes are case-insensitive, Solana signatures/mints are case-sensitive base58. */
function idEquals(family: BridgeChainFamily, a: string, b: string): boolean {
  const na = family === "eip155" ? a.trim().toLowerCase() : a.trim();
  const nb = family === "eip155" ? b.trim().toLowerCase() : b.trim();
  return na.length > 0 && na === nb;
}

/**
 * R6 identity correlation shared by both providers' terminal paths. Returns the
 * NAME of the first carried-and-stored field that disagrees, or `null` when every
 * asserted field matches. ONLY fields the payload actually carries AND Vex stored
 * are asserted; anything else is named-degraded (skipped). Route CHAINS are
 * handled by the caller (they map to `chain_mismatch`, a distinct B4 anomaly).
 * The destination RECIPIENT is deliberately NOT asserted — it is not stored, so
 * substituting the source wallet would be wrong (Blocker 7).
 */
function correlateKhalaniIdentity(order: KhalaniOrderView, c: StoredBridgeCorrelation): string | null {
  const originFamily = c.route.fromChainFamily;
  const destFamily = c.route.toChainFamily;
  if (c.providerOrderId && order.id && order.id !== c.providerOrderId) return "order_id";
  if (order.author && !idEquals(originFamily, order.author, c.author)) return "author";
  if (c.depositTxHash && order.depositTxHash && !idEquals(originFamily, order.depositTxHash, c.depositTxHash)) {
    return "deposit_hash";
  }
  if (c.tokenInAddress && order.fromToken && !idEquals(originFamily, order.fromToken, c.tokenInAddress)) {
    return "from_token";
  }
  if (c.tokenOutAddress && order.toToken && !idEquals(destFamily, order.toToken, c.tokenOutAddress)) {
    return "to_token";
  }
  if (c.quoteId && order.quoteId && order.quoteId !== c.quoteId) return "quote_id";
  if (c.routeId && order.routeId && order.routeId !== c.routeId) return "route_id";
  return null;
}

/**
 * Map a Khalani order onto a `BridgeObservation` (dossier §2). Pure. Unknown
 * statuses map to `pending` (never terminalize on an unrecognized status).
 * Terminal statuses (filled/refunded/failed) are first correlated against the
 * stored row (R6) — a route-chain mismatch → `chain_mismatch`, any other identity
 * mismatch → `correlation_mismatch` — BEFORE the on-chain verification runs.
 */
export function mapKhalaniOrderOutcome(order: KhalaniOrderView, c: StoredBridgeCorrelation): BridgeObservation {
  const route = c.route;
  const providerStatus = order.status;
  if (KHALANI_PENDING.has(order.status)) return { kind: "pending", providerStatus };

  const isTerminal = order.status === "filled" || order.status === "refunded" || order.status === "failed";
  if (isTerminal) {
    const chainsMatch = order.fromChainId === route.fromChainId && order.toChainId === route.toChainId;
    if (!chainsMatch) return { kind: "chain_mismatch", providerStatus };
    const mismatch = correlateKhalaniIdentity(order, c);
    if (mismatch) return { kind: "correlation_mismatch", providerStatus, field: mismatch };
  }

  if (order.status === "filled") {
    const fill = readTx(order.transactions, "fill");
    if (!fill?.txHash) return { kind: "filled_no_hash", providerStatus };
    // B4: a fill MUST name its destination chain, and it must be the stored one.
    // A missing fill chain is NOT acceptable for confirm (Blocker 7).
    if (fill.chainId === undefined || fill.chainId !== route.toChainId) {
      return { kind: "chain_mismatch", providerStatus };
    }
    return {
      kind: "confirmable",
      providerStatus,
      fillTxHashes: [fill.txHash],
      destChainId: route.toChainId,
      destChainFamily: route.toChainFamily,
    };
  }

  if (order.status === "refunded") {
    const refund = readTx(order.transactions, "refund");
    return {
      kind: "refunded",
      providerStatus,
      refundTxHash: refund?.txHash ?? null,
      refundChainId: refund?.chainId ?? route.fromChainId,
      refundChainFamily: route.fromChainFamily,
    };
  }

  if (order.status === "failed") return { kind: "failed", providerStatus };

  // Any unrecognized status: stay pending (never terminalize on the unknown).
  return { kind: "pending", providerStatus };
}

const RELAY_PENDING: ReadonlySet<string> = new Set(["waiting", "depositing", "pending", "submitted", "delayed"]);

/** The Relay DESTINATION fill collection, normalized in ONE place: `txHashes[]` first, tolerated legacy `destinationTxHashes[]` fallback. */
export function relayDestinationHashes(status: RelayStatusView): readonly string[] {
  const canonical = status.txHashes;
  if (canonical && canonical.length > 0) return canonical;
  return status.destinationTxHashes ?? [];
}

/**
 * R6 identity correlation for Relay's thin keyless status/v3. Only the origin
 * deposit hash (`inTxHashes[]`) is carried against a stored value — the stored
 * deposit hash must appear in the origin collection. Tokens/author/quote/route
 * ids and the recipient are NOT carried by keyless status/v3 → named-degraded
 * (dossier gap; `/requests/v3` + an API key would carry them). Route chains are
 * handled by the caller.
 */
function correlateRelayIdentity(status: RelayStatusView, c: StoredBridgeCorrelation): string | null {
  const origin = status.inTxHashes;
  if (c.depositTxHash && origin && origin.length > 0) {
    const present = origin.some((h) => typeof h === "string" && idEquals(c.route.fromChainFamily, h, c.depositTxHash!));
    if (!present) return "deposit_hash";
  }
  return null;
}

/**
 * Map a Relay `/intents/status/v3` payload onto a `BridgeObservation` (dossier
 * §2). Pure. Destination hashes are read from `txHashes[]` (tolerating legacy
 * `destinationTxHashes[]`); origin `inTxHashes[]` feeds the R6 deposit
 * correlation; `originChainId`/`destinationChainId` (when present) are the B4
 * route match — when the payload OMITS them the chain check is named-degraded and
 * deferred to the RPC `eth_chainId` echo in `verifyFill`. Keyless Relay refunds
 * carry no reliable refund-hash field (dossier §2/§5 named gap) — the logical row
 * is still terminalized `bridge_refunded`, just without a refund evidence row.
 */
export function mapRelayStatusOutcome(status: RelayStatusView, c: StoredBridgeCorrelation): BridgeObservation {
  const route = c.route;
  const providerStatus = status.status;
  if (RELAY_PENDING.has(status.status)) return { kind: "pending", providerStatus };

  const isTerminal = status.status === "success" || status.status === "refund" || status.status === "failure";
  if (isTerminal) {
    // Route echo present → assert it; absent → named-degraded (RPC echo is the backstop).
    if (status.originChainId !== undefined && status.originChainId !== route.fromChainId) {
      return { kind: "chain_mismatch", providerStatus };
    }
    if (status.destinationChainId !== undefined && status.destinationChainId !== route.toChainId) {
      return { kind: "chain_mismatch", providerStatus };
    }
    const mismatch = correlateRelayIdentity(status, c);
    if (mismatch) return { kind: "correlation_mismatch", providerStatus, field: mismatch };
  }

  if (status.status === "success") {
    const hashes = relayDestinationHashes(status).filter((h) => typeof h === "string" && h.trim().length > 0);
    if (hashes.length === 0) return { kind: "filled_no_hash", providerStatus };
    return {
      kind: "confirmable",
      providerStatus,
      fillTxHashes: hashes,
      destChainId: route.toChainId,
      destChainFamily: route.toChainFamily,
    };
  }

  if (status.status === "refund") {
    return {
      kind: "refunded",
      providerStatus,
      // Keyless Relay exposes no reliable refund-hash field (named gap) — terminalize without evidence.
      refundTxHash: null,
      refundChainId: route.fromChainId,
      refundChainFamily: route.fromChainFamily,
    };
  }

  if (status.status === "failure") return { kind: "failed", providerStatus };

  return { kind: "pending", providerStatus };
}

// ── Pure fair scheduling (mirrors the production `COALESCE(last_attempted_at, created_at) ASC`) ─

/** The row's fair-scheduling clock: last attempt if it was ever attempted, else creation time (B6). */
export function bridgeScheduleClock(row: Pick<BridgeSweepRow, "lastAttemptedAt" | "createdAt">): number {
  const basis = row.lastAttemptedAt ?? row.createdAt;
  const ms = Date.parse(basis);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Least-recently-touched first, ties broken by id for determinism. A
 * never-attempted row (`lastAttemptedAt` NULL) uses its `createdAt`, so an old
 * un-attempted row is served before a recently-attempted one — the starvation
 * guarantee. Mirrors the production SQL ordering exactly, and is applied
 * defensively in the orchestration so a mis-ordered dep still sweeps fairly.
 */
export function compareBridgeFairness(a: BridgeSweepRow, b: BridgeSweepRow): number {
  const clockDelta = bridgeScheduleClock(a) - bridgeScheduleClock(b);
  return clockDelta !== 0 ? clockDelta : a.id - b.id;
}

// ── SSRF-controlled RPC selection (B4) — pure, unit-pinned ──────────────────

/**
 * True iff `rawUrl` is a public HTTPS endpoint safe to use for provider-registry
 * RPC verification. Rejects (fail-closed): non-HTTPS schemes, credentials in the
 * URL, and loopback / private / link-local / unique-local / unspecified hosts
 * (the SSRF surface — a provider registry is untrusted input). Curated/local RPCs
 * bypass this (they are trusted), so this guards ONLY the provider-registry
 * fallback.
 *
 * NAMED LIMITATION (Blocker 10): this check is SYNTACTIC. It does NOT resolve DNS
 * and does NOT re-validate on HTTP redirects — a public-looking DNS name that
 * resolves to a private address (DNS rebinding), or a 3xx that re-points at a
 * private host, is NOT caught here. Two compensating controls close the gap: (a)
 * every verification fetch pins `redirect: "error"`/`fetchOptions.redirect:"error"`
 * so a redirect to a private host is refused, not followed; and (b) the
 * `eth_chainId` (EVM) / genesis-hash (Solana) echo means a re-pointed endpoint
 * cannot fake a confirmation for the expected chain.
 */
export function isSsrfSafeRpcUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  const host = url.hostname.toLowerCase();
  if (host.length === 0) return false;
  return !isPrivateOrLoopbackHost(host);
}

/**
 * Classify a hostname/IP literal as private/loopback/link-local (blocked) vs
 * public (allowed). Pure, NO DNS resolution (see `isSsrfSafeRpcUrl`'s named
 * limitation): an IP literal is classified exactly; a DNS name is accepted on its
 * face and defended downstream by redirect-off fetches + the chain-id echo.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  // Strip an IPv6 literal's brackets if a caller passed them through.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(h);
  if (ipv4) return isPrivateIpv4(ipv4);

  if (h.includes(":")) return isPrivateIpv6(h);

  // A public DNS name (not an IP literal) — allowed on its face. No resolution is
  // performed here; DNS-rebinding to a private address is out of scope for this
  // syntactic check and is compensated by redirect-off fetches + the chain echo.
  return false;
}

function parseIpv4(host: string): readonly number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // unspecified / this-network
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — classify the embedded v4.
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  // WHATWG URL NORMALIZES mapped addresses to the HEX form before we ever see
  // them (`[::ffff:127.0.0.1]` → hostname `[::ffff:7f00:1]`), so the dotted
  // regex above never fires for URL-sourced hosts — decode the embedded v4
  // from the last two 16-bit groups.
  const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  // Any other ::ffff:-prefixed shape (or the deprecated ::ffff:0:a.b.c.d SIIT
  // form) — fail closed rather than risk a mis-parse reaching a local target.
  if (h.startsWith("::ffff:")) return true;
  return false;
}

/**
 * Choose the ordered RPC endpoints to verify a leg on a chain: curated/local
 * registry URLs FIRST (trusted, never SSRF-filtered), then provider-registry URLs
 * that pass {@link isSsrfSafeRpcUrl}. De-duplicated, order preserved. An empty
 * result means "no safe RPC" — the verifier reports unverifiable and the row
 * stays pending (fail-closed).
 */
export function selectVerificationRpcUrls(input: {
  readonly curated: readonly string[];
  readonly providerRegistry: readonly string[];
}): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  for (const url of input.curated) push(url);
  for (const url of input.providerRegistry) if (isSsrfSafeRpcUrl(url)) push(url);
  return ordered;
}

// ── Orchestration (pure over the injected deps) ─────────────────────────────

interface MutableSweepCounters {
  confirmed: number;
  failed: number;
  refunded: number;
  recovered: number;
  balanceReconciled: number;
  stillPending: number;
}

export async function repairPendingBridges(deps: BridgeRepairDeps): Promise<BridgeRepairSweepResult> {
  const counters: MutableSweepCounters = {
    confirmed: 0,
    failed: 0,
    refunded: 0,
    recovered: 0,
    balanceReconciled: 0,
    stillPending: 0,
  };

  const candidates = (await deps.listSweepCandidates(BRIDGE_SWEEP_BATCH_LIMIT)).slice().sort(compareBridgeFairness);
  for (const logical of candidates) {
    await sweepLogicalRow(logical, deps, counters);
  }

  await recoverMissingOrderIds(deps, counters);
  await reconcileBalanceEnqueues(deps, counters);

  return {
    checked: candidates.length,
    confirmed: counters.confirmed,
    failed: counters.failed,
    refunded: counters.refunded,
    recovered: counters.recovered,
    balanceReconciled: counters.balanceReconciled,
    stillPending: counters.stillPending,
  };
}

async function sweepLogicalRow(
  logical: BridgeSweepRow,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;
  const orderId = logical.providerOrderId;
  if (!orderId) {
    // Defensive: the sweep query filters to non-null order ids; a null here means
    // a racing recovery — leave it for the recovery queue.
    counters.stillPending++;
    return;
  }

  // B6: every attempt advances the fair-scheduling clock, BEFORE the provider call,
  // so a persistently-failing row yields its slot even when the fetch throws.
  await deps.touchAttempt(executionId);

  const correlation = readStoredCorrelation(logical);
  if (!correlation) {
    logger.warn("bridge.repair.logical_missing_route", { executionId });
    counters.stillPending++;
    return;
  }

  const observation = await observeProvider(logical, orderId, correlation, deps);
  if (!observation) {
    // Transport failure — attempt already recorded, no observation, stays pending.
    counters.stillPending++;
    return;
  }

  // B6: a SUCCESSFUL provider observation advances `last_checked_at` + records the
  // last provider status for the feed (even when non-terminal).
  await deps.touchChecked(executionId, observation.providerStatus);
  await applyObservation(logical, observation, deps, counters);
}

/** Fetch + map the provider status for the logical row. `null` on transport failure only. */
async function observeProvider(
  logical: BridgeSweepRow,
  orderId: string,
  correlation: StoredBridgeCorrelation,
  deps: BridgeRepairDeps,
): Promise<BridgeObservation | null> {
  if (logical.protocol === "khalani") {
    const order = await deps.fetchKhalaniOrder(orderId);
    return order ? mapKhalaniOrderOutcome(order, correlation) : null;
  }
  if (logical.protocol === "relay") {
    const status = await deps.fetchRelayStatus(orderId);
    return status ? mapRelayStatusOutcome(status, correlation) : null;
  }
  logger.warn("bridge.repair.unknown_protocol", {
    executionId: logical.protocolExecutionId,
    protocol: logical.protocol,
  });
  return null;
}

async function applyObservation(
  logical: BridgeSweepRow,
  observation: BridgeObservation,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;
  switch (observation.kind) {
    case "pending":
      counters.stillPending++;
      return;

    case "filled_no_hash":
      // dossier §5: provider claims filled/success but produced no fill hash — the
      // one shape we must NEVER convert to a confirmation. Stay pending + anomaly.
      logger.warn("bridge.repair.filled_without_hash", {
        executionId,
        protocol: logical.protocol,
        providerStatus: observation.providerStatus,
      });
      counters.stillPending++;
      return;

    case "chain_mismatch":
      logger.warn("bridge.repair.chain_id_mismatch", {
        executionId,
        protocol: logical.protocol,
        providerStatus: observation.providerStatus,
      });
      counters.stillPending++;
      return;

    case "correlation_mismatch":
      // R6 anomaly (Blocker 7): a carried-and-stored identity field disagrees. Log
      // the field NAME only (never raw provider values) and stay pending — we do
      // NOT terminalize a mismatched order onto our row.
      logger.warn("bridge.repair.correlation_mismatch", {
        executionId,
        protocol: logical.protocol,
        providerStatus: observation.providerStatus,
        field: observation.field,
      });
      counters.stillPending++;
      return;

    case "confirmable":
      await confirmVerifiedFill(logical, observation, deps, counters);
      return;

    case "refunded":
      await terminalizeRefund(logical, observation, deps, counters);
      return;

    case "failed": {
      const outcome = await deps.failLogical(
        logical.id,
        "bridge_failed",
        `provider-terminal failure (${observation.providerStatus})`,
      );
      if (outcome.applied) counters.failed++;
      else logDuplicateCas(executionId, "fail", outcome);
      return;
    }
  }
}

async function confirmVerifiedFill(
  logical: BridgeSweepRow,
  observation: Extract<BridgeObservation, { kind: "confirmable" }>,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;
  const [primaryHash, ...additionalHashes] = observation.fillTxHashes;
  if (!primaryHash) {
    // Defensive: the mapper never emits `confirmable` with an empty list.
    counters.stillPending++;
    return;
  }

  // B4: independent on-chain proof BEFORE any confirm. A failed check keeps the
  // row pending — the provider's word alone is never enough. The recipient is
  // NEVER substituted with the source wallet (Blocker 7): it is passed as stored
  // (null when unstored → amount-decode named-degraded).
  const verification = await deps.verifyFill({
    protocol: logical.protocol,
    txHash: primaryHash,
    expectedChainId: observation.destChainId,
    chainFamily: observation.destChainFamily,
    tokenOutAddress: logical.tokenOutAddress,
    recipient: null,
  });
  if (!verification.verified) {
    logger.warn("bridge.repair.fill_unverified", {
      executionId,
      protocol: logical.protocol,
      providerStatus: observation.providerStatus,
      reason: verification.reason ?? "verification_failed",
    });
    counters.stillPending++;
    return;
  }

  const evidenceSource = logical.protocol === "relay" ? RELAY_EVIDENCE_SOURCE : KHALANI_EVIDENCE_SOURCE;
  const outcome = await deps.confirmExpectedFill({
    executionId,
    txHash: primaryHash,
    evidenceSource,
    providerStatus: observation.providerStatus,
    // Q2/B4: executed_* is set ONLY when the verifier decoded it against the stored
    // token + recipient; otherwise it stays NULL and the quoted amounts remain estimates.
    executedAmountInHuman: verification.executedAmountInHuman,
    executedAmountInRaw: verification.executedAmountInRaw,
    executedAmountOutHuman: verification.executedAmountOutHuman,
    executedAmountOutRaw: verification.executedAmountOutRaw,
  });

  if (!outcome.applied) {
    // A concurrent process (another sweep instance) already confirmed it.
    logDuplicateCas(executionId, "confirm", outcome);
    return;
  }

  counters.confirmed++;

  // C3 ORDERING (Blocker 11): clear the reveal FIRST (in-memory, best-effort) so a
  // later enqueue failure never strands a still-revealed confirmed route; the
  // recovery path re-clears it too.
  if (logical.protocol === "relay" && logical.sessionId && logical.normalizedRoute) {
    deps.clearRelayReveal(logical.sessionId, logical.normalizedRoute);
  }

  // B2/B8 (Blocker 9): every ADDITIONAL provider fill hash becomes a verified
  // `bridge_fill_observed` audit row (dedup by hash). An append failure here is
  // audit-only — it never blocks the confirm or the enqueue.
  for (const extraHash of additionalHashes) {
    const extraVerification = await deps.verifyFill({
      protocol: logical.protocol,
      txHash: extraHash,
      expectedChainId: observation.destChainId,
      chainFamily: observation.destChainFamily,
      tokenOutAddress: logical.tokenOutAddress,
      recipient: null,
    });
    if (!extraVerification.verified) {
      logger.warn("bridge.repair.extra_fill_unverified", {
        executionId,
        protocol: logical.protocol,
        reason: extraVerification.reason ?? "verification_failed",
      });
      continue;
    }
    try {
      await deps.appendFillObserved({
        executionId,
        protocol: logical.protocol,
        chainId: observation.destChainId,
        chainFamily: observation.destChainFamily,
        txHash: extraHash,
        evidenceSource,
        providerStatus: observation.providerStatus,
      });
    } catch (err) {
      logger.warn("bridge.repair.extra_fill_append_failed", {
        executionId,
        error: summarizeProtocolError(err).message,
      });
    }
  }

  // C3 (Blocker 11): enqueue LAST, and a failure here leaves a RECOVERABLE state —
  // the row is already confirmed and the reveal already cleared, so
  // reconcileBalanceEnqueues re-enqueues it next sweep. Swallow (scrubbed) rather
  // than abort the whole batch on one bad enqueue.
  try {
    await deps.enqueueBalanceRefresh({ namespace: logical.protocol, executionId });
  } catch (err) {
    logger.warn("bridge.repair.enqueue_failed", {
      executionId,
      error: summarizeProtocolError(err).message,
    });
  }
}

async function terminalizeRefund(
  logical: BridgeSweepRow,
  observation: Extract<BridgeObservation, { kind: "refunded" }>,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;

  if (observation.refundTxHash) {
    // B4 (Blocker 8): verify the refund receipt/signature BEFORE writing a
    // confirmed evidence row. An unverifiable refund (not mined yet / reverted)
    // keeps the WHOLE row pending — no terminalization, retried next sweep (the
    // provider keeps returning refunded + the hash; no permanent loss).
    const verification = await deps.verifyFill({
      protocol: logical.protocol,
      txHash: observation.refundTxHash,
      expectedChainId: observation.refundChainId,
      chainFamily: observation.refundChainFamily,
      tokenOutAddress: null,
      recipient: null,
    });
    if (!verification.verified) {
      logger.warn("bridge.repair.refund_unverified", {
        executionId,
        protocol: logical.protocol,
        providerStatus: observation.providerStatus,
        reason: verification.reason ?? "verification_failed",
      });
      counters.stillPending++;
      return;
    }

    // Evidence write must SUCCEED before we terminalize (Blocker 8). A write
    // failure keeps everything pending for the next sweep (dedup makes the retry a
    // harmless no-op if the row did land).
    try {
      await deps.appendRefundEvidence({
        executionId,
        protocol: logical.protocol,
        chainId: observation.refundChainId,
        chainFamily: observation.refundChainFamily,
        txHash: observation.refundTxHash,
        evidenceSource: logical.protocol === "relay" ? RELAY_EVIDENCE_SOURCE : KHALANI_EVIDENCE_SOURCE,
        providerStatus: observation.providerStatus,
      });
    } catch (err) {
      logger.warn("bridge.repair.refund_evidence_failed", {
        executionId,
        error: summarizeProtocolError(err).message,
      });
      counters.stillPending++;
      return;
    }
  }

  // refundTxHash present + verified + evidence written, OR the named-gap case
  // (no hash, keyless Relay) with route correlation already passed — terminalize.
  const outcome = await deps.failLogical(
    logical.id,
    "bridge_refunded",
    `provider refund — funds returned to refundTo (${observation.providerStatus})`,
  );
  if (outcome.applied) {
    counters.failed++;
    counters.refunded++;
  } else {
    logDuplicateCas(executionId, "fail", outcome);
  }
}

async function recoverMissingOrderIds(deps: BridgeRepairDeps, counters: MutableSweepCounters): Promise<void> {
  const candidates = await deps.listOrderIdRecoveryCandidates(BRIDGE_SWEEP_BATCH_LIMIT);
  for (const candidate of candidates) {
    await deps.touchAttempt(candidate.executionId); // B6: recovery queue shares the fair-scheduling discipline.
    let orderId: string | null;
    try {
      orderId = await deps.recoverKhalaniOrderId(candidate);
    } catch (err) {
      logger.warn("bridge.repair.order_recovery_failed", {
        executionId: candidate.executionId,
        error: summarizeProtocolError(err).message,
      });
      counters.stillPending++;
      continue;
    }
    if (!orderId) {
      counters.stillPending++;
      continue;
    }
    const attach = await deps.attachOrderId({ executionId: candidate.executionId, providerOrderId: orderId });
    await deps.touchChecked(candidate.executionId, `order_recovered:${attach.outcome}`);
    if (attach.outcome === "attached" || attach.outcome === "already_attached_same") {
      counters.recovered++;
    } else {
      // conflict_different_id / not_pending — the repo already logged the anomaly.
      counters.stillPending++;
    }
  }
}

/**
 * C3 recovery path (Blocker 11): idempotently enqueue the balance-refresh job for
 * confirmed logical bridge rows whose execution still has none — closing the
 * confirmed-but-unenqueued crash window between the confirm CAS and the enqueue.
 * It ALSO clears any stranded relay reveal for those rows (the confirm path might
 * have crashed after the CAS but before/at the reveal-clear). The list query
 * returns ONLY rows still needing it (bounded fair queue, no age cutoff), so this
 * self-limits; the enqueue is idempotent regardless.
 */
async function reconcileBalanceEnqueues(deps: BridgeRepairDeps, counters: MutableSweepCounters): Promise<void> {
  const rows = await deps.listConfirmedNeedingBalanceRefresh(BRIDGE_SWEEP_BATCH_LIMIT);
  for (const row of rows) {
    if (row.protocol === "relay" && row.sessionId && row.normalizedRoute) {
      deps.clearRelayReveal(row.sessionId, row.normalizedRoute);
    }
    try {
      await deps.enqueueBalanceRefresh({ namespace: row.protocol, executionId: row.executionId });
      counters.balanceReconciled++;
    } catch (err) {
      // One row's enqueue failure must not abort the rest — it stays in the
      // needing-refresh set and is retried next sweep.
      logger.warn("bridge.repair.reconcile_enqueue_failed", {
        executionId: row.executionId,
        error: summarizeProtocolError(err).message,
      });
    }
  }
}

/** Infer a chain's family from its provider-native id (only the known Solana ids are non-eip155). */
function inferBridgeChainFamily(chainId: number): BridgeChainFamily {
  return SOLANA_CHAIN_IDS.has(chainId) ? "solana" : "eip155";
}

function readStoredCorrelation(logical: BridgeSweepRow): StoredBridgeCorrelation | null {
  if (logical.fromChainId === null || logical.toChainId === null) return null;
  // The logical row stores the DESTINATION family authoritatively (the fill leg
  // executes on the destination). The origin family is inferred from its id (only
  // the Solana ids are non-eip155) — used for the refund evidence row's explorer
  // link family and for family-aware identity comparison, never for a fund-critical
  // decision on its own.
  const route: StoredBridgeRoute = {
    fromChainId: logical.fromChainId,
    fromChainFamily: inferBridgeChainFamily(logical.fromChainId),
    toChainId: logical.toChainId,
    toChainFamily: logical.destChainFamily,
  };
  return {
    route,
    providerOrderId: logical.providerOrderId,
    tokenInAddress: logical.tokenInAddress,
    tokenOutAddress: logical.tokenOutAddress,
    author: logical.walletAddress,
    depositTxHash: logical.depositTxHash,
    quoteId: logical.quoteId,
    routeId: logical.routeId,
  };
}

function logDuplicateCas(executionId: number, attempted: "confirm" | "fail", outcome: CasResult): void {
  // Not a failure — a concurrent sweep instance already settled this row.
  logger.info("bridge.repair.duplicate_cas_miss", {
    executionId,
    attempted,
    currentStatus: outcome.row.status,
  });
}

// ── Production wiring ───────────────────────────────────────────────────────

/** Extract an optional string field from the logical row's `route_provenance` JSONB (quote/route ids). */
function readProvenanceString(provenance: unknown, key: string): string | null {
  if (typeof provenance !== "object" || provenance === null) return null;
  const value = (provenance as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map a raw `agent_activity` logical row (+ joined deposit hash) to the narrow sweep read model. */
function toSweepRow(r: Record<string, unknown>): BridgeSweepRow {
  return {
    id: Number(r.id),
    protocolExecutionId: Number(r.protocol_execution_id),
    protocol: String(r.protocol),
    providerOrderId: r.provider_order_id === null || r.provider_order_id === undefined ? null : String(r.provider_order_id),
    fromChainId: r.from_chain_id === null || r.from_chain_id === undefined ? null : Number(r.from_chain_id),
    toChainId: r.to_chain_id === null || r.to_chain_id === undefined ? null : Number(r.to_chain_id),
    destChainFamily: (r.chain_family as BridgeChainFamily) ?? "eip155",
    tokenInAddress: r.token_in_address === null || r.token_in_address === undefined ? null : String(r.token_in_address),
    tokenOutAddress: r.token_out_address === null || r.token_out_address === undefined ? null : String(r.token_out_address),
    walletAddress: String(r.wallet_address),
    depositTxHash: r.deposit_tx_hash === null || r.deposit_tx_hash === undefined ? null : String(r.deposit_tx_hash),
    quoteId: readProvenanceString(r.route_provenance, "quoteId"),
    routeId: readProvenanceString(r.route_provenance, "routeId"),
    sessionId: r.session_id === null || r.session_id === undefined ? null : String(r.session_id),
    normalizedRoute: r.normalized_route === null || r.normalized_route === undefined ? null : String(r.normalized_route),
    lastAttemptedAt: toIsoOrNull(r.last_attempted_at),
    createdAt: toIso(r.created_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

/** Read a positive integer field from a provider payload (passthrough boundary validation), else undefined. */
function readOptionalChainId(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Read an optional string[] field from a provider payload (passthrough boundary validation), else undefined. */
function readOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) if (typeof v === "string") out.push(v);
  return out;
}

/**
 * Real `BridgeRepairDeps`: raw fair-scheduling SQL (the bridge sweep queries are
 * NOT part of W-SPINE's repo API and MUST NOT be added to it — this module owns
 * them, reading through the shared `db/client` primitives with a narrow
 * projection), the Khalani/Relay clients, SSRF-controlled RPC verification, the
 * idempotent-by-execution-id balance enqueue, and W5's reveal-clear. Every lazy
 * import mirrors the Phase-1 `buildProductionRepairDeps` shape so the module load
 * stays IO-free.
 */
export function buildProductionBridgeRepairDeps(): BridgeRepairDeps {
  return {
    listSweepCandidates: async (limit) => {
      const { query } = await import("@vex-agent/db/client.js");
      // The logical row + its sibling `bridge_deposit` staged hash (R6 deposit
      // correlation), fair-scheduled oldest-touched first.
      const rows = await query<Record<string, unknown>>(
        `SELECT lg.*,
                (SELECT dep.tx_hash FROM agent_activity dep
                  WHERE dep.protocol_execution_id = lg.protocol_execution_id
                    AND dep.event_role = 'bridge_deposit'
                    AND dep.tx_hash IS NOT NULL
                  ORDER BY dep.event_index ASC
                  LIMIT 1) AS deposit_tx_hash
           FROM agent_activity lg
          WHERE lg.event_role = 'bridge_fill_expected'
            AND lg.status = 'pending'
            AND lg.provider_order_id IS NOT NULL
          ORDER BY COALESCE(lg.last_attempted_at, lg.created_at) ASC, lg.id ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map(toSweepRow);
    },

    listOrderIdRecoveryCandidates: async (limit) => {
      const { query } = await import("@vex-agent/db/client.js");
      // Pending Khalani logical rows with NO order id yet, whose sibling
      // `bridge_deposit` leg has a staged hash (the crash-after-broadcast window).
      const rows = await query<Record<string, unknown>>(
        `SELECT lg.protocol_execution_id AS execution_id, lg.protocol AS protocol,
                lg.wallet_address AS wallet_address, dep.tx_hash AS deposit_tx_hash,
                lg.from_chain_id AS from_chain_id, lg.to_chain_id AS to_chain_id
           FROM agent_activity lg
           JOIN agent_activity dep
             ON dep.protocol_execution_id = lg.protocol_execution_id
            AND dep.event_role = 'bridge_deposit'
            AND dep.tx_hash IS NOT NULL
          WHERE lg.event_role = 'bridge_fill_expected'
            AND lg.status = 'pending'
            AND lg.provider_order_id IS NULL
            AND lg.protocol = 'khalani'
          ORDER BY COALESCE(lg.last_attempted_at, lg.created_at) ASC, lg.protocol_execution_id ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        executionId: Number(r.execution_id),
        protocol: String(r.protocol),
        walletAddress: String(r.wallet_address),
        depositTxHash: String(r.deposit_tx_hash),
        fromChainId: Number(r.from_chain_id),
        toChainId: Number(r.to_chain_id),
      }));
    },

    listConfirmedNeedingBalanceRefresh: async (limit) => {
      const { query } = await import("@vex-agent/db/client.js");
      // Confirmed logical bridge rows whose execution has NO balance-refresh run
      // for its provider namespace yet (C3 recovery). NO age cutoff (Blocker 11):
      // a row that sat unenqueued through a long outage must still recover. Bounded
      // + fair-ordered by `confirmed_at ASC`; once enqueued it drops out
      // permanently (`protocol_sync_runs` are never deleted). `session_id` +
      // `normalized_route` are returned so recovery can re-clear a stranded reveal.
      const rows = await query<Record<string, unknown>>(
        `SELECT a.protocol_execution_id AS execution_id, a.protocol AS protocol,
                a.session_id AS session_id, a.normalized_route AS normalized_route
           FROM agent_activity a
          WHERE a.event_role = 'bridge_fill_expected'
            AND a.status = 'confirmed'
            AND NOT EXISTS (
              SELECT 1 FROM protocol_sync_runs r
              JOIN protocol_sync_jobs j ON j.id = r.sync_job_id
              WHERE r.execution_id = a.protocol_execution_id
                AND j.sync_type = 'balances'
                AND j.namespace = a.protocol
            )
          ORDER BY a.confirmed_at ASC, a.id ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        executionId: Number(r.execution_id),
        protocol: String(r.protocol),
        sessionId: r.session_id === null || r.session_id === undefined ? null : String(r.session_id),
        normalizedRoute: r.normalized_route === null || r.normalized_route === undefined ? null : String(r.normalized_route),
      }));
    },

    touchAttempt: async (executionId) => {
      const { execute } = await import("@vex-agent/db/client.js");
      await execute(
        `UPDATE agent_activity SET last_attempted_at = NOW(), updated_at = NOW()
          WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected' AND status = 'pending'`,
        [executionId],
      );
    },

    touchChecked: async (executionId, providerStatus) => {
      const { execute } = await import("@vex-agent/db/client.js");
      await execute(
        `UPDATE agent_activity SET last_checked_at = NOW(), provider_status = $2, updated_at = NOW()
          WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected' AND status = 'pending'`,
        [executionId, providerStatus],
      );
    },

    fetchKhalaniOrder: async (orderId) => {
      try {
        const { getKhalaniClient } = await import("@tools/khalani/client.js");
        const order = await getKhalaniClient().getOrderById(orderId);
        // `order.transactions` is `Record<string, KhalaniTransactionInfo>`; its value
        // type widens structurally into the sweep's tolerant `KhalaniOrderTx` view.
        return {
          id: order.id,
          status: order.status,
          fromChainId: order.fromChainId,
          toChainId: order.toChainId,
          quoteId: order.quoteId,
          routeId: order.routeId,
          fromToken: order.fromToken,
          toToken: order.toToken,
          author: order.author,
          depositTxHash: order.depositTxHash,
          transactions: order.transactions,
        };
      } catch (err) {
        logger.warn("bridge.repair.khalani_fetch_failed", { orderId, error: summarizeProtocolError(err).message });
        return null;
      }
    },

    fetchRelayStatus: async (requestId) => {
      try {
        const { getRelayClient } = await import("@tools/relay/client.js");
        const status = await getRelayClient().getIntentStatus(requestId);
        // The client schema `.passthrough()`s the canonical route/origin fields
        // (`inTxHashes`, `originChainId`, `destinationChainId`) without typing them —
        // validate them at THIS boundary (Blocker 6) rather than trusting an unsafe cast.
        const raw = status as unknown as Record<string, unknown>;
        return {
          status: status.status,
          txHashes: status.txHashes,
          destinationTxHashes: status.destinationTxHashes,
          inTxHashes: readOptionalStringArray(raw.inTxHashes),
          originChainId: readOptionalChainId(raw.originChainId),
          destinationChainId: readOptionalChainId(raw.destinationChainId),
        };
      } catch (err) {
        logger.warn("bridge.repair.relay_fetch_failed", { requestId, error: summarizeProtocolError(err).message });
        return null;
      }
    },

    recoverKhalaniOrderId: async (candidate) => {
      // Lookup-only (never re-signs/re-broadcasts): match the persisted deposit
      // hash against orders-by-address (R5). Idempotent-resubmit → DuplicateRecord
      // is a named future option, deliberately not used here to keep the
      // background sweep free of any state-changing provider call.
      try {
        const { getKhalaniClient } = await import("@tools/khalani/client.js");
        const orders = await getKhalaniClient().getOrders(candidate.walletAddress, {
          txHashSearch: candidate.depositTxHash,
          fromChainId: candidate.fromChainId,
          toChainId: candidate.toChainId,
        });
        const match = orders.data.find(
          (o) => o.depositTxHash?.toLowerCase() === candidate.depositTxHash.toLowerCase(),
        );
        return match?.id ?? null;
      } catch (err) {
        logger.warn("bridge.repair.khalani_recover_failed", {
          executionId: candidate.executionId,
          error: summarizeProtocolError(err).message,
        });
        return null;
      }
    },

    verifyFill: (input) => verifyBridgeLegOnChain(input),

    confirmExpectedFill: (input) => confirmBridgeExpectedFill(input),
    failLogical: (logicalRowId, failureCode, failureReason) =>
      failActivityEvent(logicalRowId, { failureCode, failureReason }),
    appendFillObserved: (input) =>
      markBridgeLegObserved({
        executionId: input.executionId,
        eventRole: "bridge_fill_observed",
        protocol: input.protocol,
        chainId: input.chainId,
        chainFamily: input.chainFamily,
        txHash: input.txHash,
        evidenceSource: input.evidenceSource,
        providerStatus: input.providerStatus,
      }),
    appendRefundEvidence: (input) =>
      markBridgeLegObserved({
        executionId: input.executionId,
        eventRole: "bridge_refund",
        protocol: input.protocol,
        chainId: input.chainId,
        chainFamily: input.chainFamily,
        txHash: input.txHash,
        evidenceSource: input.evidenceSource,
        providerStatus: input.providerStatus,
      }),
    attachOrderId: (input) => attachProviderOrderId(input),

    enqueueBalanceRefresh: async ({ namespace, executionId }) => {
      const { getJobsForNamespace } = await import("@vex-agent/db/repos/sync.js");
      const { execute } = await import("@vex-agent/db/client.js");
      const jobs = await getJobsForNamespace(namespace);
      for (const job of jobs) {
        if (job.syncType !== "balances") continue;
        // Idempotent by (job, execution): one balance-refresh run per confirmed
        // bridge, concurrency-safe. The partial unique index on
        // `protocol_sync_runs (sync_job_id, execution_id) WHERE execution_id IS NOT
        // NULL` (migration 046) is the authority; ON CONFLICT DO NOTHING makes two
        // concurrent sweeps a no-op instead of a duplicate run (Blocker 11).
        await execute(
          `INSERT INTO protocol_sync_runs (sync_job_id, execution_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (sync_job_id, execution_id) WHERE execution_id IS NOT NULL DO NOTHING`,
          [job.id, executionId],
        );
      }
    },

    clearRelayReveal: (sessionId, routeKey) => clearRelayRouteReveal(sessionId, routeKey),
  };
}

/**
 * Production B4 leg verifier (fills AND refunds). EVM: SSRF-controlled RPC
 * selection (curated/local first, provider-registry fallback validated
 * public-HTTPS + non-private) → `eth_chainId` echo (must match the expected
 * chain) → `getTransactionReceipt` (must exist and succeed). Solana:
 * `getGenesisHash` cluster echo → `getSignatureStatuses` (`err == null` + a
 * `confirmed`/`finalized` status). NEVER decodes executed amounts this phase (they
 * stay NULL and quoted amounts remain estimates — Q2; transfer-log decoding
 * against the stored token + recipient is a named follow-up, and the recipient is
 * not stored anyway — Blocker 7). Any failure → `verified:false` so the row stays
 * pending (fail-closed). All verification fetches pin redirects OFF.
 */
async function verifyBridgeLegOnChain(input: FillVerificationInput): Promise<FillVerification> {
  if (input.chainFamily === "solana") {
    return verifySolanaLegOnChain(input);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { verified: false, reason: "malformed_fill_hash" };
  }

  const { curated, providerRegistry } = await resolveVerificationRpcs(input.expectedChainId, input.protocol, "eip155");
  const urls = selectVerificationRpcUrls({ curated, providerRegistry });
  if (urls.length === 0) return { verified: false, reason: "no_safe_rpc" };

  const { createPublicClient, http } = await import("viem");
  for (const rpcUrl of urls) {
    try {
      const client = createPublicClient({
        // Redirect-off (Blocker 10): a 3xx to a re-pointed (possibly private) host
        // is refused, not followed. The chain-id echo below is the second defense.
        transport: http(rpcUrl, { timeout: 15_000, retryCount: 1, fetchOptions: { redirect: "error" } }),
      });
      const echo = await client.getChainId();
      if (echo !== input.expectedChainId) continue; // wrong chain / swapped endpoint — try the next url.
      const receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
      // Receipt exists: `success` confirms the leg; a revert is a definitive
      // NOT-verified (the tx reverted) — stays pending, never confirmed.
      return receipt.status === "success"
        ? { verified: true }
        : { verified: false, reason: "fill_reverted" };
    } catch (err) {
      // Not mined yet / transient RPC error / receipt-not-found — try the next url.
      logger.debug("bridge.repair.rpc_probe_miss", { chainId: input.expectedChainId, error: summarizeProtocolError(err).message });
      continue;
    }
  }
  return { verified: false, reason: "receipt_unavailable" };
}

/**
 * Solana destination-leg verification (Blocker 10): a signature-status lookup
 * over an SSRF-safe registry RPC. `getGenesisHash` confirms the endpoint serves
 * mainnet-beta (the Solana analog of the EVM `eth_chainId` echo), then
 * `getSignatureStatuses` with `searchTransactionHistory` proves the signature —
 * `err == null` + a `confirmed`/`finalized` status ⇒ verified; a present `err` ⇒
 * definitively NOT verified (the fill tx failed). Any transient/unavailable case
 * ⇒ not verified, row stays pending. Redirects are pinned OFF.
 */
async function verifySolanaLegOnChain(input: FillVerificationInput): Promise<FillVerification> {
  // Base58 Solana signatures are ~87–88 chars; reject an EVM-shaped hash outright.
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(input.txHash)) {
    return { verified: false, reason: "malformed_fill_signature" };
  }
  const { providerRegistry } = await resolveVerificationRpcs(input.expectedChainId, input.protocol, "solana");
  // Solana has no curated/local EVM RPC — only the SSRF-validated provider registry.
  const urls = selectVerificationRpcUrls({ curated: [], providerRegistry });
  if (urls.length === 0) return { verified: false, reason: "no_safe_rpc" };

  for (const rpcUrl of urls) {
    try {
      const genesis = await solanaRpcCall(rpcUrl, "getGenesisHash", []);
      if (typeof genesis !== "string" || genesis !== SOLANA_MAINNET_GENESIS) continue; // wrong cluster — try next.
      const result = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
        [input.txHash],
        { searchTransactionHistory: true },
      ]);
      const value = typeof result === "object" && result !== null ? (result as Record<string, unknown>).value : undefined;
      const entry = Array.isArray(value) ? value[0] : null;
      if (entry === null || entry === undefined || typeof entry !== "object") continue; // unknown on this node — try next.
      const record = entry as Record<string, unknown>;
      if (record.err !== null && record.err !== undefined) {
        return { verified: false, reason: "fill_failed" }; // definitive: the tx errored.
      }
      const confirmationStatus = record.confirmationStatus;
      if (confirmationStatus === "confirmed" || confirmationStatus === "finalized") {
        return { verified: true };
      }
      return { verified: false, reason: "not_yet_confirmed" };
    } catch (err) {
      logger.debug("bridge.repair.solana_probe_miss", {
        chainId: input.expectedChainId,
        error: summarizeProtocolError(err).message,
      });
      continue;
    }
  }
  return { verified: false, reason: "signature_status_unavailable" };
}

/** Minimal JSON-RPC POST for Solana verification: redirect OFF (SSRF), 15s timeout, no auth headers. Returns `result`. */
async function solanaRpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`solana rpc ${method}: http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== null && body.error !== undefined) throw new Error(`solana rpc ${method}: rpc error`);
  return body.result;
}

/**
 * Curated/local RPCs (EVM only, trusted) + PROVIDER-registry RPCs from the RIGHT
 * registry for the owning protocol (Blocker 10): Relay `/chains` (`httpRpcUrl`)
 * for relay bridges, Khalani `/v1/chains` (`rpcUrls.default.http[0]`) for khalani
 * — never always Khalani. All provider-registry URLs are SSRF-validated downstream.
 */
async function resolveVerificationRpcs(
  chainId: number,
  protocol: string,
  family: BridgeChainFamily,
): Promise<{ curated: string[]; providerRegistry: string[] }> {
  const curated: string[] = [];
  const providerRegistry: string[] = [];

  if (family === "eip155") {
    try {
      const { getLocalChain, getLocalChainRpcUrl } = await import("@tools/evm-chains/registry.js");
      const local = getLocalChain(chainId);
      if (local) curated.push(getLocalChainRpcUrl(local));
    } catch (err) {
      logger.debug("bridge.repair.local_rpc_lookup_failed", { chainId, error: summarizeProtocolError(err).message });
    }
  }

  if (protocol === "relay") {
    try {
      const { getCachedRelayChains } = await import("@tools/relay/client.js");
      const chains = await getCachedRelayChains();
      const match = chains.find((c) => c.id === chainId);
      // Relay `/chains` exposes the RPC as `httpRpcUrl` (passthrough on RelayChain).
      const url = match ? readHttpRpcUrl(match) : null;
      if (url) providerRegistry.push(url);
    } catch (err) {
      logger.debug("bridge.repair.provider_rpc_lookup_failed", { chainId, protocol, error: summarizeProtocolError(err).message });
    }
  } else {
    try {
      const { getCachedKhalaniChains } = await import("@tools/khalani/chains.js");
      const chains = await getCachedKhalaniChains();
      const match = chains.find((c) => c.id === chainId);
      const url = match?.rpcUrls?.default?.http?.[0];
      if (url) providerRegistry.push(url);
    } catch (err) {
      logger.debug("bridge.repair.provider_rpc_lookup_failed", { chainId, protocol, error: summarizeProtocolError(err).message });
    }
  }

  return { curated, providerRegistry };
}

/** Read the passthrough `httpRpcUrl` string from a Relay chain record (not in the typed schema). */
function readHttpRpcUrl(chain: object): string | null {
  const value = (chain as Record<string, unknown>).httpRpcUrl;
  return typeof value === "string" && value.length > 0 ? value : null;
}
