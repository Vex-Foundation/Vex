/**
 * `bridge-activity-repair.ts` shared contracts — split out (Card C5,
 * move-only) once the parent file crossed the repo's 500-line cap. See
 * `bridge-activity-repair.ts`'s own module doc for the full W4 sweep design
 * (R12/B4/B6/C3, dossier §2) these types/tunables serve: the narrow
 * `BridgeSweepRow` read model, the provider payload shapes (Khalani/Relay),
 * the injected `BridgeRepairDeps` port, the pure status-mapping result type
 * (`BridgeObservation`), and the R6 stored-correlation shape.
 */

import type {
  VerificationReason,
  BridgeChainFamily,
  CasResult,
  MarkBridgeLegObservedResult,
  AttachProviderOrderIdResult,
} from "@vex-agent/db/repos/agent-activity.js";

// ── Tunables ──────────────────────────────────────────────────────────────

/**
 * Bounded batch per queue per sweep run (Phase-1 C11 parity): the sweep does
 * serial provider + RPC calls inside the shared sync worker — an unbounded
 * backlog would starve balance/settlement sync sharing the same drain. Any
 * remainder is picked up on the next periodic tick.
 */
export const BRIDGE_SWEEP_BATCH_LIMIT = 25;

/**
 * The `last_verification_reason` vocabulary is owned by the column's own repo
 * module (`db/repos/agent-activity/types.ts`), beside the read side that derives
 * `stalledVerification` from it — this family only consumes it. Re-exported here
 * so the sweep's existing import path is unchanged.
 */
export type { VerificationReason } from "@vex-agent/db/repos/agent-activity.js";
export { VERIFICATION_REASONS, toVerificationReason } from "@vex-agent/db/repos/agent-activity.js";

/** Provider evidence-source markers persisted on confirmed/observed bridge rows (R6 provenance). */
export const KHALANI_EVIDENCE_SOURCE = "khalani_order_status";
export const RELAY_EVIDENCE_SOURCE = "relay_intent_status";

// ── Narrow read model (only the logical-row columns the sweep acts on) ──────

/** The subset of the logical `bridge_fill_expected` row the sweep reads. Keeps this module free of the repo's private `mapRow`. */
export interface BridgeSweepRow {
  readonly id: number;
  readonly protocolExecutionId: number;
  readonly protocol: string;
  readonly providerOrderId: string | null;
  readonly fromChainId: number | null;
  readonly toChainId: number | null;
  /** The logical row's own chain_family = the DESTINATION family (the fill executes on the destination). */
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
  /**
   * The reason the LAST check could not conclude (migration 065), as already
   * stored on this row.
   *
   * Carried so the sweep can log a state CHANGE instead of one identical `warn`
   * per poll, forever: an unverifiable row used to emit the same
   * `bridge.repair.fill_unverified` line every 30 s indefinitely, which buries
   * every other line in the shared sync log and tells the reader nothing new.
   * NULL before the first inconclusive check.
   */
  readonly lastVerificationReason: string | null;
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
  /**
   * The EXTERNAL router's own order id — for `routeId: "DeBridge"` orders this is
   * the DLN order id, and it is the ONLY handle on a destination fill hash those
   * orders ever expose (F2; live capture 2026-07-26).
   */
  readonly externalOrderId?: string;
  /**
   * Destination recipient the provider reports. NOT stored on the logical row
   * (Blocker 7), so it is carried here purely as an expectation for the DeBridge
   * fill-hash cross-check.
   */
  readonly recipient?: string | null;
  /** Quoted destination amount in raw units of `toToken` (the DeBridge cross-check's amount expectation). */
  readonly destAmount?: string;
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
  /**
   * The LOGICAL row's own `agent_activity.id` — what the stall counter is keyed
   * on. Carried because `executionId` addresses the whole execution (deposit leg
   * included), while `noteVerificationInconclusive`/`Conclusive` move the
   * verification state of the single `bridge_fill_expected` row.
   */
  readonly logicalRowId: number;
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

/**
 * Everything a deBridge (DLN) fill-hash recovery must PROVE before the hash it
 * returns may be handed to the B4 verifier (F2).
 *
 * A DeBridge-routed Khalani order reports `filled` while carrying only its
 * deposit transaction; the destination hash exists solely in deBridge's stats
 * API. Reading it means trusting a THIRD provider, so the lookup carries the
 * full destination identity the DLN record must echo back — chain, token,
 * recipient, and the exact destination amount. `expectedDestChainId`/`Family`
 * come from the STORED route (never the provider's echo); the token comes from
 * the stored logical row; recipient and amount come from the Khalani order,
 * which the R6 correlation has ALREADY proven is ours (order id, author, deposit
 * hash, tokens, quote id, route id) by the time a recovery is attempted.
 *
 * A `null` on any of the three nullable fields means Vex never recorded that
 * expectation: the lookup then refuses outright. A recording gap is never a
 * reason to relax confirmation.
 */
export interface DebridgeFillHashLookup {
  /** The DLN order id (`0x` + 64 hex) from the Khalani order's `externalOrderId`. */
  readonly externalOrderId: string;
  readonly expectedDestChainId: number;
  readonly expectedDestChainFamily: BridgeChainFamily;
  readonly expectedTokenOutAddress: string | null;
  readonly expectedRecipient: string | null;
  /** Raw units of the destination token — compared EXACTLY, no tolerance. */
  readonly expectedDestAmount: string | null;
}

/** Result of the B4 verification. Executed amounts are present ONLY when decoded against the stored token + recipient (Q2). */
export interface FillVerification {
  readonly verified: boolean;
  /** A member of the closed 065 vocabulary — the type is what keeps provider text out of a stored column. */
  readonly reason?: VerificationReason;
  readonly executedAmountInHuman?: string;
  readonly executedAmountInRaw?: string;
  readonly executedAmountOutHuman?: string;
  readonly executedAmountOutRaw?: string;
}

export interface BridgeRepairDeps {
  // ── Fair-scheduled candidate CLAIMS (bounded, atomic) ──
  /**
   * CLAIM up to `limit` pending logical rows with a `provider_order_id` that are
   * DUE now, oldest-touched first, stamping `last_attempted_at` in the SAME
   * statement.
   *
   * A CLAIM, not a read, and a due gate, not a plain LIMIT — two independent
   * defects, both live in production:
   *
   * 1. FOUR drivers call this sweep (the fast lane's provider leg at 30 s, the
   *    periodic 120 s job, `drainPendingRuns` and `processNextRun`). A
   *    read-then-`touchAttempt` only serialises SEQUENTIAL callers: two drivers
   *    can both select the same rows before either commits its stamp, and then
   *    both poll the provider for them. `FOR UPDATE SKIP LOCKED` + `UPDATE …
   *    RETURNING` makes selection and stamp one statement, so concurrent
   *    drivers take DISJOINT batches (the repo's own shape —
   *    `db/repos/token-launch-intents/sweep-claim.ts`).
   * 2. Without a due gate the extra drivers are pure amplification: the same row
   *    is re-checked whenever ANY driver runs. The gate is per row, phased on
   *    the row's IMMUTABLE `created_at` — 30 s for the first 5 minutes of row
   *    age, 60 s to 15 minutes, 5 minutes after that. It is deliberately NOT
   *    phased on `last_attempted_at`, which every attempt rewrites: that clock
   *    resets on every poll, so the row would never reach a later phase.
   *
   * Bounded and never auto-failing: a row that stays inconclusive simply moves
   * to the back of the queue and is checked less often as it ages.
   */
  listSweepCandidates(limit: number): Promise<BridgeSweepRow[]>;
  /** CLAIM pending Khalani logical rows with a staged deposit hash but NULL `provider_order_id` (R5 recovery queue) — same atomicity, fairness and due gate. */
  listOrderIdRecoveryCandidates(limit: number): Promise<BridgeOrderIdRecoveryCandidate[]>;
  /** Confirmed logical bridge rows whose execution still has no balance-refresh run (C3 confirm→enqueue crash recovery), bounded, fair-ordered. */
  listConfirmedNeedingBalanceRefresh(limit: number): Promise<ConfirmedBalanceRefreshCandidate[]>;

  // ── Scheduling writes ──
  /** `last_attempted_at = NOW()` on the logical row — EVERY attempt, including transport failures (B6). */
  touchAttempt(executionId: number): Promise<void>;
  /** `last_checked_at = NOW()` + `provider_status` on the logical row — ONLY after a successful provider observation (B6). */
  touchChecked(executionId: number, providerStatus: string): Promise<void>;

  // ── Stall visibility (migration 065) ──
  /**
   * ONE more CONSECUTIVE inconclusive verification attempt, with the named
   * reason it could not conclude. Keyed by the LOGICAL ROW ID (not the execution
   * id) because the counter is a property of that row.
   *
   * THIS NEVER TERMINALIZES ANYTHING and no threshold on the counter ever may:
   * `stalled_verification` is a DERIVED read-side state. `no_safe_rpc` in
   * particular means the outcome is UNKNOWN, and recording an unknown outcome as
   * failed would report a possibly successful transfer of real funds as a
   * failure. The never-auto-fail policy is unchanged.
   */
  noteVerificationInconclusive(logicalRowId: number, reason: VerificationReason): Promise<void>;
  /**
   * A verification attempt CONCLUDED — reset the consecutive-inconclusive
   * counter. Without this reset an ordinary slow-but-healthy bridge would
   * eventually render as "verification stalled", which is a lie about what the
   * system knows: the counter must measure a STALL, not age.
   */
  noteVerificationConclusive(logicalRowId: number): Promise<void>;

  // ── Provider status (null = transport failure; the row stays pending) ──
  fetchKhalaniOrder(orderId: string): Promise<KhalaniOrderView | null>;
  fetchRelayStatus(requestId: string): Promise<RelayStatusView | null>;

  /**
   * DeBridge (DLN) destination fill-hash recovery for a Khalani order that
   * reports `filled` without one (F2). Returns the hash ONLY when the DLN record
   * proves — inside the implementation, never by the caller — that it settles
   * exactly this `input`. `null` on ANY doubt: transport failure, non-200,
   * malformed payload, unexpected state, an identity that disagrees, or an
   * expectation Vex never recorded. It never throws into the sweep batch, and a
   * recovered hash is still gated by the unchanged `verifyFill` proof.
   */
  fetchDebridgeFillHash(input: DebridgeFillHashLookup): Promise<{ txHash: string } | null>;

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

/**
 * The sweep's in-flight accumulator for `BridgeRepairSweepResult` — the mutable
 * counterpart, shared by the sweep loop and the terminal-transition module it
 * dispatches to (`./bridge-activity-repair-terminalize.js`). Internal to the
 * repair family; not part of the public gate.
 */
export interface MutableSweepCounters {
  confirmed: number;
  failed: number;
  refunded: number;
  recovered: number;
  balanceReconciled: number;
  stillPending: number;
}

// ── Pure status mapping result shape (dossier §2 table) ─────────────────────

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
  // §5: keep pending + anomaly, NEVER fabricate a confirmation. `debridgeFillRecovery`
  // is present ONLY for a DeBridge-routed Khalani order carrying an
  // `externalOrderId` (F2): for those the hash is recoverable from deBridge's
  // stats API, and the recovered hash still goes through the B4 verify→confirm
  // path. Absent for every other route — the row simply stays pending.
  | {
      readonly kind: "filled_no_hash";
      readonly providerStatus: string;
      readonly debridgeFillRecovery?: DebridgeFillHashLookup;
    }
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
