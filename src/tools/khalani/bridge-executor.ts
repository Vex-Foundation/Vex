/**
 * Khalani bridge executor — STAGED broadcast primitives (Phase-2 R4).
 *
 * The origin deposit + any allowance approvals are Vex-signed, so they follow
 * the full staged discipline the Agent Scan ledger requires: the caller (the
 * `khalani.bridge` handler) creates the `agent_activity` rows FIRST, then drives
 * this module ONE leg at a time — sign locally, hand the caller the computed
 * hash/signature to persist BEFORE it reaches the network, broadcast, then wait a
 * bounded receipt. A crash between sign and send leaves a discoverable pending
 * row, never a silently lost transaction.
 *
 * PUBLIC ENTRY POINT. The implementation lives in `./bridge-executor/`, split by
 * reason-to-change; this file is the stable import surface every caller and test
 * already uses and re-exports ONLY the public contract:
 *
 *   - `./bridge-executor/staged-leg.ts` — the leg MODEL (types + the
 *     native-value call fingerprint both the planner and the signer must agree
 *     on).
 *   - `./bridge-executor/approval-normalization.ts` — pure parsing and
 *     fail-closed validation of Khalani's untrusted `approvals` wire shape.
 *   - `./bridge-executor/deposit-plan.ts` — network-free planning: a
 *     `DepositPlan` becomes the ordered broadcast legs, with the Vex fee leg
 *     APPENDED last so a bridge that never happens never charges a fee.
 *   - `./bridge-executor/leg-signing.ts` — the only module that holds signing
 *     keys: sign → stage → broadcast → bounded receipt, per leg.
 */

export {
  khalaniLegNativeValueCall,
  type KhalaniDepositEvidence,
  type KhalaniLegPurpose,
  type KhalaniLegRole,
  type KhalaniStagedLeg,
  type KhalaniReceiptLog,
  type KhalaniStagedOutcome,
  type KhalaniStageHandles,
  type KhalaniStageHooks,
  type KhalaniVexFeeLeg,
  type NormalizedEvmTx,
} from "./bridge-executor/staged-leg.js";

export { parseBigintish } from "./bridge-executor/approval-normalization.js";

export {
  planKhalaniDepositLegs,
  type KhalaniDepositOriginBinding,
} from "./bridge-executor/deposit-plan.js";

export { signStageKhalaniLeg } from "./bridge-executor/leg-signing.js";
