/**
 * Agent Scan activity repo — shared row + domain types (migrations
 * `044_agent_activity.sql`, `045_bridge_activity.sql`,
 * `049_agent_activity_solana_vocabulary.sql`).
 *
 * Pure types only. Validation (`assertFailureCode`, `sanitizeFailureReason`)
 * lives in `./validation.js`; row → domain mapping (`mapRow`) lives in
 * `./mappers.js`. Consumed by `./swap.js` (Phase 1), `./bridge.js` (Phase 2,
 * migration 045), and the W5 lend/prediction/Jupiter-swap write paths
 * (migration 049) — this module has no DB or business-logic imports. The
 * Solana synthetic chain id itself lives in `src/constants/solana-chain.js`
 * (W5 design REVISION 1 R1), not here — this module stays pure vocabulary.
 *
 * This file is the public entry point; the definitions live in `./types/`,
 * split by responsibility: `./types/vocabulary.js` (kind/role/chain-family),
 * `./types/status-and-failure.js` (stored status + failure codes),
 * `./types/event-row.js` (the row shape and CAS result), and
 * `./types/verification.js` (the `last_verification_reason` vocabulary and
 * stall thresholds).
 */

export type {
  AgentActivityEventRole,
  AgentActivityGenericKind,
  AgentActivityKind,
  BridgeChainFamily,
} from "./types/vocabulary.js";

export type {
  AgentActivityFailureCode,
  AgentActivityStatus,
} from "./types/status-and-failure.js";
export {
  isFailedActivityStatus,
  isTerminalActivityStatus,
} from "./types/status-and-failure.js";

export type {
  AgentActivityEvent,
  AgentActivityLegInput,
  AgentActivityVexFeeCharge,
  CasResult,
} from "./types/event-row.js";

export type { VerificationReason } from "./types/verification.js";
export {
  isStalledVerification,
  STALL_INCREMENT_MIN_INTERVAL_MS,
  STALLED_VERIFICATION_ATTEMPTS,
  toVerificationReason,
  VERIFICATION_REASONS,
} from "./types/verification.js";
