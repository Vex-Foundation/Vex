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

export type {
  MarkActivityBroadcastInput,
  ConfirmActivityEventInput,
  FailActivityEventInput,
  ListActivityFeedOptions,
} from "./agent-activity/swap-lifecycle.js";
export {
  markActivityBroadcast,
  markActivitySolanaBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  abortPlannedEvents,
  touchLastChecked,
  getActivityEventById,
  listPendingOlderThan,
  listSolanaStagedPending,
  listActivityFeed,
  existsForExecutionId,
} from "./agent-activity/swap-lifecycle.js";

// Jupiter Prediction payout settlement (P1 fill-settlement lane): the CAS
// finalizer that merges keeper-settle evidence into a payout row. Its own
// module because its evidence is a DIFFERENT transaction than the row's
// `tx_hash` — see that file's doc. The `prediction_order` provenance payload
// it merges into belongs to the protocol
// (`@tools/.../jupiter-prediction/prediction-order-provenance.ts`), like every
// other route_provenance contract.
export type { JupiterPredictionPayoutSettlementInput } from "./agent-activity/prediction-payout-settlement.js";
export {
  PAYOUT_SETTLEMENT_PROVENANCE_KEY,
  confirmJupiterPredictionPayoutSettlement,
} from "./agent-activity/prediction-payout-settlement.js";

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
  AttachProviderOrderIdOutcome,
  AttachProviderOrderIdResult,
  MarkBridgeLegObservedInput,
  MarkBridgeLegObservedResult,
  BridgeInFlightResult,
} from "./agent-activity/bridge-lifecycle.js";
export {
  attachProviderOrderId,
  confirmBridgeExpectedFill,
  markBridgeLegObserved,
  checkBridgeInFlight,
} from "./agent-activity/bridge-lifecycle.js";
