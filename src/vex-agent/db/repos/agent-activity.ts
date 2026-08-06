/**
 * Agent Scan activity repo — public façade for `agent_activity` (migrations
 * `044_agent_activity.sql`, `045_bridge_activity.sql`).
 *
 * One row per swap or bridge TRANSACTION EVENT, grouped by
 * `protocol_execution_id` + uniquely keyed by `(protocol_execution_id,
 * event_index)`. The full CAS/staged-broadcast write-protocol contract is
 * documented on `./agent-activity/swap-intent.js` (step 1: pre-broadcast
 * intent creation) and `./agent-activity/swap-lifecycle.js` (steps 2-4:
 * staged broadcast, CAS finalize, repair-sweep reads) — those same
 * primitives are reused verbatim by Vex-signed bridge legs. The bridge-only
 * route/logical-row/evidence API lives on `./agent-activity/bridge-intent.js`
 * + `./agent-activity/bridge-lifecycle.js` (Phase 2, migration 045).
 *
 * Public API module. Internals split into `./agent-activity/` submodules by
 * concern (shared types, write-boundary validation, row mapping, swap
 * lifecycle, bridge lifecycle). Consumers import from this module —
 * submodules are implementation detail.
 */

export type {
  AgentActivityKind,
  AgentActivityEventRole,
  BridgeChainFamily,
  AgentActivityStatus,
  AgentActivityFailureCode,
  AgentActivityLegInput,
  AgentActivityEvent,
  CasResult,
} from "./agent-activity/types.js";

// Wave P — the DERIVED stalled-verification state. A value and a predicate, not
// a type, so they are re-exported separately from the type block above.
export {
  STALLED_VERIFICATION_ATTEMPTS,
  STALL_INCREMENT_MIN_INTERVAL_MS,
  isStalledVerification,
  isTerminalActivityStatus,
  isFailedActivityStatus,
} from "./agent-activity/types.js";

// The closed `last_verification_reason` vocabulary (migration 065) — one owner
// for the column the three repair sweeps all write.
export type { VerificationReason } from "./agent-activity/types.js";
export { VERIFICATION_REASONS, toVerificationReason } from "./agent-activity/types.js";

export type {
  CreatePendingActivityEventInput,
  RecordPreBroadcastFailureInput,
  CreateAgentActivityIntentInput,
  CreateAgentActivityPreBroadcastFailureInput,
} from "./agent-activity/swap-intent.js";
export {
  createPendingActivityEvent,
  createAgentActivityIntent,
  recordPreBroadcastFailure,
  createAgentActivityPreBroadcastFailure,
} from "./agent-activity/swap-intent.js";

// The closed vocabularies of migration 067's provenance columns — one owner per
// column, the sibling of `VerificationReason` above (which owns the 065 column).
export type {
  ConfirmationSource,
  SettlementSource,
  SettlementDeclineReason,
  PendingReason,
} from "./agent-activity/provenance-vocabulary.js";
// R1 Step 5a: the decode inputs a handler persists at intent time, and the
// validated read the pending fallback uses. An OPTIONAL accelerator — a row
// without one is decoded from its own columns or left alone, never guessed.
export type { SettlementDecodeHint, SettlementDecodeHintInput } from "./agent-activity/settlement-decode.js";
export {
  SETTLEMENT_DECODE_VERSION,
  settlementDecodeSchema,
  settlementDecodeProvenance,
  readSettlementDecodeHint,
} from "./agent-activity/settlement-decode.js";
export {
  CONFIRMATION_SOURCES,
  SETTLEMENT_SOURCES,
  SETTLEMENT_DECLINE_REASONS,
  PENDING_REASONS,
} from "./agent-activity/provenance-vocabulary.js";

// The ONE predicate for "does this row's role still lack an executed leg?" —
// shared by the strict confirm guard, the late-fill CAS, the settlement-decline
// writer and the pending-fallback lane's candidate query. A second copy of this
// rule is how a row starts satisfying one caller and violating another.
export type { RoleLegRow } from "./agent-activity/role-legs.js";

// R1 Step 3b: WHAT a signed leg proves about what it moved. The default is NO
// amount — "we signed it and it confirmed" is not proof of the principal.
export type { LegAmountEvidence } from "./agent-activity/proven-leg-amounts.js";
export { provenLegAmounts } from "./agent-activity/proven-leg-amounts.js";
export { roleLegsIncomplete, isAmountBearingRole } from "./agent-activity/role-legs.js";

// Late money enrichment on an already-terminal row (migration 067) — the seam
// the pending-fallback lane uses to repair a confirmed-but-amountless row, or to
// state by name why it cannot. See `./agent-activity/settlement-enrichment.ts`.
export type {
  FillExecutedAmountsInput,
  FillExecutedAmountsOutcome,
  FillExecutedAmountsResult,
  NoteSettlementDeclinedMiss,
} from "./agent-activity/settlement-enrichment.js";
export {
  fillExecutedAmountsOnConfirmed,
  noteSettlementDeclined,
} from "./agent-activity/settlement-enrichment.js";

// WHICH confirmed rows still owe their amounts, and the durable decode marker
// that stops the fallback re-deciding one immutable receipt forever. Its own
// module: scheduling, not a money guard.
export {
  findBroadcastSenderByTxHash,
  listAmountCorrectionCandidates,
  noteSettlementDecodeVersion,
} from "./agent-activity/settlement-fallback-candidates.js";

// The pending-fallback lane's scheduling primitive and its ONE non-answer
// terminal transition (migration 068). See `./agent-activity/evm-claim.ts` for
// why the claim needs a durable lease and why the lease needs a token.
export type {
  ClaimedPendingEvmRow,
  ClaimDuePendingEvmResult,
  SupersededEvidence,
  SupersededMiss,
} from "./agent-activity/evm-claim.js";
export {
  claimDuePendingEvm,
  releaseEvmClaim,
  noteNonInclusionObserved,
  clearNonInclusionClock,
  markSupersededUnproven,
  mintClaimToken,
  // The phase decision as a VALUE, for the surfaces that must state the row's
  // current cadence rather than act on it (the progress push, the agent copy).
  nextEvmCheckInMs,
  EVM_FAST_PHASE_MS,
  EVM_FAST_INTERVAL_MS,
  EVM_SLOW_INTERVAL_MS,
  EVM_CLAIM_LIMIT,
  EVM_CLAIM_LEASE_MS,
  NONINCLUSION_TERMINALIZE_AFTER_MS,
} from "./agent-activity/evm-claim.js";

export type {
  MarkActivityBroadcastInput,
  ConfirmActivityEventInput,
  FailActivityEventInput,
  ListActivityFeedOptions,
  TerminalWriteContext,
  TerminalCasResult,
  PendingReasonContext,
  NotePendingReasonMiss,
} from "./agent-activity/swap-lifecycle.js";
export {
  markActivityBroadcast,
  markActivitySolanaBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  // The repair sweeps' status-only finalizer (owner decree 2026-07-30) —
  // exported from the facade so the sweeps never reach into the implementation
  // module. See its doc in `./agent-activity/swap-lifecycle.ts`.
  confirmActivityEventStatusOnly,
  failActivityEvent,
  abortPlannedEvents,
  touchLastChecked,
  clearVerificationStall,
  // Why a row is STILL pending (migration 067) — the boundary predicate the
  // pending-fallback lane routes on. Its own module,
  // `./agent-activity/swap-lifecycle/verification-bookkeeping.ts`.
  notePendingReason,
  getActivityEventById,
  listPendingOlderThan,
  // Wave P: the fast lane's by-id candidate read, and the group-wide pending
  // predicate `fullBalanceSync` consults before it may take a snapshot.
  listPendingByIds,
  // Wave P: the PROVIDER-lane rearm set (logical bridge rows), whose candidate
  // predicates are disjoint from every on-chain set.
  listPendingProviderLogical,
  hasPendingActivityForWallets,
  listSolanaStagedPending,
  listActivityFeed,
  existsForExecutionId,
} from "./agent-activity/swap-lifecycle.js";

// A launch's output token DOES NOT EXIST when its intent row is written, so
// `token_out_*` is discovered from the receipt and written at confirm. These
// two are the only writers of that discovered identity; both are guarded to
// `event_role = 'token_launch'`. See `./agent-activity/launch-lifecycle.ts`.
export type { ConfirmLaunchWithOutputIdentityInput } from "./agent-activity/launch-lifecycle.js";
export {
  confirmLaunchWithOutputIdentity,
  fillLaunchOutputIdentityOnConfirmed,
  // The sweep's read of the lane's own durable verdict for a launch hash — the
  // ONE way `sync/launch-identity-repair.ts` may reach this table.
  findLaunchActivityTerminalByTxHash,
  stampLaunchOutputIdentityByTxHash,
} from "./agent-activity/launch-lifecycle.js";

// Stale hashless-intent recovery (C7 — generalized off Solana-only to EVERY
// chain family; extracted to its own module to keep swap-lifecycle.js under
// the repo's 500-line cap).
export {
  HASHLESS_INTENT_RECOVERY_LEASE_MS,
  recoverStaleHashlessIntents,
} from "./agent-activity/hashless-recovery.js";

export type {
  BridgeRouteEndpoints,
  BridgeActivityLeg,
  BridgeExpectedFill,
  CreateBridgeActivityIntentInput,
  CreateBridgeActivityIntentResult,
} from "./agent-activity/bridge-intent.js";
export {
  buildNormalizedBridgeRoute,
  createBridgeActivityIntent,
  createBridgePreBroadcastFailure,
} from "./agent-activity/bridge-intent.js";

export type {
  NoteBridgeProviderObservationMiss,
  NoteBridgeProviderObservationResult,
  AttachProviderOrderIdOutcome,
  AttachProviderOrderIdResult,
  MarkBridgeLegObservedInput,
  MarkBridgeLegObservedResult,
  BridgeInFlightResult,
} from "./agent-activity/bridge-lifecycle.js";
export {
  attachProviderOrderId,
  // R1 Step 3a: the handler's own in-turn provider observation. NEVER
  // terminalizes — a provider report is the provider's word, not proof.
  noteBridgeProviderObservation,
  confirmBridgeExpectedFill,
  markBridgeLegObserved,
  checkBridgeInFlight,
} from "./agent-activity/bridge-lifecycle.js";
