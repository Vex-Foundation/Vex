/**
 * Faithful eval-only seeders (Phase 0). NOT a test file (underscore prefix).
 *
 * These drive the PRODUCTION seam — `recordExecution` → `populateCaptureItems`
 * (→ activity-populator → projectors → proj_pnl_lots / proj_pnl_matches /
 * proj_open_positions) — exactly like the live runtime, so downstream ledger
 * reads see REAL ledger rows. They are named `seedFaithful*` so they can never
 * be confused with the raw-SQL legacy seeders in `repos/_s4-fixtures.ts`
 * (those are left untouched).
 *
 * RETIREMENT NOTE (Agent Scan W4): the S5 ledger-derived outcome resolver and
 * the S7 reconcile worker these seeders originally paired with are deleted
 * (`memory/manager/outcome-resolver.ts`, `engine/memory-manager/reconcile.ts`,
 * `memory/ledger-wake.ts`). The reconcile-job-driving helpers that lived here
 * (`driveReconcileForEntry` + its terminal-status types) are removed — their
 * only callers were the eval suites retired in the same change. The plain
 * seeders below (spot/perps/closing-trade/etc.) are untouched and still used
 * by surviving suites.
 *
 * Embeddings: the candidate/knowledge seeders embed title+summary with the REAL
 * Gemma (`embedDocument`) and store the real providerModel + dim 768 — NOT the
 * dim-8 `test-model` fixtures (those would give recall precision 0 against the
 * live providerModel/dim).
 */

import { recordExecution } from "@vex-agent/db/repos/executions.js";
import { populateCaptureItems } from "@vex-agent/tools/protocols/capture-pipeline.js";
import { extractExternalRefs } from "@vex-agent/tools/protocols/capture-pipeline.js";

import { execute, query } from "@vex-agent/db/client.js";
import {
  insertCandidate,
  getCandidateById,
  getCandidateEmbedding,
  type InsertCandidateInput,
} from "@vex-agent/db/repos/memory-candidates/index.js";
import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";
import {
  enqueueConsolidateJob,
  claimNextDueJob,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import {
  reserveCandidatesForJob,
  listItemsByJob,
  markItemProcessing,
  markItemDone,
} from "@vex-agent/db/repos/memory-job-items/index.js";
import {
  consolidateCandidate,
  applyDecisionAtomically,
  defaultConsolidateDeps,
  type ConsolidateDeps,
} from "@vex-agent/memory/manager/index.js";
import type {
  JudgeVerdict,
  JudgeRubric,
  JudgeVerdictType,
} from "@vex-agent/memory/manager/judge-schema.js";
import type { CandidateEvidenceStrength } from "@vex-agent/memory/schema/memory-candidate-enums.js";
import type { MemoryDecisionRejectReason } from "@vex-agent/memory/schema/memory-decision-enums.js";
import type { DecisionPlan } from "@vex-agent/memory/manager/promote.js";
import type { GraphPlan } from "@vex-agent/memory/manager/entity-extraction.js";
import type { MemoryOutcomeSummary } from "@vex-agent/memory/schema/memory-outcome.js";
import {
  bumpJobInference,
  getJobById,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import { getLatestDecision } from "@vex-agent/db/repos/memory-decisions/index.js";
import { embedDocument } from "@vex-agent/embeddings/client.js";
import { computeContentHash } from "@vex-agent/knowledge/content-hash.js";
import { insertEntry } from "@vex-agent/db/repos/knowledge.js";
import { supersedeEntry } from "@vex-agent/db/repos/knowledge-lifecycle.js";
import type { EvidenceRefs } from "@vex-agent/memory/schema/memory-candidate.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import type {
  DecayPolicy,
  InfluenceScope,
  MaturityState,
} from "@vex-agent/memory/schema/long-memory-enums.js";
import { makeSession } from "../setup/fixtures.js";

const NAMESPACE = "solana";
const CHAIN = "solana";

/** Live Gemma dim — must match EMBEDDING_DIM in eval-setup. */
export const GEMMA_DIM = 768;

// ── Faithful confirmed SPOT trade (buy lot → sell match → realized PnL) ──

export interface FaithfulSpotArgs {
  sessionId: string;
  instrumentKey: string;
  walletAddress: string;
  /** Raw integer string of base-asset units bought. */
  buyQtyRaw: string;
  /** Decimal string USD paid (cost basis). */
  buyValueUsd: string;
  /** Raw integer string of base-asset units sold (≤ buyQtyRaw for a full match). */
  sellQtyRaw: string;
  /** Decimal string USD proceeds → drives realized_pnl_usd. */
  sellValueUsd: string;
}

export interface FaithfulSpotResult {
  buyExecutionId: number;
  sellExecutionId: number;
  instrumentKey: string;
  walletAddress: string;
}

/**
 * Drive a real confirmed spot trade through the production capture seam. The buy
 * opens a `proj_pnl_lots` lot; the sell creates a `proj_pnl_matches`
 * `match_kind='matched'` row with non-null `realized_pnl_usd`.
 *
 * Token amounts are RAW INTEGER STRINGS; USD values are DECIMAL STRINGS (numbers
 * would leave the NUMERIC column NULL and break the projector math). The
 * camelCase `tradeSide` is explicit — a bare tool id never derives the side.
 */
export async function seedFaithfulConfirmedSpotTrade(
  args: FaithfulSpotArgs,
): Promise<FaithfulSpotResult> {
  const buyCapture: Record<string, unknown> = {
    type: "swap",
    tradeSide: "buy",
    chain: CHAIN,
    walletAddress: args.walletAddress,
    instrumentKey: args.instrumentKey,
    inputTokenAddress: "So11111111111111111111111111111111111111112", // wSOL (cost asset)
    outputTokenAddress: args.instrumentKey,
    inputAmount: args.buyValueUsd, // not load-bearing for the lot
    outputAmount: args.buyQtyRaw, // raw base units bought → lot quantity
    inputValueUsd: args.buyValueUsd, // cost basis (decimal string)
    outputValueUsd: args.buyValueUsd,
    unitPriceUsd: "0.05",
    valuationSource: "jupiter_exact",
    status: "executed",
  };
  const buyRefs = { instrumentKey: args.instrumentKey };
  const buyExecutionId = await recordExecution(
    "solana.swap.execute",
    NAMESPACE,
    args.sessionId,
    { side: "buy" },
    { signature: `buy-${args.instrumentKey}` },
    true,
    buyCapture,
    extractExternalRefs({ _tradeCapture: buyCapture, ...buyRefs }),
    100,
  );
  await populateCaptureItems(
    buyExecutionId,
    "solana.swap.execute",
    NAMESPACE,
    buyCapture,
    undefined,
    extractExternalRefs({ _tradeCapture: buyCapture, ...buyRefs }),
  );

  const sellCapture: Record<string, unknown> = {
    type: "swap",
    tradeSide: "sell",
    chain: CHAIN,
    walletAddress: args.walletAddress,
    instrumentKey: args.instrumentKey,
    inputTokenAddress: args.instrumentKey,
    outputTokenAddress: "So11111111111111111111111111111111111111112",
    inputAmount: args.sellQtyRaw, // raw base units to sell → FIFO match qty
    outputAmount: args.sellValueUsd,
    inputValueUsd: args.sellValueUsd,
    outputValueUsd: args.sellValueUsd, // total proceeds → realized_pnl_usd
    unitPriceUsd: "0.06",
    valuationSource: "jupiter_exact",
    status: "executed",
  };
  const sellRefs = { instrumentKey: args.instrumentKey };
  const sellExecutionId = await recordExecution(
    "solana.swap.execute",
    NAMESPACE,
    args.sessionId,
    { side: "sell" },
    { signature: `sell-${args.instrumentKey}` },
    true,
    sellCapture,
    extractExternalRefs({ _tradeCapture: sellCapture, ...sellRefs }),
    100,
  );
  await populateCaptureItems(
    sellExecutionId,
    "solana.swap.execute",
    NAMESPACE,
    sellCapture,
    undefined,
    extractExternalRefs({ _tradeCapture: sellCapture, ...sellRefs }),
  );

  return {
    buyExecutionId,
    sellExecutionId,
    instrumentKey: args.instrumentKey,
    walletAddress: args.walletAddress,
  };
}

/** Probe the live projector: did a matched, realized row land for this instrument? */
export async function countMatchedRealized(
  instrumentKey: string,
  walletAddress: string,
): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM proj_pnl_matches
       WHERE instrument_key = $1 AND wallet_address = $2
         AND match_kind = 'matched' AND realized_pnl_usd IS NOT NULL`,
    [instrumentKey, walletAddress],
  );
  return Number(rows[0]!.n);
}

// ── Faithful CLOSED perps position (open → close → signed MTM) ──────

export interface FaithfulPerpsArgs {
  sessionId: string;
  positionKey: string;
  instrumentKey: string;
  walletAddress: string;
  /** Decimal string. Signed MTM written AFTER close (medium-quality outcome). */
  closedPnlUsd: string;
}

export interface FaithfulPerpsResult {
  openExecutionId: number;
  closeExecutionId: number;
  positionKey: string;
}

/**
 * Drive a real perps position open then close through the capture seam. Because
 * `closePosition` NULLs `unrealized_pnl_usd`, we write a signed MTM AFTER the
 * close (direct UPDATE) so the perps lesson signal is non-neutral. The S5
 * resolver caps a closed perps outcome at `medium` quality (MTM, not FIFO).
 */
export async function seedClosedPerpsPosition(
  args: FaithfulPerpsArgs,
): Promise<FaithfulPerpsResult> {
  const openCapture: Record<string, unknown> = {
    type: "perps",
    chain: CHAIN,
    walletAddress: args.walletAddress,
    instrumentKey: args.instrumentKey,
    positionKey: args.positionKey,
    unitPriceUsd: "1.00",
    inputValueUsd: "100.00",
    feeValueUsd: "0.10",
    status: "open",
    meta: { side: "long" },
  };
  const openRefs = { instrumentKey: args.instrumentKey, positionKey: args.positionKey };
  const openExecutionId = await recordExecution(
    "perps.open",
    NAMESPACE,
    args.sessionId,
    {},
    {},
    true,
    openCapture,
    extractExternalRefs({ _tradeCapture: openCapture, ...openRefs }),
    100,
  );
  await populateCaptureItems(
    openExecutionId,
    "perps.open",
    NAMESPACE,
    openCapture,
    undefined,
    extractExternalRefs({ _tradeCapture: openCapture, ...openRefs }),
  );

  const closeCapture: Record<string, unknown> = {
    type: "perps",
    chain: CHAIN,
    walletAddress: args.walletAddress,
    instrumentKey: args.instrumentKey,
    positionKey: args.positionKey,
    unitPriceUsd: "1.10",
    status: "closed",
    meta: { side: "long" },
  };
  const closeRefs = { instrumentKey: args.instrumentKey, positionKey: args.positionKey };
  const closeExecutionId = await recordExecution(
    "perps.close",
    NAMESPACE,
    args.sessionId,
    {},
    {},
    true,
    closeCapture,
    extractExternalRefs({ _tradeCapture: closeCapture, ...closeRefs }),
    100,
  );
  await populateCaptureItems(
    closeExecutionId,
    "perps.close",
    NAMESPACE,
    closeCapture,
    undefined,
    extractExternalRefs({ _tradeCapture: closeCapture, ...closeRefs }),
  );

  // closePosition NULLed unrealized_pnl_usd — write the signed MTM back so the
  // resolver derives a signed lesson signal (medium ceiling, never strong).
  await execute(
    `UPDATE proj_open_positions SET unrealized_pnl_usd = $1
       WHERE position_key = $2 AND status = 'closed'`,
    [args.closedPnlUsd, args.positionKey],
  );

  return {
    openExecutionId,
    closeExecutionId,
    positionKey: args.positionKey,
  };
}

// ── Faithful closing trade that FLIPS the ledger (S7 wake) ──────────

export interface FaithfulClosingTradeArgs {
  sessionId: string;
  instrumentKey: string;
  walletAddress: string;
  /** Decimal string USD proceeds for the flipping sell. */
  sellValueUsd: string;
  /** Raw integer string units sold. */
  sellQtyRaw: string;
}

/**
 * A NEW confirmed closing trade carrying the SAME semantic key (instrumentKey)
 * via `populateCaptureItems` → fires `enqueueLedgerWake` exactly like production.
 * Used to flip a promoted lesson's outcome and trigger an S7 reconcile job.
 */
export async function seedFaithfulClosingTradeForWake(
  args: FaithfulClosingTradeArgs,
): Promise<{ executionId: number }> {
  const sellCapture: Record<string, unknown> = {
    type: "swap",
    tradeSide: "sell",
    chain: CHAIN,
    walletAddress: args.walletAddress,
    instrumentKey: args.instrumentKey,
    inputTokenAddress: args.instrumentKey,
    outputTokenAddress: "So11111111111111111111111111111111111111112",
    inputAmount: args.sellQtyRaw,
    outputAmount: args.sellValueUsd,
    inputValueUsd: args.sellValueUsd,
    outputValueUsd: args.sellValueUsd,
    unitPriceUsd: "0.04",
    valuationSource: "jupiter_exact",
    status: "executed",
  };
  const refs = { instrumentKey: args.instrumentKey };
  const executionId = await recordExecution(
    "solana.swap.execute",
    NAMESPACE,
    args.sessionId,
    { side: "sell" },
    { signature: `flip-${args.instrumentKey}` },
    true,
    sellCapture,
    extractExternalRefs({ _tradeCapture: sellCapture, ...refs }),
    100,
  );
  await populateCaptureItems(
    executionId,
    "solana.swap.execute",
    NAMESPACE,
    sellCapture,
    undefined,
    extractExternalRefs({ _tradeCapture: sellCapture, ...refs }),
  );
  return { executionId };
}

// ── Real-Gemma candidate seeder ─────────────────────────────────────

export interface SeedGemmaCandidateOpts {
  sessionId: string;
  kind?: string;
  title: string;
  summary: string;
  contentMd?: string;
  evidenceRefs?: EvidenceRefs;
  importance?: number;
  confidence?: number | null;
  eventTime?: Date | null;
  source?: InsertCandidateInput["source"];
}

/**
 * Insert ONE pending candidate whose embedding is the REAL Gemma vector of
 * title+summary, with the real providerModel + dim. Used wherever recall
 * precision or judge escalation must match the live provider/dim.
 */
export async function seedGemmaCandidate(
  opts: SeedGemmaCandidateOpts,
): Promise<{ candidateId: string; providerModel: string }> {
  const kind = opts.kind ?? "strategy_lesson";
  const contentMd = opts.contentMd ?? "Process narrative only.";
  const { embedding, providerModel } = await embedDocument(opts.title, opts.summary);
  const input: InsertCandidateInput = {
    sessionId: opts.sessionId,
    proposedBy: "parent",
    kind,
    title: opts.title,
    summary: opts.summary,
    contentMd,
    entities: [],
    tags: [],
    sourceRefs: { messageIds: [] },
    evidenceRefs: opts.evidenceRefs ?? [],
    source: opts.source ?? "hypothesis",
    confidence: opts.confidence === undefined ? 0.7 : opts.confidence,
    importance: opts.importance ?? 7,
    sensitivity: "normal",
    evidenceStrength: "none",
    retrievalVisibility: "not_consolidated",
    retrievalUntil: null,
    retainUntil: null,
    embedding,
    embeddingModel: providerModel,
    embeddingDim: embedding.length,
    contentHash: computeContentHash({ kind, title: opts.title, summary: opts.summary, contentMd }),
    eventTime: opts.eventTime ?? null,
    observedAt: null,
    availableAtDecisionTime: null,
  };
  const { candidate } = await insertCandidate(input);
  return { candidateId: candidate.id, providerModel };
}

/**
 * Insert an ACTIVE knowledge entry directly with a REAL Gemma vector — for
 * retrieval-precision corpora that don't need a full promote path. `status`,
 * `source`, `maturityState`, `validUntil`, and `pinned` are settable so a suite
 * can characterize hot-context / expiry / supersede behavior.
 */
export interface SeedGemmaKnowledgeOpts {
  kind?: string;
  title: string;
  summary: string;
  source?: string;
  maturityState?: string;
  activationStrength?: number;
  status?: string;
  validUntil?: Date | null;
  pinned?: boolean;
}

export async function seedGemmaKnowledgeEntry(
  opts: SeedGemmaKnowledgeOpts,
): Promise<{ id: number; providerModel: string }> {
  const kind = opts.kind ?? "trade_lesson";
  const { embedding, providerModel } = await embedDocument(opts.title, opts.summary);
  const contentHash = computeContentHash({
    kind,
    title: opts.title,
    summary: opts.summary,
    contentMd: "",
  });
  const vectorLiteral = `[${embedding.join(",")}]`;
  const rows = await query<{ id: number }>(
    `INSERT INTO knowledge_entries
       (kind, title, summary, content_md, content_hash, embedding_model, embedding_dim, embedding,
        source, status, maturity_state, activation_strength, influence_scope, decay_policy,
        valid_from, valid_until, pinned, first_promoted_at, last_reinforced_at, outcome_version)
     VALUES ($1, $2, $3, '', $4, $5, $6, $7::vector,
        $8, $9, $10, $11, 'advisory', 'none',
        NOW(), $12, $13, NOW(), NOW(), 0)
     RETURNING id`,
    [
      kind,
      opts.title,
      opts.summary,
      contentHash,
      providerModel,
      embedding.length,
      vectorLiteral,
      opts.source ?? "observed",
      opts.status ?? "active",
      opts.maturityState ?? "established",
      opts.activationStrength ?? 1.0,
      opts.validUntil ?? null,
      opts.pinned ?? false,
    ],
  );
  return { id: rows[0]!.id, providerModel };
}

// ── Direct-promote seeder (faithful insertEntry + real Gemma — bypass judge) ──

export interface SeedPromotedLessonDirectOpts {
  kind?: string;
  title: string;
  summary: string;
  contentMd?: string;
  /** Provenance tier. `observed`/`user_confirmed` are hot-context-eligible. */
  source?: KnowledgeSource;
  /** Lesson-confidence FSM tier. `probationary` is excluded from hot context. */
  maturityState?: MaturityState;
  activationStrength?: number;
  influenceScope?: InfluenceScope;
  decayPolicy?: DecayPolicy;
  /** Bi-temporal expiry. NULL = no TTL (the F1 case). A past date = expired. */
  validUntil?: Date | null;
  /** Bi-temporal validity floor. Defaults to NOW(). */
  validFrom?: Date;
  pinned?: boolean;
  /** Source-refs (kept for parity; never carries the FIX-1 anchor — that's evidenceRefs on the candidate). */
  sourceRefs?: Record<string, unknown>;
  outcomeVersion?: number;
  regimeTags?: string[];
}

/**
 * Insert a PROMOTED knowledge entry directly through the REAL `insertEntry`
 * repo with a REAL Gemma embedding (embedDocument, dim 768, real providerModel)
 * — deterministically reproducing the end-state the judge would otherwise
 * produce, WITHOUT depending on the (F31-broken) live judge. Faithful because it
 * uses the production insert path + real embeddings; only the judge verdict is
 * short-circuited. Lifecycle/retrieval/reconcile scenarios seed with this so
 * they run green regardless of the judge's model-compat state.
 *
 * Returns the inserted entry id + the real provider model string (for the
 * recall model/dim filter).
 */
export async function seedPromotedLessonDirect(
  opts: SeedPromotedLessonDirectOpts,
): Promise<{ id: number; providerModel: string; contentHash: string }> {
  const kind = opts.kind ?? "trade_lesson";
  const contentMd = opts.contentMd ?? "";
  const { embedding, providerModel } = await embedDocument(opts.title, opts.summary);
  const contentHash = computeContentHash({
    kind,
    title: opts.title,
    summary: opts.summary,
    contentMd,
  });
  const { entry } = await insertEntry({
    kind,
    title: opts.title,
    summary: opts.summary,
    contentMd,
    tags: [],
    sourceRefs: opts.sourceRefs ?? {},
    confidence: null,
    pinned: opts.pinned ?? false,
    validUntil: opts.validUntil ?? null,
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    contentHash,
    embeddingModel: providerModel,
    embeddingDim: embedding.length,
    embedding,
    source: opts.source ?? "observed",
    maturityState: opts.maturityState ?? "established",
    activationStrength: opts.activationStrength ?? 1.0,
    influenceScope: opts.influenceScope ?? "advisory",
    decayPolicy: opts.decayPolicy ?? "none",
    regimeTags: opts.regimeTags ?? [],
    outcomeVersion: opts.outcomeVersion ?? 0,
  });
  return { id: entry.id, providerModel, contentHash };
}

// ── Faithful supersede seeder (repo-native supersedeEntry — flips predecessor) ──

export interface SeedSupersedingLessonDirectOpts {
  /** The active predecessor entry id this successor REPLACES (→ superseded). */
  previousId: number;
  kind?: string;
  title: string;
  summary: string;
  contentMd?: string;
  source?: KnowledgeSource;
  maturityState?: MaturityState;
  activationStrength?: number;
  influenceScope?: InfluenceScope;
  decayPolicy?: DecayPolicy;
  validUntil?: Date | null;
  validFrom?: Date;
  pinned?: boolean;
  outcomeVersion?: number;
  regimeTags?: string[];
}

/**
 * Insert a PROMOTED successor entry through the REAL `supersedeEntry` repo
 * transaction (atomic predecessor-lock → INSERT successor → UPDATE predecessor
 * to `superseded`), with a REAL Gemma embedding — deterministically reproducing
 * the supersede end-state the judge would otherwise produce, WITHOUT the
 * (F31-broken) live judge. Faithful: it uses the production supersede path +
 * real embeddings; only the judge verdict is short-circuited. The predecessor
 * goes active→superseded exactly like the real pipeline (NOT a manual status
 * UPDATE). Used to make seeded F/G predecessor CHAINS faithful so the chain's
 * structural invariants (superseded-row-inactive) hold.
 *
 * Returns the inserted successor id + the predecessor id (now superseded).
 */
export async function seedSupersedingLessonDirect(
  opts: SeedSupersedingLessonDirectOpts,
): Promise<{ id: number; previousId: number; providerModel: string }> {
  const kind = opts.kind ?? "trade_lesson";
  const contentMd = opts.contentMd ?? "";
  const { embedding, providerModel } = await embedDocument(opts.title, opts.summary);
  const contentHash = computeContentHash({
    kind,
    title: opts.title,
    summary: opts.summary,
    contentMd,
  });
  const result = await supersedeEntry({
    previousId: opts.previousId,
    reason: "superseded_by_successor_version",
    kind,
    title: opts.title,
    summary: opts.summary,
    contentMd,
    tags: [],
    sourceRefs: {},
    confidence: null,
    pinned: opts.pinned ?? false,
    validUntil: opts.validUntil ?? null,
    ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
    contentHash,
    embeddingModel: providerModel,
    embeddingDim: embedding.length,
    embedding,
    source: opts.source ?? "observed",
    maturityState: opts.maturityState ?? "established",
    activationStrength: opts.activationStrength ?? 1.0,
    influenceScope: opts.influenceScope ?? "advisory",
    decayPolicy: opts.decayPolicy ?? "none",
    regimeTags: opts.regimeTags ?? [],
    outcomeVersion: opts.outcomeVersion ?? 0,
  });
  return { id: result.successor.id, previousId: result.predecessor.id, providerModel };
}

// ── The pipeline driver (synchronous decideOneItem with the REAL judge) ──

export interface DriveResult {
  decisionType: string;
  decisionId: string;
  promotedKnowledgeId: number | null;
  llmCalls: number;
  costUsd: number | null;
  latencyMs: number;
  jobId: number;
  /**
   * S2 (e2e oracle): the resolved `DecisionPlan` from `consolidateCandidate`
   * (type + supersede `previousKnowledgeId` + sourceTier/regimeTags). The
   * snapshot scorer reads `plan.type` / `plan.previousKnowledgeId` to score the
   * supersede target choice independently of the persisted entry.
   */
  plan: DecisionPlan;
  /**
   * S2 (e2e oracle): the ledger-grounded `MemoryOutcomeSummary` resolved for a
   * trade-family candidate (null for non-trade kinds / no surviving anchor) —
   * lets the oracle score the resolved outcome signal/quality without re-reading
   * the candidate row.
   */
  outcome: MemoryOutcomeSummary | null;
  /**
   * S2 (e2e oracle): the pre-built graph write-plan for a promote/supersede
   * (null on every non-promoting plan AND whenever extraction failed open —
   * F31-fragile, so the oracle SCORES graph presence, never asserts it).
   */
  graphPlan: GraphPlan | null;
}

/**
 * Drive ONE candidate through the executor's item path with the REAL judge and
 * the REAL graph extractor (default deps): enqueue → claim → reserve → list →
 * markProcessing → consolidate (live DeepSeek) → applyDecisionAtomically (full
 * arg shape so S5 + S8 run) → bumpJobInference (mirror) → markItemDone.
 *
 * Returns the resolved decision + judge telemetry. `llmCalls > 0` is the
 * judge-ran proof; cost is best-effort (nullable).
 */
export async function driveConsolidateWithRealJudge(
  candidateId: string,
  workerId: string,
): Promise<DriveResult> {
  await enqueueConsolidateJob();
  const job = await claimNextDueJob(workerId);
  if (!job) throw new Error("driveConsolidate: no consolidate job");
  await reserveCandidatesForJob(job.id, workerId, 16);

  const items = await listItemsByJob(job.id, "reserved");
  const item = items.find((i) => i.candidateId === candidateId);
  if (!item) throw new Error("driveConsolidate: candidate not reserved");
  const ok = await markItemProcessing(item.id, job.id, workerId);
  if (!ok) throw new Error("driveConsolidate: markItemProcessing failed");

  const candidate = await getCandidateById(candidateId);
  if (!candidate) throw new Error("driveConsolidate: candidate missing");
  const embedding = await getCandidateEmbedding(candidateId);
  if (!embedding) throw new Error("driveConsolidate: embedding missing");

  const startedAt = Date.now();
  const decision = await consolidateCandidate(
    candidate,
    embedding,
    defaultConsolidateDeps(),
  );
  const latencyMs = Date.now() - startedAt;

  const applied = await applyDecisionAtomically({
    candidate,
    plan: decision.plan,
    jobId: job.id,
    workerId,
    outcome: decision.outcome,
    availableAtDecisionTime: decision.availableAtDecisionTime,
    reinforce: decision.reinforce,
    graphPlan: decision.graphPlan,
  });

  // Mirror the executor's job-inference bump so llmCalls/costUsd land on the job.
  if (decision.llmCalls > 0 || decision.costUsd !== null) {
    await bumpJobInference(job.id, {
      llmCalls: decision.llmCalls,
      ...(decision.costUsd !== null ? { costUsd: decision.costUsd } : {}),
    });
  }

  await markItemDone(item.id, job.id, workerId, applied.decisionId);

  const after = await getCandidateById(candidateId);
  return {
    decisionType: applied.decisionType,
    decisionId: applied.decisionId,
    promotedKnowledgeId: after?.promotedKnowledgeId ?? null,
    llmCalls: decision.llmCalls,
    costUsd: decision.costUsd,
    latencyMs,
    jobId: job.id,
    // S2: surface the decision detail the e2e oracle scores against.
    plan: decision.plan,
    outcome: decision.outcome,
    graphPlan: decision.graphPlan,
  };
}

// ── F31-aware capturing driver (RECORD schema-invalid, never crash) ──

/** Bounded judge-failure category — never carries raw model text (memLog-safe). */
export type JudgeFailureReason =
  | "schema_invalid"
  | "judge_timeout"
  | "judge_malformed"
  | "provider_config"
  | "judge_unknown";

/**
 * Outcome of one judge-path drive that captures F31:
 *   - `reached` — the candidate escalated and a judge call was attempted. True
 *     on BOTH a valid verdict AND a thrown `memory_judge_*` error (only the
 *     judge path raises those; a deterministic terminal never does).
 *   - `verdictValid` — a verdict validated against `judgeVerdictSchema`.
 *   - `drive` — present iff a verdict validated (the deterministic post-conditions
 *     are asserted off this); absent when the judge threw.
 *   - `invalidReason` — the bounded category when reached but not valid.
 *   - `latencyMs` — wall-clock of the consolidate call (judge round-trip), even
 *     on a thrown verdict (so a 30s timeout is measured, not hidden).
 */
export interface CapturedJudgeDrive {
  reached: boolean;
  verdictValid: boolean;
  invalidReason: JudgeFailureReason | null;
  drive: DriveResult | null;
  latencyMs: number;
}

/**
 * Map a thrown error to a bounded judge-failure reason. The judge throws
 * `memory_judge_schema_invalid` / `memory_judge_timeout` /
 * `memory_judge_malformed_json` / `memory_judge_provider_config_load_failed`
 * (judge.ts). A non-`memory_judge_*` error is re-classified `judge_unknown` —
 * but the caller only treats a `memory_judge_*` message as "reached".
 */
function classifyJudgeError(err: unknown): {
  isJudge: boolean;
  reason: JudgeFailureReason;
} {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("memory_judge_schema_invalid")) {
    return { isJudge: true, reason: "schema_invalid" };
  }
  if (msg.includes("memory_judge_timeout")) {
    return { isJudge: true, reason: "judge_timeout" };
  }
  if (msg.includes("memory_judge_malformed")) {
    return { isJudge: true, reason: "judge_malformed" };
  }
  if (msg.includes("memory_judge_provider_config")) {
    return { isJudge: true, reason: "provider_config" };
  }
  return { isJudge: false, reason: "judge_unknown" };
}

/**
 * Drive ONE candidate through the judge path, CAPTURING F31. A thrown
 * `memory_judge_*` error (schema-invalid / timeout / malformed) is caught and
 * reported as `{ reached:true, verdictValid:false, invalidReason }` — NEVER
 * propagated as a test failure. A successful verdict returns
 * `{ reached:true, verdictValid:true, drive }`. A NON-judge throw (a real bug in
 * seeding/apply) is re-thrown so it still fails loudly.
 *
 * The escalation/reach signal is the thrown `memory_judge_*` message itself (only
 * the judge path raises it) OR `llmCalls>0` on success. With
 * deepseek/deepseek-v4-flash today, valid-rate ≈ 0% and that IS the measured F31
 * result.
 */
export async function driveConsolidateCapturingJudge(
  candidateId: string,
  workerId: string,
): Promise<CapturedJudgeDrive> {
  const startedAt = Date.now();
  try {
    const drive = await driveConsolidateWithRealJudge(candidateId, workerId);
    // A deterministic terminal returns llmCalls=0 — that means the candidate did
    // NOT escalate (the judge was never reached). The caller asserts on `reached`.
    const reached = drive.llmCalls > 0;
    return {
      reached,
      verdictValid: reached,
      invalidReason: null,
      drive,
      latencyMs: drive.latencyMs,
    };
  } catch (err: unknown) {
    const { isJudge, reason } = classifyJudgeError(err);
    if (!isJudge) throw err; // a non-judge error is a real bug — fail loudly.
    return {
      reached: true,
      verdictValid: false,
      invalidReason: reason,
      drive: null,
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  JUDGE-BENCHMARK REASONING SEAM (TEST-ONLY — zero production change)
// ════════════════════════════════════════════════════════════════════════════
//
// The judge-decision benchmark (`judge-benchmark.int.test.ts`) needs the judge's
// RAW reasoning per item: the 5-axis `rubric`, the judge-RAW `sourceTier`, and
// `rejectReason`. In production those are collapsed by `planFromVerdict`
// (consolidate.ts) into a `DecisionPlan` BEFORE any capture seam — the raw
// verdict is dropped. Rather than plumb `verdict: JudgeVerdict|null` through
// `CandidateDecision → DriveResult` (a production edit), we WRAP the INJECTED
// `judge` dep here, in TEST CODE: `consolidateCandidate(candidate, embedding,
// deps)` already takes `deps.judge` as a function, so a test can record the raw
// verdict at the dep boundary with ZERO production change. The deterministic
// `signals.evidenceStrengthCeiling` rides in on the `signals` arg the manager
// passes to `deps.judge`, and the CLAMPED `plan.sourceTier` is read off the
// resolved plan afterward — so both tiers are captured SEPARATELY (scoring the
// clamped tier as "judge calibration" would read ~100% by construction).

/** The judge's raw reasoning for ONE escalated item — what `planFromVerdict` drops. */
export interface BenchJudgeReasoning {
  /** The judge's 5-axis rubric (grounding/durability/novelty/generalizability/processNotOutcome). */
  readonly rubric: JudgeRubric;
  /** The judge-RAW provenance tier (BEFORE the deterministic clamp). SOFT-scored vs oracle band. */
  readonly judgeSourceTier: KnowledgeSource;
  /** The judge's reject/expire reason (null on promote/supersede/retain). */
  readonly judgeRejectReason: MemoryDecisionRejectReason | null;
  /** The judge-raw verdict label (promote|supersede|retain|reject|expire). */
  readonly judgeVerdict: JudgeVerdictType;
  /** The judge's claimed supersede target (null unless supersede). */
  readonly judgePreviousKnowledgeId: number | null;
  /** The deterministic grounding ceiling fed to the judge (the clamp input). */
  readonly evidenceStrengthCeiling: CandidateEvidenceStrength;
  /**
   * The CLAMPED provenance tier the plan actually carried (clampSourceTier applied;
   * clamped ≤ ceiling is the HARD invariant). Kept SEPARATE from judgeSourceTier so
   * the benchmark never scores the clamp as "judge calibration" (false-green). Null
   * on a non-promote/supersede plan (retain/reject/expire carry no sourceTier).
   */
  readonly clampedSourceTier: KnowledgeSource | null;
}

/**
 * One judge-benchmark drive: the F31-aware `CapturedJudgeDrive` PLUS the raw
 * judge reasoning recorded at the dep boundary. `reasoning` is non-null ONLY when
 * the candidate escalated AND the judge returned a valid verdict (the same
 * denominator as `verdictValid`). On every deterministic-terminal /
 * non-escalate / thrown-judge path it is null — the F31 denominator is unchanged.
 */
export interface BenchJudgeDrive extends CapturedJudgeDrive {
  /** The raw judge reasoning, or null on any non-escalate / invalid-verdict path. */
  readonly reasoning: BenchJudgeReasoning | null;
}

/**
 * Drive ONE candidate through the REAL door+judge pipeline EXACTLY like
 * `driveConsolidateWithRealJudge`, but with the injected `judge` dep WRAPPED to
 * record the raw `JudgeVerdict` + `signals.evidenceStrengthCeiling` at the dep
 * boundary (BEFORE `planFromVerdict` collapses them). F31-aware: a thrown
 * `memory_judge_*` is caught and reported as `{ reached:true, verdictValid:false,
 * reasoning:null }`, never propagated (identical contract to
 * `driveConsolidateCapturingJudge`). The CLAMPED `plan.sourceTier` is read off
 * the resolved plan and stored SEPARATELY from the judge-raw tier.
 *
 * This is the Wave-0 reasoning seam: 100% test-only (this file has zero
 * production importers and is excluded from the app tsconfig). No production
 * module is edited; the manager's behavior is byte-identical because the wrapped
 * dep returns the SAME `{ verdict, llmCalls, costUsd }` the default dep returns.
 */
export async function driveConsolidateForBench(
  candidateId: string,
  workerId: string,
): Promise<BenchJudgeDrive> {
  const startedAt = Date.now();

  // The raw verdict + the deterministic ceiling, captured at the dep boundary.
  let captured: {
    verdict: JudgeVerdict;
    ceiling: CandidateEvidenceStrength;
  } | null = null;

  // Build the production deps, then OVERRIDE only `judge` with a recording
  // wrapper that delegates to the real judge dep and snapshots the raw verdict.
  const baseDeps = defaultConsolidateDeps();
  const deps: ConsolidateDeps = {
    ...baseDeps,
    judge: async (candidate, signals, extras) => {
      const result = await baseDeps.judge(candidate, signals, extras);
      // Snapshot BEFORE planFromVerdict runs. The signals carry the deterministic
      // evidenceStrengthCeiling the manager will feed to clampSourceTier.
      captured = { verdict: result.verdict, ceiling: signals.evidenceStrengthCeiling };
      return result;
    },
  };

  try {
    const drive = await driveOneWithDeps(candidateId, workerId, deps);
    const reached = drive.llmCalls > 0;
    const reasoning = buildBenchReasoning(captured, drive.plan);
    return {
      reached,
      verdictValid: reached,
      invalidReason: null,
      drive,
      latencyMs: drive.latencyMs,
      reasoning,
    };
  } catch (err: unknown) {
    const { isJudge, reason } = classifyJudgeError(err);
    if (!isJudge) throw err; // a non-judge error is a real bug — fail loudly.
    return {
      reached: true,
      verdictValid: false,
      invalidReason: reason,
      drive: null,
      latencyMs: Date.now() - startedAt,
      reasoning: null,
    };
  }
}

/**
 * Assemble the bench reasoning from the captured raw verdict + the resolved plan.
 * `clampedSourceTier` is read off the plan ONLY for promote/supersede (the
 * other plan types carry no tier). Returns null when the judge was never reached
 * (no captured verdict).
 */
function buildBenchReasoning(
  captured: { verdict: JudgeVerdict; ceiling: CandidateEvidenceStrength } | null,
  plan: DecisionPlan,
): BenchJudgeReasoning | null {
  if (captured === null) return null;
  const v = captured.verdict;
  const clampedSourceTier =
    plan.type === "promote" || plan.type === "supersede" ? plan.sourceTier : null;
  return {
    rubric: v.rubric,
    judgeSourceTier: v.sourceTier,
    judgeRejectReason: v.rejectReason ?? null,
    judgeVerdict: v.verdict,
    judgePreviousKnowledgeId: v.previousKnowledgeId ?? null,
    evidenceStrengthCeiling: captured.ceiling,
    clampedSourceTier,
  };
}

/**
 * The exact `driveConsolidateWithRealJudge` body but with INJECTABLE `deps` — so
 * the bench driver can pass a judge-wrapping deps object. Production behavior is
 * unchanged: `driveConsolidateWithRealJudge` still calls `defaultConsolidateDeps()`
 * directly. Kept private (the bench driver is the only caller).
 */
async function driveOneWithDeps(
  candidateId: string,
  workerId: string,
  deps: ConsolidateDeps,
): Promise<DriveResult> {
  await enqueueConsolidateJob();
  const job = await claimNextDueJob(workerId);
  if (!job) throw new Error("driveConsolidateForBench: no consolidate job");
  await reserveCandidatesForJob(job.id, workerId, 16);

  const items = await listItemsByJob(job.id, "reserved");
  const item = items.find((i) => i.candidateId === candidateId);
  if (!item) throw new Error("driveConsolidateForBench: candidate not reserved");
  const ok = await markItemProcessing(item.id, job.id, workerId);
  if (!ok) throw new Error("driveConsolidateForBench: markItemProcessing failed");

  const candidate = await getCandidateById(candidateId);
  if (!candidate) throw new Error("driveConsolidateForBench: candidate missing");
  const embedding = await getCandidateEmbedding(candidateId);
  if (!embedding) throw new Error("driveConsolidateForBench: embedding missing");

  const startedAt = Date.now();
  const decision = await consolidateCandidate(candidate, embedding, deps);
  const latencyMs = Date.now() - startedAt;

  const applied = await applyDecisionAtomically({
    candidate,
    plan: decision.plan,
    jobId: job.id,
    workerId,
    outcome: decision.outcome,
    availableAtDecisionTime: decision.availableAtDecisionTime,
    reinforce: decision.reinforce,
    graphPlan: decision.graphPlan,
  });

  if (decision.llmCalls > 0 || decision.costUsd !== null) {
    await bumpJobInference(job.id, {
      llmCalls: decision.llmCalls,
      ...(decision.costUsd !== null ? { costUsd: decision.costUsd } : {}),
    });
  }

  await markItemDone(item.id, job.id, workerId, applied.decisionId);

  const after = await getCandidateById(candidateId);
  return {
    decisionType: applied.decisionType,
    decisionId: applied.decisionId,
    promotedKnowledgeId: after?.promotedKnowledgeId ?? null,
    llmCalls: decision.llmCalls,
    costUsd: decision.costUsd,
    latencyMs,
    jobId: job.id,
    plan: decision.plan,
    outcome: decision.outcome,
    graphPlan: decision.graphPlan,
  };
}

/**
 * Cosine similarity between the REAL Gemma embeddings of two title+summary
 * pairs — the F32 same-lesson-cosine signal. embedDocument returns unit-norm
 * vectors, so a plain dot product is the cosine. No DB round-trip.
 */
export async function measureSameLessonCosine(
  a: { title: string; summary: string },
  b: { title: string; summary: string },
): Promise<number> {
  const [ea, eb] = await Promise.all([
    embedDocument(a.title, a.summary),
    embedDocument(b.title, b.summary),
  ]);
  const va = ea.embedding;
  const vb = eb.embedding;
  const n = Math.min(va.length, vb.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += va[i]! * vb[i]!;
    na += va[i]! * va[i]!;
    nb += vb[i]! * vb[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export { getLatestDecision };
