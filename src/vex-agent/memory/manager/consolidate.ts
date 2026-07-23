/**
 * Per-candidate consolidation orchestration (S4 §5 step 3 / §6–§9). For ONE
 * reserved candidate this:
 *   1. derefs evidence anchors (existence + OD-3 soft-delete + recurrence) and
 *      runs the deterministic stage (D1–D11) using the candidate's embedding to
 *      pull near-dup/conflict matches from active knowledge.
 *   2. on a deterministic terminal → that plan; on escalate → calls the judge
 *      and maps the verdict to a plan (the judge owns every promotion).
 *   3. applies the plan ATOMICALLY: ONE transaction does the owner-check
 *      (claim-lost → throw BEFORE any knowledge write), applyDecision, and
 *      recordDecision; the item is closed (markItemDone) AFTER commit.
 *
 * Idempotent-close (R2#2): a candidate that is already non-pending (its decision
 * committed on a prior attempt but markItemDone failed) is NOT re-judged — the
 * caller looks up the latest decision and closes the item with it (no double
 * promote). That path lives in the executor; this module owns the decision +
 * atomic apply for a PENDING candidate.
 *
 * IO is injectable (`ConsolidateDeps`) so the decision pipeline is unit-testable
 * with stubbed recall / deref / judge.
 */

import type { PoolClient } from "pg";

import { withTransaction, queryOneWith } from "@vex-agent/db/client.js";
import {
  getCandidateById,
  getCandidateEmbedding,
  type MemoryCandidate,
  type MemoryCandidateRecall,
} from "@vex-agent/db/repos/memory-candidates/index.js";
import { recordDecision } from "@vex-agent/db/repos/memory-decisions/index.js";
import { recallLongMemoryTopK } from "@vex-agent/db/repos/knowledge/recall.js";
import {
  recallCandidatesTopK,
  updateCandidateOutcome,
} from "@vex-agent/db/repos/memory-candidates/index.js";
import type { KnownKind } from "@vex-agent/db/repos/knowledge.js";
import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";
import * as executionsRepo from "@vex-agent/db/repos/executions.js";
import { isSessionSoftDeleted } from "@vex-agent/db/repos/sessions.js";
import { computeContentHash } from "@vex-agent/knowledge/content-hash.js";
import { scanLiveState } from "@vex-agent/memory/exclusion-rules.js";
import { redact } from "@vex-agent/memory/redaction.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import type { CandidateEvidenceStrength } from "@vex-agent/memory/schema/memory-candidate-enums.js";
import type { MemoryOutcomeSummary } from "@vex-agent/memory/schema/memory-outcome.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import {
  JUDGE_CANDIDATE_EXCERPT_CHARS,
  JUDGE_ENTRY_EXCERPT_CHARS,
  JUDGE_KNOWN_KINDS_LIMIT,
  JUDGE_SIMILAR_CANDIDATES_MAX,
  LIVE_STATE_RESCAN_REJECT_FRACTION,
  RECURRENCE_CLUSTER_COSINE,
} from "@vex-agent/engine/memory-manager/policy.js";

import {
  runDeterministicStage,
  type DeterministicVerdict,
  type EscalationSignals,
  type KnowledgeMatch,
} from "./deterministic-stage.js";
import {
  derefAnchorExistence,
  countRecurrence,
  deriveEvidenceStrengthCeiling,
} from "./evidence-deref.js";
import {
  deriveDecisionBoundary,
  checkNoLookahead,
  type ExecTimeDeref,
} from "./point-in-time.js";
import { isTradeKind } from "./kind-families.js";
import {
  buildJudgeContext,
  truncateChars,
  type JudgeContextExtras,
  type JudgeSimilarCandidate,
} from "./context-builder.js";
import { callJudge, type JudgeProvider } from "./judge.js";
import type { JudgeVerdict } from "./judge-schema.js";
import { applyDecision, type DecisionPlan } from "./promote.js";
import { reinforceEntry, defaultMaturityDeps, type MaturityDeps } from "./maturity.js";
import { findActiveByContentHash } from "@vex-agent/db/repos/knowledge/crud.js";
import { invalidateEdgesForOrigin } from "@vex-agent/db/repos/memory-edges/index.js";
import {
  applyGraphPlan,
  buildGraphPlan,
  defaultGraphPlanDeps,
  type GraphPlan,
} from "./entity-extraction.js";

// ── Injectable IO ───────────────────────────────────────────────────

export interface ConsolidateDeps {
  /** Top-K active knowledge near-dup/conflict matches for the candidate vector. */
  recallKnowledge: (
    embedding: readonly number[],
    model: string,
    dim: number,
    k: number,
  ) => Promise<KnowledgeMatch[]>;
  /**
   * Similar pending/retained candidates by vector. ONE recall feeds BOTH the
   * D7 recurrence cluster (evidence refs of rows at cosine ≥
   * RECURRENCE_CLUSTER_COSINE — unchanged semantics) and the judge's
   * soft-context list (Judge Context v2).
   */
  recallSimilarCandidates: (
    embedding: readonly number[],
    model: string,
    dim: number,
    k: number,
  ) => Promise<MemoryCandidateRecall[]>;
  /** Active-kind census for the judge prompt (Judge Context v2, §10.6). */
  listActiveKindCounts: () => Promise<KnownKind[]>;
  /** Exact content-hash duplicate present in knowledge_entries. */
  exactDuplicateExists: (contentHash: string) => Promise<boolean>;
  /** Execution anchor → its session (or null if the execution no longer exists). */
  getExecutionSession: (executionId: number) => Promise<{ sessionId: string | null } | null>;
  /** OD-3 — session soft-deleted. */
  isSessionSoftDeleted: (sessionId: string) => Promise<boolean>;
  /** The LLM judge (stubbed in tests). `extras` is the Judge Context v2 pack. */
  judge: (
    candidate: MemoryCandidate,
    signals: EscalationSignals,
    extras: JudgeContextExtras,
  ) => Promise<{ verdict: JudgeVerdict; llmCalls: number; costUsd: number | null }>;
  /** An anchor execution's created_at (drives the as-of decision boundary). */
  getExecutionTime: ExecTimeDeref;
  /**
   * S8 — build the graph write-plan for a promote/supersede verdict (F1: the
   * SECOND LLM call happens ONLY here, pre-tx). FAIL-OPEN by contract: any
   * extraction/embedding error yields `null` and the promotion proceeds
   * without a graph. Injected so the decision pipeline is testable without
   * the extractor LLM or the embeddings sidecar.
   */
  buildGraphPlan: (
    candidate: MemoryCandidate,
    plan: { regimeTags: readonly string[] },
  ) => Promise<GraphPlan | null>;
  /** Inference identity recorded on a decision. */
  inferenceProvider: string | null;
  inferenceModel: string | null;
}

// ── Default deps (production wiring) ────────────────────────────────

const NEAR_DUP_K = 8;
const CLUSTER_K = 16;

export function defaultConsolidateDeps(
  makeProvider?: () => Promise<JudgeProvider>,
): ConsolidateDeps {
  return {
    recallKnowledge: async (embedding, model, dim, k) => {
      const rows = await recallLongMemoryTopK(embedding, {
        embeddingModel: model,
        embeddingDim: dim,
        includeExpired: false,
      }, k);
      return rows
        .filter((r) => r.status === "active")
        .map((r) => ({
          knowledgeId: r.id,
          kind: r.kind,
          similarity: r.similarity,
          // `text` stays EXACTLY title+summary — the Graphiti number/date
          // guardrail (differsOnNumberOrDate) keys off it.
          text: `${r.title}\n${r.summary}`,
          // Judge Context v2 metadata (optional; deterministic rules ignore it).
          source: r.source,
          maturityState: r.maturityState,
          activationStrength: r.activationStrength,
          // Redact BEFORE truncating — stored text is already redacted, but the
          // excerpt must never widen exposure (defense-in-depth).
          contentExcerpt: truncateChars(redact(r.contentMd).text, JUDGE_ENTRY_EXCERPT_CHARS),
        }));
    },
    recallSimilarCandidates: (embedding, model, dim, k) =>
      recallCandidatesTopK(embedding, { embeddingModel: model, embeddingDim: dim }, k),
    listActiveKindCounts: () => knowledgeRepo.listActiveKindCounts(JUDGE_KNOWN_KINDS_LIMIT),
    exactDuplicateExists: async (contentHash) => {
      const existing = await knowledgeRepo.findByContentHash(contentHash);
      return existing !== null;
    },
    getExecutionSession: async (executionId) => {
      const exec = await executionsRepo.getById(executionId);
      return exec ? { sessionId: exec.sessionId } : null;
    },
    isSessionSoftDeleted,
    judge: async (candidate, signals, extras) => {
      const ctx = await buildJudgeContext(candidate, signals, extras);
      return callJudge(ctx, makeProvider);
    },
    getExecutionTime: async (executionId) => {
      const exec = await executionsRepo.getById(executionId);
      return exec ? { createdAt: exec.createdAt } : null;
    },
    buildGraphPlan: (candidate, plan) =>
      buildGraphPlan(candidate, plan, defaultGraphPlanDeps(makeProvider)),
    inferenceProvider: "openrouter",
    inferenceModel: process.env.AGENT_MODEL ?? null,
  };
}

// ── Verdict → plan mapping ──────────────────────────────────────────

/**
 * Hard cap the judge's provenance tier by the deterministic grounding ceiling
 * (§6 / D-GROUND): the LLM may NEVER claim a stronger `source` than the evidence
 * supports — promptly-instructed calibration is NOT runtime-safe on its own
 * (memory-poisoning threat model). `user_confirmed` is EXEMPT: it is grounded by
 * an explicit user affirmation in the transcript (the human is the verifier), not
 * by an execution anchor, so the evidence-strength ceiling does not apply to it.
 *
 *   ceiling 'none'     → max 'hypothesis'
 *   ceiling 'weak'     → max 'inferred'
 *   ceiling 'moderate' → max 'observed'   (S4 never derives 'strong'; → 'observed')
 *
 * The clamp only LOWERS — a judge tier already at/under the cap is unchanged.
 */
const EVIDENCE_SOURCE_RANK: Record<Exclude<KnowledgeSource, "user_confirmed">, number> = {
  hypothesis: 0,
  inferred: 1,
  observed: 2,
};

function maxTierForCeiling(
  ceiling: CandidateEvidenceStrength,
): Exclude<KnowledgeSource, "user_confirmed"> {
  switch (ceiling) {
    case "none":
      return "hypothesis";
    case "weak":
      return "inferred";
    case "moderate":
    case "strong":
      return "observed";
    default: {
      const _exhaustive: never = ceiling;
      return _exhaustive;
    }
  }
}

export function clampSourceTier(
  tier: KnowledgeSource,
  ceiling: CandidateEvidenceStrength,
): KnowledgeSource {
  if (tier === "user_confirmed") return "user_confirmed"; // D-GROUND: human is the verifier.
  const cap = maxTierForCeiling(ceiling);
  return EVIDENCE_SOURCE_RANK[tier] <= EVIDENCE_SOURCE_RANK[cap] ? tier : cap;
}

/**
 * Map a judge verdict + the deterministic conflict target onto a `DecisionPlan`.
 * A `supersede` verdict REQUIRES a conflict target — the judge's
 * `previousKnowledgeId` (schema-required) is preferred, falling back to the
 * deterministic conflict id; if neither is present the supersede is downgraded to
 * a retain (never a blind supersede of an unknown predecessor). The judge's
 * `sourceTier` is HARD-CLAMPED to the grounding ceiling before it reaches the plan.
 */
function planFromVerdict(
  verdict: JudgeVerdict,
  conflictKnowledgeId: number | null,
  evidenceStrengthCeiling: CandidateEvidenceStrength,
  inference: { provider: string | null; model: string | null; costUsd: number | null },
): DecisionPlan {
  const inf = {
    inferenceProvider: inference.provider,
    inferenceModel: inference.model,
    costUsd: inference.costUsd,
  };
  const sourceTier = clampSourceTier(verdict.sourceTier, evidenceStrengthCeiling);
  // S6b F2: tags are vocabulary-validated by the verdict schema; dedupe here is
  // CANONICALIZATION (a repeated valid tag is LLM noise, not an error) so the
  // promoted entry never carries duplicates.
  const regimeTags = Array.from(new Set(verdict.regimeTags));
  switch (verdict.verdict) {
    case "promote":
      return {
        type: "promote",
        sourceTier,
        regimeTags,
        ...inf,
      };
    case "supersede": {
      const previousKnowledgeId = verdict.previousKnowledgeId ?? conflictKnowledgeId;
      if (previousKnowledgeId === null || previousKnowledgeId === undefined) {
        return { type: "retain", ...inf };
      }
      return {
        type: "supersede",
        previousKnowledgeId,
        sourceTier,
        regimeTags,
        ...inf,
      };
    }
    case "retain":
      return { type: "retain", ...inf };
    case "reject":
      return { type: "reject", reason: verdict.rejectReason ?? "insufficient_evidence" };
    case "expire":
      return { type: "expire", reason: verdict.rejectReason ?? "expired_ttl" };
    default: {
      const _exhaustive: never = verdict.verdict;
      return _exhaustive;
    }
  }
}

function planFromDeterministic(v: Extract<DeterministicVerdict, { kind: "reject" | "expire" | "retain" }>): DecisionPlan {
  if (v.kind === "retain") return { type: "retain" };
  if (v.kind === "reject") return { type: "reject", reason: v.reason };
  return { type: "expire", reason: v.reason };
}

// ── consolidateCandidate (deterministic + judge → plan) ─────────────

/**
 * S6a reinforcement seam: a candidate that is a duplicate of an ACTIVE knowledge
 * entry is a 2nd confirmation → reinforce that entry (recurrence; D-MATURE)
 * instead of dropping the candidate silently. The target is resolved in the
 * atomic apply tx (so the read + reinforce + decision are atomic):
 *   - `{ kind: "entry"; knowledgeId }` — D5 near-dup carried the matched id.
 *   - `{ kind: "contentHash"; contentHash }` — D4 exact-dup; the active entry is
 *     looked up by content-hash in the tx (`findActiveByContentHash`).
 * Absent on every non-duplicate decision.
 */
export type ReinforcementTarget =
  | { kind: "entry"; knowledgeId: number }
  | { kind: "contentHash"; contentHash: string };

export interface CandidateDecision {
  plan: DecisionPlan;
  llmCalls: number;
  costUsd: number | null;
  /**
   * The stored outcome for a trade-family candidate — always the neutral
   * `none`/`open` placeholder shape (null for non-trade kinds). Ledger-derived
   * outcome grading was retired this phase (Agent Scan W4: `outcome-resolver.ts`
   * deleted); a later phase injects the session's own transaction list into the
   * judge instead of re-deriving PnL facts here. Carried to the atomic apply so
   * `updateCandidateOutcome` writes it in the SAME tx as the decision (D-ORDER).
   */
  outcome: MemoryOutcomeSummary | null;
  /** S5 — the as-of decision boundary stamped on `available_at_decision_time`. */
  availableAtDecisionTime: Date | null;
  /**
   * S6a — when the decision is a `duplicate` reject of an active entry, the
   * reinforcement target. The atomic apply reinforces it (2nd confirmation) in the
   * SAME tx as the decision. Null for every non-reinforcing decision.
   */
  reinforce: ReinforcementTarget | null;
  /**
   * S8 — the pre-built graph write-plan for a promote/supersede plan (F1; built
   * PRE-TX so the LLM never holds locks). Null on every non-promoting plan AND
   * whenever extraction failed open — the atomic apply skips the graph then.
   */
  graphPlan: GraphPlan | null;
}

/**
 * Decide ONE pending candidate: deref evidence, run the deterministic stage, and
 * (on escalate) the judge. Returns the resolved plan + LLM telemetry. Does NOT
 * write anything — the atomic apply is a separate step (`applyDecisionAtomically`)
 * so the owner-check + write happen in one transaction.
 */
export async function consolidateCandidate(
  candidate: MemoryCandidate,
  embedding: { embedding: number[]; embeddingModel: string; embeddingDim: number },
  deps: ConsolidateDeps,
): Promise<CandidateDecision> {
  // Live-state re-scan (D1) on the redacted aggregate (incl. entities/tags).
  const aggregate = [
    candidate.title,
    candidate.summary,
    candidate.contentMd,
    ...candidate.entities,
    ...candidate.tags,
  ].join("\n");
  const liveStateRejected =
    scanLiveState(aggregate).liveFraction >= LIVE_STATE_RESCAN_REJECT_FRACTION;

  // Evidence deref (D2/D3 + recurrence D7).
  const anchorRes = await derefAnchorExistence(candidate.evidenceRefs, {
    getExecutionSession: deps.getExecutionSession,
    isSessionSoftDeleted: deps.isSessionSoftDeleted,
  });

  // ONE candidate recall feeds BOTH the D7 recurrence cluster (cosine filter
  // unchanged) and the judge's soft-context list (built lazily on escalate).
  const similarRecalls = await deps.recallSimilarCandidates(
    embedding.embedding,
    embedding.embeddingModel,
    embedding.embeddingDim,
    CLUSTER_K,
  );
  const clusterAnchors = similarRecalls
    .filter((r) => r.similarity >= RECURRENCE_CLUSTER_COSINE)
    .map((r) => r.evidenceRefs);
  const recurrenceCount = countRecurrence(candidate.evidenceRefs, clusterAnchors);

  // ── Decision boundary BEFORE the deterministic stage / judge (D-ORDER) ──
  // For trade-family candidates ONLY, derive the as-of / no-lookahead boundary
  // (bi-temporal audit — unrelated to ledger PnL grading, so it survives the
  // outcome-resolver retirement below unchanged). Non-trade kinds skip this
  // entirely (S4 leaves them at the anchor/recurrence ceiling).
  const tradeFamily = isTradeKind(candidate.kind);
  let outcome: MemoryOutcomeSummary | null = null;
  let availableAtDecisionTime: Date | null = null;
  if (tradeFamily) {
    availableAtDecisionTime = await deriveDecisionBoundary(candidate, {
      getExecutionTime: deps.getExecutionTime,
    });
    const pointInTimeChecked = checkNoLookahead(availableAtDecisionTime);
    // Ledger-derived outcome grading is retired this phase (Agent Scan W4:
    // outcome-resolver.ts deleted; a later phase injects the session's own
    // transaction list into the judge instead of re-deriving PnL facts from
    // the ledger here — do NOT resurrect a ledger read in this module). Every
    // trade-family candidate now carries this neutral placeholder — the same
    // "thin/uncovered venue" shape the old resolver used for honest
    // no-information cases — so the evidence ceiling can never reach 'strong'
    // through this path (deriveEvidenceStrengthCeiling requires a
    // closed/settled status, which this placeholder never carries).
    outcome = {
      status: "open",
      lessonSignal: "neutral",
      evidenceQuality: "weak",
      pointInTimeChecked,
      outcomeComputedBy: "memory_manager",
      outcomeVersion: 0,
      pnlSource: "none",
    };
    memLog("manager", "outcome_ungraded", { candidateId: candidate.id });
  }

  const evidenceStrengthCeiling = deriveEvidenceStrengthCeiling({
    anchorExists: anchorRes.anchorExists,
    recurrenceCount,
    outcome,
    isTradeKind: tradeFamily,
  });

  // Near-dup / conflict / exact-dup signals (D4/D5/D6).
  const contentHash = computeContentHash({
    kind: candidate.kind,
    title: candidate.title,
    summary: candidate.summary,
    contentMd: candidate.contentMd,
  });
  const exactDuplicate = await deps.exactDuplicateExists(contentHash);
  const knowledgeMatches = await deps.recallKnowledge(
    embedding.embedding,
    embedding.embeddingModel,
    embedding.embeddingDim,
    NEAR_DUP_K,
  );

  const verdict = runDeterministicStage({
    candidate,
    liveStateRejected,
    evidenceSoftDeleted: anchorRes.softDeleted,
    anchorExists: anchorRes.anchorExists,
    evidenceStrengthCeiling,
    exactDuplicate,
    knowledgeMatches,
    recurrenceCount,
    isUserAffirmed: false, // refined by the transcript in the judge context
  });

  if (verdict.kind !== "escalate") {
    // S6a reinforcement seam: a `duplicate` reject means the candidate confirms an
    // existing ACTIVE entry (a 2nd confirmation; D-MATURE). Resolve the target so
    // the atomic apply can reinforce it — D5 near-dup carried the matched id; D4
    // exact-dup resolves the active entry by content-hash in the tx.
    const reinforce = reinforcementTargetFor(verdict, exactDuplicate, contentHash);
    return {
      plan: planFromDeterministic(verdict),
      llmCalls: 0,
      costUsd: null,
      outcome,
      availableAtDecisionTime,
      reinforce,
      // Deterministic terminals never promote — no extraction (F1: zero cost).
      graphPlan: null,
    };
  }

  // Escalate → the judge owns the promotion decision. The Judge Context v2
  // extras (kind census + soft context) are fetched/built ONLY here so
  // deterministic terminals stay zero-extra-cost.
  const knownKinds = await deps.listActiveKindCounts();
  const similarCandidates: JudgeSimilarCandidate[] = similarRecalls
    .filter((r) => r.id !== candidate.id)
    .slice(0, JUDGE_SIMILAR_CANDIDATES_MAX)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      // Redact BEFORE truncating (defense-in-depth, same as contentExcerpt).
      titleExcerpt: truncateChars(redact(r.title).text, JUDGE_CANDIDATE_EXCERPT_CHARS),
      summaryExcerpt: truncateChars(redact(r.summary).text, JUDGE_CANDIDATE_EXCERPT_CHARS),
      similarity: r.similarity,
      source: r.source,
    }));
  const extras: JudgeContextExtras = { knownKinds, similarCandidates };
  const judged = await deps.judge(candidate, verdict.signals, extras);
  const plan = planFromVerdict(
    judged.verdict,
    verdict.signals.conflictKnowledgeId,
    verdict.signals.evidenceStrengthCeiling,
    {
      provider: deps.inferenceProvider,
      model: deps.inferenceModel,
      costUsd: judged.costUsd,
    },
  );
  // S8 seam (F1): the verdict resolved to promote/supersede → ONE extraction
  // call PRE-TX (D-ORDER — the LLM never holds locks). Fail-open by contract:
  // a null plan means the lesson promotes WITHOUT a graph.
  const graphPlan =
    plan.type === "promote" || plan.type === "supersede"
      ? await deps.buildGraphPlan(candidate, { regimeTags: plan.regimeTags })
      : null;

  return {
    plan,
    llmCalls: judged.llmCalls,
    costUsd: judged.costUsd,
    outcome,
    availableAtDecisionTime,
    // The judge path never produces a deterministic `duplicate` — escalation
    // means D4/D5 did NOT fire, so there is no reinforcement target here.
    reinforce: null,
    graphPlan,
  };
}

/**
 * Resolve the S6a reinforcement target from a deterministic verdict (§8). A
 * `duplicate` reject is a 2nd confirmation of an existing ACTIVE entry:
 *   - D5 near-dup carried the matched id → reinforce that entry directly.
 *   - D4 exact content-hash dup (`exactDuplicate`) → reinforce the active entry
 *     that owns this content-hash (resolved in the tx by `findActiveByContentHash`).
 * Every non-duplicate verdict (and a non-reject) yields null.
 */
function reinforcementTargetFor(
  verdict: DeterministicVerdict,
  exactDuplicate: boolean,
  contentHash: string,
): ReinforcementTarget | null {
  if (verdict.kind !== "reject" || verdict.reason !== "duplicate") return null;
  if (verdict.reinforcesKnowledgeId !== undefined) {
    return { kind: "entry", knowledgeId: verdict.reinforcesKnowledgeId };
  }
  if (exactDuplicate) return { kind: "contentHash", contentHash };
  return null;
}

// ── applyDecisionAtomically (owner-check + apply + record, one tx) ──

export interface AtomicApplyResult {
  decisionId: string;
  decisionType: DecisionPlan["type"];
}

/**
 * Owner-check (R1#2) + outcome write + applyDecision + S8 graph writes +
 * recordDecision in ONE transaction (FIX-4 §8 / S8 D-WRITE). The
 * owner-check `SELECT … FOR UPDATE OF i,j` proves this worker still holds the
 * item BEFORE any write; a lost claim THROWS before any mutation. For a
 * trade-family candidate, `updateCandidateOutcome` persists the (now neutral
 * placeholder — see `consolidateCandidate`) outcome + as-of boundary BEFORE
 * promote, and the boundary becomes the promoted entry's `valid_from` with an
 * explicit `outcome_version=0` init.
 *
 * S8 graph writes run AFTER `applyDecision` (the promoted entry id comes from
 * `decisionInput.promotedKnowledgeId`) and BEFORE `recordDecision`, inside
 * `SAVEPOINT graph_plan` (D-SAVEPOINT): an in-tx graph error rolls back ONLY
 * the graph writes — the promotion commits without a graph (fail-open closed
 * end-to-end). A supersede additionally retracts the PREDECESSOR's edges in
 * the same savepoint-protected region (D-SUPERSEDE-WIRING).
 *
 * recordDecision re-locks the same rows in the SAME tx (no deadlock). The item
 * is closed (markItemDone) by the caller AFTER commit.
 */
export async function applyDecisionAtomically(args: {
  candidate: MemoryCandidate;
  plan: DecisionPlan;
  jobId: number;
  workerId: string;
  /** The candidate's outcome (the neutral placeholder for trade-family kinds; null otherwise). */
  outcome?: MemoryOutcomeSummary | null;
  /** As-of decision boundary → candidate.available_at_decision_time + valid_from. */
  availableAtDecisionTime?: Date | null;
  /** S6a — reinforce the active entry this duplicate confirms (2nd confirmation). */
  reinforce?: ReinforcementTarget | null;
  /** S6a — injectable maturity IO (tests stub the reinforce path). */
  maturityDeps?: MaturityDeps;
  /** S8 — pre-built graph plan (null → promotion without graph; fail-open). */
  graphPlan?: GraphPlan | null;
  client?: PoolClient;
}): Promise<AtomicApplyResult> {
  const outcome = args.outcome ?? null;
  const boundary = args.availableAtDecisionTime ?? null;
  const reinforce = args.reinforce ?? null;
  const maturityDeps = args.maturityDeps ?? defaultMaturityDeps();
  const graphPlan = args.graphPlan ?? null;

  const run = async (tx: PoolClient): Promise<AtomicApplyResult> => {
    // Owner-check: the item must still be `processing`, the job `running` and
    // locked by THIS worker. Lock both rows so recoverStaleRunning cannot release
    // the item / reset the job between this check and the writes.
    const owner = await queryOneWith<{ ok: number }>(
      tx,
      `SELECT 1 AS ok
         FROM memory_job_items i
         JOIN memory_jobs j ON j.id = i.job_id
        WHERE i.job_id = $1 AND i.candidate_id = $2
          AND i.item_status = 'processing'
          AND j.status = 'running' AND j.locked_by = $3
        FOR UPDATE OF i, j`,
      [args.jobId, args.candidate.id, args.workerId],
    );
    if (!owner) {
      throw new ClaimLostError(args.candidate.id, args.jobId);
    }

    // Persist the outcome (the neutral placeholder for trade-family kinds) +
    // as-of boundary on the candidate BEFORE promote, in the SAME tx
    // (owner-check already locked item+job).
    if (outcome) {
      const upd = await updateCandidateOutcome(args.candidate.id, outcome, boundary, tx);
      if (!upd.ok) {
        throw new Error(
          `applyDecisionAtomically: updateCandidateOutcome failed (${upd.reason}) for candidate ${args.candidate.id}`,
        );
      }
    }

    const applied = await applyDecision(args.candidate, args.plan, args.jobId, tx, {
      // Trade-family promotions carry the world-time validity boundary + the
      // outcome_version init. Non-trade paths pass nothing (byte-neutral).
      validFrom: outcome ? boundary : null,
      outcomeVersion: outcome ? 0 : undefined,
    });

    // ── S8 graph writes (D-WRITE / D-SAVEPOINT / D-SUPERSEDE-WIRING) ──
    // The promoted entry id rides in decisionInput.promotedKnowledgeId (a
    // promote that degraded to a reject — redaction anomaly — carries none →
    // graph skipped). Wrapped in a SAVEPOINT so an in-tx graph error NEVER
    // takes the promotion down with it.
    const promotedEntryId = applied.decisionInput.promotedKnowledgeId ?? null;
    const predecessorId = args.plan.type === "supersede" ? args.plan.previousKnowledgeId : null;
    if ((graphPlan !== null && promotedEntryId !== null) || predecessorId !== null) {
      await applyGraphWritesFailOpen(
        {
          candidateId: args.candidate.id,
          graphPlan: promotedEntryId !== null ? graphPlan : null,
          entryId: promotedEntryId,
          predecessorId,
        },
        tx,
      );
    }

    const recorded = await recordDecision(applied.decisionInput, tx);
    if (!recorded.ok) {
      throw new Error(
        `applyDecisionAtomically: recordDecision failed (${recorded.reason}) for candidate ${args.candidate.id}`,
      );
    }

    // S6a reinforcement seam (§8): a `duplicate` reject means this candidate is a
    // 2nd real confirmation of an existing ACTIVE entry. Reinforce that entry
    // (activation↑, maturity advance / decayed→established reactivation; audited)
    // in the SAME tx. Resolved here (not in consolidate) so the read + reinforce
    // are atomic with the decision. A target that no longer resolves (the entry
    // was superseded / archived between recall and apply) is a benign no-op — the
    // candidate is still recorded as a duplicate reject.
    if (reinforce && args.plan.type === "reject") {
      await applyReinforcement(reinforce, args.candidate.id, tx, maturityDeps);
    }

    return { decisionId: recorded.decision.id, decisionType: args.plan.type };
  };

  return args.client ? run(args.client) : withTransaction(run);
}

/**
 * Resolve a reinforcement target to a concrete entry id and reinforce it in the
 * tx (S6a §8). The `candidateId` rides along as the structural `trigger_ref` so
 * the audit row links the reinforcement to its confirming candidate. A
 * content-hash target that no longer resolves to an ACTIVE entry is a benign
 * no-op (the active row was superseded/archived between recall and apply).
 */
async function applyReinforcement(
  target: ReinforcementTarget,
  candidateId: string,
  tx: PoolClient,
  maturityDeps: MaturityDeps,
): Promise<void> {
  let knowledgeId: number | null;
  if (target.kind === "entry") {
    knowledgeId = target.knowledgeId;
  } else {
    const entry = await findActiveByContentHash(target.contentHash, tx);
    knowledgeId = entry?.id ?? null;
  }
  if (knowledgeId === null) return;
  await reinforceEntry(knowledgeId, { candidateId }, tx, maturityDeps);
}

/**
 * S8 graph writes under `SAVEPOINT graph_plan` (D-SAVEPOINT). Order inside the
 * savepoint:
 *   1. supersede only — retract the PREDECESSOR's edges
 *      (`invalidateEdgesForOrigin`; D-SUPERSEDE-WIRING — edges are claims of
 *      their origin lesson; the successor gets a fresh extraction). Entry↔entity
 *      links of the predecessor STAY (historical record; expansion filters on
 *      `ke.status='active'`).
 *   2. `applyGraphPlan` — entities / aliases / links / edges for the NEW entry.
 *
 * Any error → `ROLLBACK TO SAVEPOINT graph_plan` + audited warn + the promotion
 * CONTINUES (commits without a graph). Pre-validation (Zod / enum / dim) makes
 * an in-tx failure an anomaly — the savepoint is a seatbelt, not an expected
 * path. The SAVEPOINT statement itself sits OUTSIDE the try: if even that
 * fails, the connection is broken and the whole tx is doomed regardless.
 */
async function applyGraphWritesFailOpen(
  args: {
    candidateId: string;
    graphPlan: GraphPlan | null;
    entryId: number | null;
    predecessorId: number | null;
  },
  tx: PoolClient,
): Promise<void> {
  await tx.query("SAVEPOINT graph_plan");
  try {
    if (args.predecessorId !== null) {
      // Count is logged by the repo (memory.edge.origin_invalidated).
      await invalidateEdgesForOrigin(args.predecessorId, tx);
    }
    if (args.graphPlan !== null && args.entryId !== null) {
      const counts = await applyGraphPlan(args.graphPlan, args.entryId, tx);
      memLog("manager", "graph_extracted", {
        candidateId: args.candidateId,
        promotedKnowledgeId: args.entryId,
        entityCount: counts.entityCount,
        edgeCount: counts.edgeCount,
        linkCount: counts.linkCount,
      });
    }
    await tx.query("RELEASE SAVEPOINT graph_plan");
  } catch {
    // Fail-open: only the graph writes roll back; the promotion proceeds.
    await tx.query("ROLLBACK TO SAVEPOINT graph_plan");
    memLog.warn("manager", "graph_extraction_failed", {
      candidateId: args.candidateId,
      errorCode: "graph_apply_error",
    });
  }
}

/** Thrown when the owner-check fails — the worker lost the claim. */
export class ClaimLostError extends Error {
  constructor(public readonly candidateId: string, public readonly jobId: number) {
    super(`claim lost for candidate ${candidateId} (job ${jobId})`);
    this.name = "ClaimLostError";
  }
}

// ── Convenience re-exports for the executor ─────────────────────────

export { getCandidateById, getCandidateEmbedding };
