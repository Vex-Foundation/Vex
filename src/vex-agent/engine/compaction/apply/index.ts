/**
 * Compaction APPLY — public gate.
 *
 * Explicit named exports only. The cutover's internals (the locked transaction,
 * the FSM release edges) are deliberately unreachable from outside: every
 * caller enters through one of exactly three doors.
 *
 *   `requestApply`                — queue a cutover (UI button, agent tool,
 *                                   Full-Autonomous policy). Never cuts over.
 *   `consumeApplyRequest` /
 *   `createCompactionApplyAction` — the runner consuming a standing request at
 *                                   its iteration boundary.
 *   `forcePreparedApply`          — the critical-band bypass. Exposed here;
 *                                   its call sites belong to the pressure
 *                                   package.
 *
 * `commitPreparation` is exported for the integration tests that must drive Tx
 * B directly against real Postgres; production code reaches it only through the
 * three doors above.
 */

export {
  commitPreparation,
  type ApplyCommitResult,
  type ApplyExecutionMode,
  type CommitPreparationInput,
} from "./commit-preparation.js";

export {
  requestApply,
  type RequestApplyInput,
  type RequestApplyOutcome,
  type RequestApplySource,
} from "./request-apply.js";

export {
  consumeApplyRequest,
  createCompactionApplyAction,
  forcePreparedApply,
  type ConsumeApplyInput,
  type ConsumeApplyOutcome,
} from "./consume-at-boundary.js";
