/**
 * Time-simulated memory eval — THE RUNNER (S4). TEST-ONLY imperative shell.
 *
 * Drives the `_world-corpus.ts` stream ONE ITEM AT A TIME through the REAL Vex
 * memory pipeline (handleLongMemorySuggest door → live DeepSeek judge →
 * consolidate/graph/decay → Gemma retrieval) over SIMULATED time, and CAPTURES
 * the per-item + final state for the S5 oracle scorer. S4 only RUNS and
 * CAPTURES — it does NOT score against `_oracle.ts` (that is S5).
 *
 * RETIREMENT NOTE (Agent Scan W4, FIX2): outcome-driven reconciliation is
 * removed — the pipeline this runner drives is now pure consolidate/graph/
 * decay/retrieval. The former reconcile-flip scenario (K01-K04, and the S7
 * PF03/PF04/LQ03/LQ04 perp/liq mirrors) is REMOVED from the corpus, not
 * replaced; the ledger-wake → reconcile-job machinery this file used to drive
 * (`linkPromotedCandidateForReconcile` / `runReconcileForItem` /
 * `processReconcileForEntry`) is deleted along with it. See the memory
 * README's lost-coverage note.
 *
 * ── EVENT MODEL ─────────────────────────────────────────────────────────────
 * The corpus is three pure streams (memories / trades / regimes) each tagged with
 * a sim-day. They are merged into ONE chronological event list, stable-sorted by
 * `(simDay, kindRank)` so that on the SAME sim-day:
 *   1. TRADES seed first (a trade-anchored memory needs its real executionId),
 *   2. REGIMES next (a regime snapshot must exist before that day's decay sweep),
 *   3. MEMORIES last (predecessors that are `seedPromotedLessonDirect` are
 *      authored on EARLIER days than their successors, so cross-day ordering is
 *      already correct; same-day memory order falls back to corpus order).
 *
 * ── TIME SIMULATION ─────────────────────────────────────────────────────────
 * Per `_sim-clock.ts`: there is no global clock seam, so a logical `simNowDay` is
 * projected onto the wall clock at each checkpoint. When the stream advances to a
 * NEW sim-day, FIRST advance the clock (re-backdate every active decayable row's
 * anchors + `runDecaySweep`) for the elapsed days, THEN process that day's events.
 * BINDING (per Codex): capture exactly ONE `wallNow = new Date()` per checkpoint
 * and thread the SAME instant into projection, runDecaySweep, AND simRegimeDeps —
 * never three fresh `new Date()`.
 *
 * ── CAPTURE ─────────────────────────────────────────────────────────────────
 * `RunCapture` accumulates one `ItemResult` per memory item (door-reject / judge /
 * seed detail) plus the resolved trade/regime ids. S5 consumes it.
 */

import { runDecaySweep } from "@vex-agent/engine/memory-manager/decay-sweep.js";
import { listDecayableEntries } from "@vex-agent/db/repos/knowledge/crud.js";
import { insertRegimeSnapshot } from "@vex-agent/db/repos/regime-snapshots.js";
import { query } from "@vex-agent/db/client.js";
import { handleLongMemorySuggest } from "@vex-agent/tools/internal/long-memory/suggest.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type {
  DecayPolicy,
  InfluenceScope,
} from "@vex-agent/memory/schema/long-memory-enums.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import type { RegimeConfidence, RegimeVolLabel } from "@vex-agent/memory/schema/regime-enums.js";

import {
  WORLD_CORPUS,
  type MemoryItem,
  type TradeEvent,
  type RegimeEvent,
  type CorpusSuggest,
  type CorpusIntent,
} from "./_world-corpus.js";

import {
  seedFaithfulConfirmedSpotTrade,
  seedGemmaCandidate,
  seedPromotedLessonDirect,
  seedSupersedingLessonDirect,
  driveConsolidateCapturingJudge,
  type FaithfulSpotResult,
} from "./_eval-fixtures.js";
import {
  backdateCandidate,
  backdateKnowledgeEntry,
  backdateRegimeSnapshot,
  simRegimeDeps,
  MS_PER_DAY,
} from "./_sim-clock.js";

// ════════════════════════════════════════════════════════════════════════════
//  CAPTURE SHAPES (what S5 scores against the oracle)
// ════════════════════════════════════════════════════════════════════════════

/** Door-reject capture (N/O/P/Q/R adversarial + J near-dups that fail the door). */
export interface DoorRejectCapture {
  readonly kind: "door_reject";
  /** `handleLongMemorySuggest` success flag (false = rejected at the door). */
  readonly success: boolean;
  /** Steering message text (the human-readable reject reason), or null on success. */
  readonly steering: string | null;
  /** Whether a candidate row landed (a clean pass through the door inserts one). */
  readonly candidateId: string | null;
}

/** Judge-path capture (items that reach the live DeepSeek consolidation judge). */
export interface JudgeCapture {
  readonly kind: "judge";
  /** The candidate id that was driven through the judge. */
  readonly candidateId: string;
  /** Whether a judge call was attempted (the candidate escalated). */
  readonly reached: boolean;
  /** Whether a verdict validated against judgeVerdictSchema. */
  readonly verdictValid: boolean;
  /** Bounded failure category when reached-but-invalid (F31), else null. */
  readonly invalidReason: string | null;
  /** Resolved decision type (promote/retain/reject/supersede/…) or null on a thrown judge. */
  readonly decisionType: string | null;
  /** The supersede target the system picked (plan.previousKnowledgeId) or null. */
  readonly supersedesKnowledgeId: number | null;
  /** Resolved outcome lesson-signal (positive/negative/neutral) or null. */
  readonly outcomeSignal: string | null;
  /** Whether a graph write-plan was built (SOFT — F31-fragile). */
  readonly hasGraphPlan: boolean;
  /** Judge round-trip latency (ms), measured even on a timed-out verdict. */
  readonly latencyMs: number;
}

/**
 * Deterministic seed capture (predecessors / graph owners / decay owners — the
 * residual `seedPromotedLessonDirect` scaffold ONLY). The `seedGemmaCandidate`
 * recurrence siblings no longer produce a seed capture — they are driven
 * through the live judge and produce a `JudgeCapture` instead.
 */
export interface SeedCapture {
  readonly kind: "seed";
  /** Which seeder produced the row (only the direct-promote scaffold remains). */
  readonly via: "seedPromotedLessonDirect";
  /** The knowledge entry id (direct-promote). */
  readonly knowledgeId: number;
  /** Always null for the direct-promote scaffold (no candidate row). */
  readonly candidateId: null;
}

/** The per-item capture union the scorer reads. */
export type ItemResult =
  | DoorRejectCapture
  | JudgeCapture
  | SeedCapture;

/**
 * The whole-run capture. `perItem` is keyed by the corpus memory id. `finalSnapshot`
 * is a stub here (S4) — S5 fills it from the real read paths. `tradeAnchors` maps a
 * TradeEvent id → its seeded executionIds so the scorer can cross-reference.
 */
export interface RunCapture {
  perItem: Map<string, ItemResult>;
  tradeAnchors: Map<string, FaithfulSpotResult>;
  regimeSnapshotIds: Map<string, number>;
  /** Corpus item ids that were processed this run (subset-aware). */
  processedItemIds: string[];
  /**
   * Corpus item id → the knowledge_entries.id it produced (seeded directly OR
   * promoted by the judge). Door-rejected / retained / rejected items have no
   * entry and are absent. The S5 snapshot reads each row via knowledgeRepo.getById.
   */
  entryIdByItem: Map<string, number>;
  /**
   * The last sim-day the stream advanced to (the max simDay across all processed
   * events). The S5 decay gate scores the achieved age against this, not a fixed
   * 89 — a subset that stops earlier still decays to its own final day.
   */
  finalSimDay: number;
  finalSnapshot: null;
}

// ════════════════════════════════════════════════════════════════════════════
//  EVENT MERGE / SORT
// ════════════════════════════════════════════════════════════════════════════

type StreamEvent =
  | { readonly kind: "trade"; readonly simDay: number; readonly seq: number; readonly trade: TradeEvent }
  | { readonly kind: "regime"; readonly simDay: number; readonly seq: number; readonly regime: RegimeEvent }
  | { readonly kind: "memory"; readonly simDay: number; readonly seq: number; readonly item: MemoryItem };

/** Same-day ordering rank: trades → regimes → memories. */
const KIND_RANK: Record<StreamEvent["kind"], number> = {
  trade: 0,
  regime: 1,
  memory: 2,
};

/**
 * Merge the three corpus streams into ONE chronological event list, stable-sorted
 * by `(simDay, kindRank, seq)`. `seq` is the original within-stream index, so the
 * sort is stable for ties (authored order is preserved within a same-day kind).
 */
export function buildEventStream(
  memories: readonly MemoryItem[],
  trades: readonly TradeEvent[],
  regimes: readonly RegimeEvent[],
): StreamEvent[] {
  const events: StreamEvent[] = [];
  trades.forEach((trade, seq) => events.push({ kind: "trade", simDay: trade.simDay, seq, trade }));
  regimes.forEach((regime, seq) => events.push({ kind: "regime", simDay: regime.simDay, seq, regime }));
  memories.forEach((item, seq) => events.push({ kind: "memory", simDay: item.simDay, seq, item }));
  return events.sort((a, b) => {
    if (a.simDay !== b.simDay) return a.simDay - b.simDay;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return a.seq - b.seq;
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  SUBSET SELECTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * The representative 9-item subset (S4 proof). Spans the funnel-critical classes:
 *   - A01  trade_lesson (judge path, WIF-anchored, graph cluster)     → judge
 *   - F01  supersession predecessor (seedPromotedLessonDirect)        → seed
 *   - F03  supersession successor (suggest → judge, supersedes F02)   → judge
 *   - H01  graph-cluster owner (seedPromotedLessonDirect)             → seed
 *   - P04  secret door-reject (sk- key → tier1 hard reject)           → door reject
 *   - R01  prompt-injection (suggest → judge; must NOT be steered)    → judge
 *   - Q01  non-English door-reject                                    → door reject
 *   - M01  decay time-only (seedPromotedLessonDirect)                 → seed
 *   - B02  recurrence-2 (suggest → judge, anchored on a range loss)   → judge
 *
 * RETIREMENT NOTE (Agent Scan W4, FIX2): this subset previously included a K02
 * reconcile-flip pick (seed + linked promoted candidate → later closing trade
 * → ledger-wake → reconcile job → flip). Outcome-driven reconciliation is
 * removed entirely (not replaced) — the K category (and its S7 PF03/PF04/
 * LQ03/LQ04 perp/liq mirrors) no longer exists in `_world-corpus.ts`, so this
 * subset shrank from 10 to 9 items with no substitute pick.
 */
export const SUBSET_IDS: readonly string[] = [
  "A01",
  "F01",
  "F03",
  "H01",
  "P04",
  "R01",
  "Q01",
  "M01",
  "B02",
] as const;

/**
 * The FULL 100-item corpus id list (S6 full-corpus path). Derived from the
 * corpus itself so it stays in lock-step with `_world-corpus.ts` — no second
 * hand-maintained list to drift. The test's `selectSubsetIds()` returns this
 * for `VEX_E2E_SUBSET=full|100`; `resolveSubset(ALL_CORPUS_IDS)` then pulls in
 * every trade + regime the items reference.
 */
export const ALL_CORPUS_IDS: readonly string[] = WORLD_CORPUS.memories.map((m) => m.id);

/**
 * Resolve the full closure of items + trades + regimes required to drive a chosen
 * memory-id subset end-to-end: the chosen memories, every trade those memories
 * anchor on (and the closing trades that flip them), and every regime snapshot up
 * to and including the latest chosen sim-day so the dwell/age guards see a sim
 * clock consistent with the run window.
 */
export function resolveSubset(subsetIds: readonly string[]): {
  memories: MemoryItem[];
  trades: TradeEvent[];
  regimes: RegimeEvent[];
} {
  const want = new Set(subsetIds);
  const memories = WORLD_CORPUS.memories.filter((m) => want.has(m.id));
  if (memories.length !== want.size) {
    const missing = [...want].filter((id) => !memories.some((m) => m.id === id));
    throw new Error(`resolveSubset: unknown corpus ids ${missing.join(", ")}`);
  }

  // Required trade ids: the anchor trade of each chosen memory.
  const tradeIds = new Set<string>();
  for (const m of memories) {
    if (m.intent.anchorTradeId) tradeIds.add(m.intent.anchorTradeId);
  }
  const trades = WORLD_CORPUS.trades.filter((t) => tradeIds.has(t.id));

  // Regimes: include every snapshot at or before the latest chosen sim-day so the
  // effective-regime dwell pairs are present for any decay sweep in the window.
  const maxDay = Math.max(...memories.map((m) => m.simDay), ...trades.map((t) => t.simDay), 0);
  const regimes = WORLD_CORPUS.regimes.filter((r) => r.simDay <= maxDay);

  return { memories, trades, regimes };
}

// ════════════════════════════════════════════════════════════════════════════
//  ENUM MAPPERS (corpus literals → repo/schema literals)
// ════════════════════════════════════════════════════════════════════════════

/** Corpus `vol` (`high_vol`/`low_vol`) → regime `vol_label` (`high`/`low`). */
function mapVolLabel(vol: RegimeEvent["vol"]): RegimeVolLabel {
  return vol === "high_vol" ? "high" : "low";
}

/** Corpus `confidence` (`low`/`med`/`high`) → regime confidence (`low`/`medium`/`high`). */
function mapRegimeConfidence(conf: RegimeEvent["confidence"]): RegimeConfidence {
  if (conf === "med") return "medium";
  return conf; // "low" | "high" pass through
}

/** Map a corpus suggest payload to the snake_case `handleLongMemorySuggest` params. */
function mapToSuggestParams(
  item: MemoryItem,
  resolvedEvidenceRefs: readonly { executionId: number; instrumentKey?: string; positionKey?: string }[],
  eventTimeISO: string,
): Record<string, unknown> {
  const s: CorpusSuggest = item.suggest;
  const params: Record<string, unknown> = {
    kind: item.kind,
    title: s.title,
    summary: s.summary,
    event_time: eventTimeISO,
  };
  if (s.contentMd !== undefined) params["content_md"] = s.contentMd;
  if (s.entities !== undefined) params["entities"] = [...s.entities];
  if (s.tags !== undefined) params["tags"] = [...s.tags];
  if (s.importance !== undefined) params["importance"] = s.importance;
  if (s.confidence !== undefined) params["confidence"] = s.confidence;
  if (resolvedEvidenceRefs.length > 0) params["evidence_refs"] = resolvedEvidenceRefs.map((r) => ({ ...r }));
  return params;
}

/**
 * Whether a memory item is a door-reject class (its capture IS the door result —
 * it does NOT proceed to consolidation). N/O/P/Q/R adversarial items + the
 * door-routed J near-dups. The runner records the door outcome and stops.
 */
function isDoorClass(item: MemoryItem): boolean {
  return item.intent.adversarial !== undefined;
}

/**
 * Map a corpus `decayExpected` class → the concrete `decay_policy` enum value the
 * seeded entry must carry so the real sweep treats it correctly:
 *   - "time"   → "time"          (pure age half-life, regime-neutral)
 *   - "regime" → "regime_aware"  (regime-modulated decay; the L bull-only owners)
 *   - else     → "none"          (frozen — excluded by listDecayableEntries)
 */
function decayPolicyFor(intent: CorpusIntent): DecayPolicy {
  if (intent.decayExpected === "time") return "time";
  if (intent.decayExpected === "regime") return "regime_aware";
  return "none";
}

// ════════════════════════════════════════════════════════════════════════════
//  CONTEXT
// ════════════════════════════════════════════════════════════════════════════

/** The lifecycle.int.test.ts:46 context shape (a `full`/approved parent agent). */
export function makeContext(sessionId: string): InternalToolContext {
  return {
    sessionId,
    loadedDocuments: new Map<string, string>(),
    sessionPermission: "full",
    approved: true,
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    planMode: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  RUNNER STATE
// ════════════════════════════════════════════════════════════════════════════

/** Per-entry sim anchors so a checkpoint advance can re-project them consistently. */
interface ActiveEntryAnchor {
  readonly promotedSimDay: number;
  /**
   * The LAST sim-day on which a decay step was actually APPLIED to this entry (a
   * write to `last_decayed_at`). Initialized to `promotedSimDay`. The checkpoint
   * advance re-projects `last_decayed_at` to THIS day (not blindly to the prior
   * checkpoint day) so the incremental decay anchor in `decayEntry` sees the full
   * accumulated quantum since the last APPLIED decay.
   *
   * WHY (the M-decay under-accumulation fix): `decayEntry` erodes only the quantum
   * since `max(last_reinforced_at, last_decayed_at)`, and its anti-audit-spam
   * `below_delta` no-op (maturity.ts:305) skips a step whose Δactivation < 0.01
   * WITHOUT writing `last_decayed_at`. The corpus packs events onto many close
   * sim-days, so each tiny checkpoint interval no-ops. If the next advance re-pinned
   * `last_decayed_at` forward to the new prior day, those un-decayed intervals would
   * be permanently lost (only large single jumps would ever decay). Pinning to the
   * last-APPLIED-decay day instead preserves the accumulation, so the persisted
   * total matches the closed-form `0.5^(age/halfLife)`.
   */
  lastDecaySimDay: number;
}

interface RunnerState {
  readonly sessionId: string;
  readonly capture: RunCapture;
  /** entryId → its sim-day anchors (for re-projection at each checkpoint). */
  readonly activeEntries: Map<number, ActiveEntryAnchor>;
  /** A monotonically increasing worker id suffix so each judge drive is distinct. */
  workerSeq: number;
}

// ════════════════════════════════════════════════════════════════════════════
//  CHECKPOINT ADVANCE (decay over sim time)
// ════════════════════════════════════════════════════════════════════════════

/** Page through every active decayable entry (the sweep's exact eligibility set). */
async function listAllDecayableIds(): Promise<number[]> {
  const ids: number[] = [];
  let afterId = 0;
  // The sweep caps at 2000/page; for ≤100 items one page suffices, but page to be safe.
  for (;;) {
    const rows = await listDecayableEntries({ afterId, limit: 500 });
    if (rows.length === 0) break;
    for (const r of rows) ids.push(r.id);
    afterId = rows[rows.length - 1]!.id;
    if (rows.length < 500) break;
  }
  return ids;
}

/** Read one entry's raw `last_decayed_at` wall timestamp (null when never decayed). */
async function readLastDecayedAt(id: number): Promise<string | null> {
  const rows = await query<{ last_decayed_at: string | null }>(
    `SELECT last_decayed_at FROM knowledge_entries WHERE id = $1`,
    [id],
  );
  return rows[0]?.last_decayed_at ?? null;
}

/**
 * Advance the simulated clock from `priorDay` to `newDay`. Captures ONE `wallNow`,
 * re-projects every active decayable entry's anchors onto it (keeping
 * first_promoted_at / last_reinforced_at at their ORIGINAL sim-days, and pinning
 * last_decayed_at to the entry's LAST-APPLIED-DECAY sim-day — not the prior
 * checkpoint day), then runs the real decay sweep with that SAME `wallNow`.
 *
 * Pinning to the last-APPLIED-decay day (tracked per entry in `ActiveEntryAnchor`)
 * is the M-decay under-accumulation fix: the sweep's `below_delta` no-op skips a
 * tiny step WITHOUT writing `last_decayed_at`, so re-pinning to `priorDay` every
 * checkpoint would drop those un-decayed intervals. After the sweep we detect which
 * entries the sweep actually decayed (their `last_decayed_at` column changed) and
 * roll their applied-decay day forward to `newDay`; the rest keep accumulating.
 */
async function advanceClock(state: RunnerState, priorDay: number, newDay: number): Promise<void> {
  const wallNow = new Date(); // ONE capture per checkpoint (load-bearing)
  const decayableIds = await listAllDecayableIds();

  for (const id of decayableIds) {
    const anchor = state.activeEntries.get(id);
    const promotedSimDay = anchor?.promotedSimDay ?? priorDay;
    const lastDecaySimDay = anchor?.lastDecaySimDay ?? priorDay;
    await backdateKnowledgeEntry(
      id,
      {
        firstPromotedAt: promotedSimDay,
        lastReinforcedAt: promotedSimDay,
        // Pin last_decayed_at to the entry's last APPLIED-decay sim-day so the next
        // sweep's Δt covers EVERY un-decayed interval since then (a sub-`below_delta`
        // checkpoint never advanced this), making the cumulative decay match the
        // closed-form half-life instead of dropping small intervals.
        lastDecayedAt: lastDecaySimDay,
      },
      newDay,
      wallNow,
    );
  }

  await runDecaySweep(wallNow, simRegimeDeps(wallNow));

  // Roll the applied-decay anchor forward for entries the sweep actually decayed.
  // The backdate above re-wrote last_decayed_at to a wall-projection of
  // lastDecaySimDay (an instant in the sim PAST since lastDecaySimDay ≤ priorDay <
  // newDay); a sweep that APPLIED decay overwrote it with DB NOW() ≈ wallNow (the
  // PRESENT). So an APPLIED decay leaves last_decayed_at at ≈ wallNow, i.e. far
  // LATER than the projected-past value we wrote. Detect by epoch-ms (robust to the
  // DB timestamptz string format differing from JS toISOString) with a generous
  // tolerance: if the post-sweep instant is at/after the wall-projection of
  // `newDay` (the earliest a NOW() write could land for this checkpoint, modulo a
  // small backstop), the sweep wrote NOW() → decay applied → quantum consumed.
  const newDayWallMs = wallNow.getTime(); // the wall-projection of `newDay`
  const APPLIED_TOLERANCE_MS = MS_PER_DAY / 2; // half a sim-day backstop
  for (const id of decayableIds) {
    const anchor = state.activeEntries.get(id);
    if (!anchor) continue;
    const after = await readLastDecayedAt(id);
    if (after === null) continue;
    const afterMs = Date.parse(after);
    if (!Number.isFinite(afterMs)) continue;
    // Our re-projected write placed last_decayed_at at the wall-projection of
    // lastDecaySimDay (≤ priorDay), which is strictly < newDayWallMs by ≥ one sim
    // day. An applied NOW() write lands at ≈ newDayWallMs. The midpoint test cleanly
    // separates the two without depending on exact string equality.
    if (afterMs >= newDayWallMs - APPLIED_TOLERANCE_MS) {
      anchor.lastDecaySimDay = newDay;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  DISPATCH
// ════════════════════════════════════════════════════════════════════════════

/** Resolve the trade-anchored evidence refs for a memory item (SELL first). */
function resolveTradeAnchors(
  item: MemoryItem,
  tradeAnchors: Map<string, FaithfulSpotResult>,
): { executionId: number; instrumentKey?: string }[] {
  const tradeId = item.intent.anchorTradeId;
  if (!tradeId) {
    // NON-trade item: forward its literal evidenceRefs (FIXED_ANCHOR placeholders
    // remapped to a real execution would require a seeded execution; the corpus
    // only carries executionId=1 placeholders for these, which the suggest schema
    // accepts as int>0 but no real row exists. For S4 we forward them as-is for
    // non-door items that reach the judge — recurrence may stay low, which is the
    // honest pipeline behavior the scorer reads).
    return (item.suggest.evidenceRefs ?? []).map((r) => ({
      executionId: r.executionId,
      ...(r.instrumentKey !== undefined ? { instrumentKey: r.instrumentKey } : {}),
    }));
  }
  const seeded = tradeAnchors.get(tradeId);
  if (!seeded) {
    throw new Error(`resolveTradeAnchors: ${item.id} anchors trade ${tradeId} which was not seeded`);
  }
  const anchorOn = item.intent.anchorOn ?? "sell";
  const primary = anchorOn === "sell" ? seeded.sellExecutionId : seeded.buyExecutionId;
  const secondary = anchorOn === "sell" ? seeded.buyExecutionId : seeded.sellExecutionId;
  return [
    { executionId: primary, instrumentKey: seeded.instrumentKey },
    { executionId: secondary, instrumentKey: seeded.instrumentKey },
  ];
}

/** Process one TRADE event: seed the faithful spot trade, key the result by id. */
async function runTradeEvent(state: RunnerState, trade: TradeEvent): Promise<void> {
  const result = await seedFaithfulConfirmedSpotTrade({
    sessionId: state.sessionId,
    instrumentKey: trade.instrumentKey,
    walletAddress: trade.walletAddress,
    buyQtyRaw: trade.buyQtyRaw ?? "1000000000",
    buyValueUsd: trade.buyValueUsd ?? "50.00",
    sellQtyRaw: trade.sellQtyRaw,
    sellValueUsd: trade.sellValueUsd,
  });
  state.capture.tradeAnchors.set(trade.id, result);
}

/** Process one REGIME event: insert the snapshot then backdate created_at to simDay. */
async function runRegimeEvent(state: RunnerState, regime: RegimeEvent, simNowDay: number): Promise<void> {
  const wallNow = new Date();
  const snapshot = await insertRegimeSnapshot({
    trendLabel: regime.trend,
    volLabel: mapVolLabel(regime.vol),
    confidence: mapRegimeConfidence(regime.confidence),
    source: "hybrid",
    rationale: regime.rationale,
  });
  await backdateRegimeSnapshot(snapshot.id, { createdAt: regime.simDay }, simNowDay, wallNow);
  state.capture.regimeSnapshotIds.set(regime.id, snapshot.id);
}

/** Process one MEMORY item: dispatch by entryVia + intent and capture the result. */
async function runMemoryItem(state: RunnerState, item: MemoryItem, simNowDay: number): Promise<void> {
  const wallNow = new Date();
  const eventTimeISO = new Date(wallNow.getTime()).toISOString();

  // ── Door-class adversarial items: the door result IS the capture. ──
  if (isDoorClass(item)) {
    const refs = resolveTradeAnchors(item, state.capture.tradeAnchors);
    const params = mapToSuggestParams(item, refs, eventTimeISO);
    const res = await handleLongMemorySuggest(params, makeContext(state.sessionId));
    const data = (res.data ?? {}) as { candidateId?: string };
    const candidateId = typeof data.candidateId === "string" ? data.candidateId : null;
    state.capture.perItem.set(item.id, {
      kind: "door_reject",
      success: res.success === true,
      // Steering text lives in `output` (ToolResult has no `message`); on a clean
      // pass it is the accept payload, which the scorer ignores for success items.
      steering: res.success === true ? null : res.output,
      candidateId,
    });
    return;
  }

  // ── seedPromotedLessonDirect: deterministic active entry (predecessors / ──
  // ── graph owners / decay owners). Judge bypassed.                        ──
  if (item.entryVia === "seedPromotedLessonDirect") {
    const decayPolicy = decayPolicyFor(item.intent);
    const influenceScope: InfluenceScope = "advisory";
    const source: KnowledgeSource = "observed";

    // ── Faithful predecessor supersession (S6/C1). When a seeded item REPLACES an
    // already-seeded active predecessor (F02→F01, F05→F04), insert the successor
    // through the REPO-NATIVE supersedeEntry transaction so the predecessor goes
    // active→superseded exactly like the real pipeline — NOT a manual status
    // UPDATE. This makes the chain faithful: a later 'suggest' v3 (F03/F06) then
    // escalates to supersede an active v2 whose own predecessor is already retired.
    const supersedesItemId = item.intent.supersedesItemId;
    const predEntryId =
      supersedesItemId !== undefined ? state.capture.entryIdByItem.get(supersedesItemId) : undefined;
    let seededId: number;
    if (predEntryId !== undefined) {
      const superseded = await seedSupersedingLessonDirect({
        previousId: predEntryId,
        kind: item.kind,
        title: item.suggest.title,
        summary: item.suggest.summary,
        ...(item.suggest.contentMd !== undefined ? { contentMd: item.suggest.contentMd } : {}),
        source,
        maturityState: "established",
        activationStrength: 1.0,
        influenceScope,
        decayPolicy,
        ...(item.intent.decayExpected === "regime" ? { regimeTags: ["bull"] } : {}),
        outcomeVersion: 0,
      });
      seededId = superseded.id;
      // The predecessor is now `superseded` → drop it from the active-decayable set
      // so the checkpoint advance never re-projects a retired row.
      state.activeEntries.delete(predEntryId);
    } else {
      const seeded = await seedPromotedLessonDirect({
        kind: item.kind,
        title: item.suggest.title,
        summary: item.suggest.summary,
        ...(item.suggest.contentMd !== undefined ? { contentMd: item.suggest.contentMd } : {}),
        source,
        maturityState: "established",
        activationStrength: 1.0,
        influenceScope,
        decayPolicy,
        ...(item.intent.decayExpected === "regime" ? { regimeTags: ["bull"] } : {}),
        outcomeVersion: 0,
      });
      seededId = seeded.id;
    }
    // Backdate the lifecycle anchors to the item's sim-day (first_promoted_at /
    // last_reinforced_at / valid_from), so age + validity read on the sim clock.
    await backdateKnowledgeEntry(
      seededId,
      {
        firstPromotedAt: item.simDay,
        lastReinforcedAt: item.simDay,
        validFrom: item.simDay,
        createdAt: item.simDay,
      },
      simNowDay,
      wallNow,
    );
    state.activeEntries.set(seededId, {
      promotedSimDay: item.simDay,
      lastDecaySimDay: item.simDay,
    });
    state.capture.entryIdByItem.set(item.id, seededId);
    state.capture.perItem.set(item.id, {
      kind: "seed",
      via: "seedPromotedLessonDirect",
      knowledgeId: seededId,
      candidateId: null,
    });
    return;
  }

  // ── seedGemmaCandidate: insert a real-Gemma candidate, THEN drive it through ──
  // ── the REAL door+judge pipeline (driveConsolidateCapturingJudge), exactly  ──
  // ── like the 'suggest' path. These are the recurrence SIBLINGS (the first of ──
  // ── each B/E pair); seeding the candidate directly is the ONLY residual      ──
  // ── scaffold — it bypasses the door's redaction/English/live-state gates,    ──
  // ── which is intentional (the sibling's PURPOSE is to be a clusterable        ──
  // ── recurrence anchor in the judge's view, not to be door-scored). But it    ──
  // ── MUST reach the judge, not stop at the candidate row (the old behavior    ──
  // ── short-circuited here, leaving the judge unreached despite the comment).  ──
  if (item.entryVia === "seedGemmaCandidate") {
    const refs = resolveTradeAnchors(item, state.capture.tradeAnchors);
    const { candidateId } = await seedGemmaCandidate({
      sessionId: state.sessionId,
      kind: item.kind,
      title: item.suggest.title,
      summary: item.suggest.summary,
      ...(item.suggest.contentMd !== undefined ? { contentMd: item.suggest.contentMd } : {}),
      ...(refs.length > 0 ? { evidenceRefs: refs } : {}),
      ...(item.suggest.importance !== undefined ? { importance: item.suggest.importance } : {}),
      ...(item.suggest.confidence !== undefined ? { confidence: item.suggest.confidence } : {}),
      eventTime: new Date(wallNow.getTime()),
    });
    // Backdate the candidate to its sim-day BEFORE driving (age + as-of boundary).
    await backdateCandidate(
      candidateId,
      {
        recordedAt: item.simDay,
        eventTime: item.simDay,
        observedAt: item.simDay,
      },
      simNowDay,
      wallNow,
    );
    await driveJudgePathForCandidate(state, item, candidateId);
    return;
  }

  // ── suggest → real door → judge (the scored-verdict path: A/B-second/C/D/E- ──
  // ── second/F-successor/G-second/H-member/I/K? — all NON-door 'suggest').    ──
  const refs = resolveTradeAnchors(item, state.capture.tradeAnchors);
  const params = mapToSuggestParams(item, refs, eventTimeISO);
  const doorRes = await handleLongMemorySuggest(params, makeContext(state.sessionId));
  const doorData = (doorRes.data ?? {}) as { candidateId?: string; duplicate?: boolean };
  const candidateId = typeof doorData.candidateId === "string" ? doorData.candidateId : null;

  if (doorRes.success !== true || candidateId === null) {
    // A NON-door-class 'suggest' item that the door nonetheless rejected (e.g. an
    // unexpected redaction) — record the door result so the run never loses the
    // item; it does NOT proceed to the judge.
    state.capture.perItem.set(item.id, {
      kind: "door_reject",
      success: doorRes.success === true,
      steering: doorRes.success === true ? null : doorRes.output,
      candidateId,
    });
    return;
  }

  // Backdate the freshly-inserted candidate to the item's sim-day before driving.
  await backdateCandidate(
    candidateId,
    {
      recordedAt: item.simDay,
      eventTime: item.simDay,
      observedAt: item.simDay,
    },
    simNowDay,
    wallNow,
  );

  await driveJudgePathForCandidate(state, item, candidateId);
}

/**
 * Drive ONE backdated candidate through the REAL consolidate door+judge pipeline
 * (`driveConsolidateCapturingJudge`) and record the F31-aware judge capture +
 * track any promoted entry for decay re-projection. Shared by BOTH the
 * `seedGemmaCandidate` path (recurrence siblings) and the `suggest` path
 * (scored-verdict items), so every non-adversarial item reaches the LIVE judge
 * through one seam.
 */
async function driveJudgePathForCandidate(
  state: RunnerState,
  item: MemoryItem,
  candidateId: string,
): Promise<void> {
  const workerId = `e2e-w${state.workerSeq++}`;
  const captured = await driveConsolidateCapturingJudge(candidateId, workerId);
  const drive = captured.drive;
  // `previousKnowledgeId` only exists on the supersede variant of the discriminated
  // DecisionPlan — narrow before reading it.
  const supersedesKnowledgeId =
    drive && drive.plan.type === "supersede" ? drive.plan.previousKnowledgeId : null;
  state.capture.perItem.set(item.id, {
    kind: "judge",
    candidateId,
    reached: captured.reached,
    verdictValid: captured.verdictValid,
    invalidReason: captured.invalidReason,
    decisionType: drive?.decisionType ?? null,
    supersedesKnowledgeId,
    outcomeSignal: drive?.outcome?.lessonSignal ?? null,
    hasGraphPlan: drive?.graphPlan != null,
    latencyMs: captured.latencyMs,
  });

  // If the judge promoted a NEW active entry, track it for decay re-projection
  // AND map the item → its entry id so the S5 snapshot can read the row.
  if (drive?.promotedKnowledgeId != null) {
    state.activeEntries.set(drive.promotedKnowledgeId, {
      promotedSimDay: item.simDay,
      lastDecaySimDay: item.simDay,
    });
    state.capture.entryIdByItem.set(item.id, drive.promotedKnowledgeId);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  THE STREAM LOOP
// ════════════════════════════════════════════════════════════════════════════

export interface RunStreamArgs {
  readonly sessionId: string;
  readonly memories: readonly MemoryItem[];
  readonly trades: readonly TradeEvent[];
  readonly regimes: readonly RegimeEvent[];
}

/**
 * Run the merged event stream ONE ITEM AT A TIME over simulated time, advancing
 * the clock at each new sim-day checkpoint BEFORE processing that day's events.
 * Returns the populated `RunCapture` for the S5 scorer. Never throws on a judge
 * failure (F31) — those land in the per-item capture as invalid/failed.
 */
export async function runStream(args: RunStreamArgs): Promise<RunCapture> {
  const capture: RunCapture = {
    perItem: new Map(),
    tradeAnchors: new Map(),
    regimeSnapshotIds: new Map(),
    processedItemIds: [],
    entryIdByItem: new Map(),
    finalSimDay: 0,
    finalSnapshot: null,
  };
  const state: RunnerState = {
    sessionId: args.sessionId,
    capture,
    activeEntries: new Map(),
    workerSeq: 1,
  };

  const events = buildEventStream(args.memories, args.trades, args.regimes);

  let simNowDay = events.length > 0 ? events[0]!.simDay : 0;
  for (const event of events) {
    // Checkpoint boundary: advance the clock for the elapsed days FIRST.
    if (event.simDay > simNowDay) {
      await advanceClock(state, simNowDay, event.simDay);
      simNowDay = event.simDay;
    }

    switch (event.kind) {
      case "trade":
        await runTradeEvent(state, event.trade);
        break;
      case "regime":
        await runRegimeEvent(state, event.regime, simNowDay);
        break;
      case "memory":
        await runMemoryItem(state, event.item, simNowDay);
        capture.processedItemIds.push(event.item.id);
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(`runStream: unhandled event ${JSON.stringify(_exhaustive)}`);
      }
    }
    if (event.simDay > capture.finalSimDay) capture.finalSimDay = event.simDay;
  }

  return capture;
}
