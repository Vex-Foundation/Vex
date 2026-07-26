/**
 * memory_manager module barrel — INTERNAL use-case functions only (FIX-3).
 *
 * NOTHING here is a ToolDef, and nothing is registered in the tool
 * registry / visibility / tool-map. The async memory_manager worker (S4
 * executor) consumes these functions; the agent never reaches them.
 */

export {
  consolidateCandidate,
  applyDecisionAtomically,
  defaultConsolidateDeps,
  ClaimLostError,
  getCandidateById,
  getCandidateEmbedding,
  type ConsolidateDeps,
  type CandidateDecision,
  type AtomicApplyResult,
  type ReinforcementTarget,
} from "./consolidate.js";

export {
  extractEntities,
  buildGraphPlan,
  applyGraphPlan,
  canonicalizeDollarName,
  defaultGraphPlanDeps,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  type ExtractionLesson,
  type GraphLessonCandidate,
  type GraphPlan,
  type GraphPlanDeps,
  type GraphPlanEntity,
  type GraphPlanLink,
  type GraphPlanEdge,
  type GraphApplyCounts,
} from "./entity-extraction.js";

export {
  entityExtractionSchema,
  EXTRACTION_ENTITIES_MAX,
  EXTRACTION_ENTITY_NAME_MAX,
  EXTRACTION_ALIASES_MAX,
  EXTRACTION_ALIAS_MAX,
  EXTRACTION_SUMMARY_MAX,
  EXTRACTION_EDGES_MAX,
  EXTRACTION_FACT_MAX,
  type EntityExtraction,
  type ExtractedEntity,
  type ExtractedEdge,
} from "./entity-extraction-schema.js";

export {
  reinforceEntry,
  decayEntry,
  defaultMaturityDeps,
  DECAY_AUDIT_MIN_DELTA,
  type MaturityDeps,
  type ReinforceResult,
  type DecayResult,
} from "./maturity.js";

export {
  ACTIVATION_HALF_LIFE_DAYS,
  DECAY_FLOOR,
  REINFORCE_STEP,
  DECAY_TO_DECAYED_THRESHOLD,
  REACTIVATION_ACTIVATION,
  ACTIVATION_MIN_FACTOR,
  ACTIVATION_MIN_FACTOR_PROVEN_BOUND,
  decayedActivation,
  nextStateOnDecay,
  reinforcedActivation,
  nextStateOnReinforce,
  reinforceEventFor,
  activationFactor,
  daysSince,
} from "./maturity-policy.js";

export {
  applyDecision,
  promote,
  supersedeFromCandidate,
  applyTerminal,
  PromoteRedactionAnomalyError,
  type DecisionPlan,
  type ApplyDecisionResult,
} from "./promote.js";

export {
  runDeterministicStage,
  type DeterministicVerdict,
  type DeterministicInput,
  type EscalationSignals,
  type KnowledgeMatch,
} from "./deterministic-stage.js";

export {
  derefAnchorExistence,
  countRecurrence,
  deriveEvidenceStrengthCeiling,
  type AnchorExistenceResult,
  type AnchorDerefDeps,
} from "./evidence-deref.js";

export {
  deriveDecisionBoundary,
  checkNoLookahead,
  type ExecTimeRef,
  type ExecTimeDeref,
} from "./point-in-time.js";

export {
  buildJudgeContext,
  truncateChars,
  type JudgeContext,
  type JudgeContextExtras,
  type JudgeSimilarCandidate,
} from "./context-builder.js";
export { callJudge, type JudgeProvider, type JudgeCallResult } from "./judge.js";
export {
  judgeVerdictSchema,
  type JudgeVerdict,
  type JudgeVerdictType,
  type JudgeRubric,
} from "./judge-schema.js";
export { buildJudgeSystemPrompt, buildJudgeUserPrompt } from "./judge-prompt.js";
export { isGeneralizationKind, isTradeKind } from "./kind-families.js";
