/**
 * Engine types — pure domain types for the engine layer.
 *
 * No DB imports, no inference imports. These types define the
 * engine's vocabulary: session axes, mission lifecycle, stop
 * conditions, message taxonomy, and context contracts.
 *
 * Public API module. The implementation is split into `./types/` submodules by
 * concern (session axes, mission lifecycle, stop reasons, message taxonomy,
 * mission draft, engine context) because this file passed the 550-line limit.
 * Every consumer keeps importing from here — the submodules are implementation
 * detail and import nothing outside `./types/`.
 */

export type { Permission, SessionKind } from "./types/session.js";
export type {
  MissionRunStatus,
  MissionStatus,
} from "./types/mission-lifecycle.js";
export {
  ACTIVE_OR_PAUSED_RUN_STATUSES,
  ACTIVE_RUN_STATUSES,
  APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES,
  MISSION_RUN_STATUSES,
  MissionRunPausedError,
  PAUSED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "./types/mission-lifecycle.js";
export type {
  BusinessStopReason,
  RuntimeStopReason,
  StopReason,
} from "./types/stop-reasons.js";
export {
  BUSINESS_STOP_REASONS,
  RUNTIME_STOP_REASONS,
  STOP_REASONS,
} from "./types/stop-reasons.js";
export type {
  MessageMetadata,
  MessageSource,
  MessageType,
  MessageVisibility,
} from "./types/messages.js";
export type { MissionDraft, MissionPatch, DeployedCapital } from "./types/mission-draft.js";
export { MISSION_DRAFT_REQUIRED_FIELDS, DEPLOYED_CAPITAL_BOUNDS } from "./types/mission-draft.js";
export type {
  EngineContext,
  ResumedTurnClaim,
  TurnResult,
  WalletPolicy,
} from "./types/engine-context.js";
