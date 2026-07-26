/**
 * Time-simulated memory eval — END-TO-END CORRECTNESS RUNNER (S4).
 *
 * Drives the `_world-corpus.ts` stream ONE ITEM AT A TIME through the REAL Vex
 * memory pipeline over SIMULATED time and CAPTURES the per-item + final state for
 * the S5 oracle scorer. S4 PROVES the run executes and the captures populate; it
 * does NOT score against `_oracle.ts` (that is the S5 slice).
 *
 * RETIREMENT NOTE (Agent Scan W4, FIX2): outcome-driven reconciliation is
 * removed — this suite now drives + scores a pure consolidate/graph/decay/
 * retrieval pipeline. The K category (4 items) and the S7 PF03/PF04/LQ03/LQ04
 * reconcile-flip mirrors are gone from the corpus (not replaced); `scoreReconcile`
 * is deleted from `_sim-scorer.ts`.
 *
 * ── DOUBLE ENV GATE (per the plan-gate) ─────────────────────────────────────
 * This is the heaviest eval (~100 live-judge round-trips at full scale), so it is
 * gated behind BOTH `OPENROUTER_API_KEY` (present) AND `VEX_E2E_MEMORY_EVAL=1`.
 * The default `test:eval` run (key present, flag absent) does NOT run this suite.
 * Use the dedicated `test:eval:e2e` script. A 9-item subset (the S4 deliverable)
 * is selected via `VEX_E2E_SUBSET=10` (or the default `SUBSET_IDS`); the full
 * 122-item corpus is S6.
 *
 * ── WHAT S4 ASSERTS ─────────────────────────────────────────────────────────
 *   1. the run executes end-to-end without crashing,
 *   2. the live judge is REACHED for the judge-path items (recordJudgeAttempt > 0),
 *   3. the capture is populated (every processed item has an ItemResult; door
 *      items have a door capture). NO oracle comparison.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { embedDocument } from "@vex-agent/embeddings/client.js";
import { resetDb, makeSession } from "../setup/fixtures.js";
import { reportCard, REPORT_PATH } from "./_report-card.js";
import { ORACLE } from "./_oracle.js";
import { GEMMA_DIM } from "./_eval-fixtures.js";
import type { MemoryItem } from "./_world-corpus.js";
import {
  runStream,
  resolveSubset,
  SUBSET_IDS,
  ALL_CORPUS_IDS,
  type ItemResult,
  type RunCapture,
} from "./_sim-runner.js";
import {
  captureFinalSnapshot,
  scoreDoorRejects,
  scoreSecrets,
  scoreRetrievalMustNotAppear,
  scoreSupersededStatus,
  scoreRejectNoRow,
  scoreDecay,
  scoreClampCeiling,
  scorePromotionCorrectness,
  scoreSupersession,
  scoreGraph,
  scoreSteeredJudge,
  scoreRetrievalPrecision,
  type HardGate,
} from "./_sim-scorer.js";

const SUITE = "e2e-memory-correctness";
const hasKey = !!process.env.OPENROUTER_API_KEY;
const e2eEnabled = process.env.VEX_E2E_MEMORY_EVAL === "1";

/**
 * Resolve which corpus ids this run drives, governed by `VEX_E2E_SUBSET`:
 *   - unset OR "10"   → the canonical 9-item smoke subset (`SUBSET_IDS`).
 *   - "full" OR "100" → ALL corpus ids (the full-corpus path; 122 after the S7
 *     Solana/perp expansion, K category retired) — exercises every supersession
 *     chain, every decay canary, and all retrieval queries.
 *   - numeric N ≤ |SUBSET_IDS| → a defensive slice of the smoke subset (never
 *     exceeds it; a larger N falls back to the full subset).
 */
function selectSubsetIds(): readonly string[] {
  const raw = process.env.VEX_E2E_SUBSET;
  if (raw === undefined || raw === "10") return SUBSET_IDS;
  if (raw === "full" || raw === "100") return ALL_CORPUS_IDS;
  // A numeric override slices the canonical subset (defensive — never exceeds it).
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0 && n <= SUBSET_IDS.length) return SUBSET_IDS.slice(0, n);
  return SUBSET_IDS;
}

describe.skipIf(!hasKey || !e2eEnabled)("eval: e2e memory correctness (live, S4 runner + S5 scorer)", () => {
  beforeAll(async () => {
    await resetDb();
  });

  // ── S5 report flush. This e2e suite is its OWN report owner under the
  // dedicated `test:eval:e2e` invocation (zz-report.int.test.ts does not run
  // when only this file is targeted). Set provenance + flush the graded section
  // here so the report is always produced for an e2e run. ──
  afterAll(async () => {
    let providerModel = process.env.EMBEDDING_MODEL ?? "unknown";
    let dim = GEMMA_DIM;
    try {
      const probe = await embedDocument("report", "provenance probe");
      providerModel = probe.providerModel;
      dim = probe.embedding.length;
    } catch {
      // Best-effort — fall back to configured values.
    }
    reportCard.setProvenance({
      providerModel,
      embeddingModel: process.env.EMBEDDING_MODEL ?? "unknown",
      embeddingDim: dim,
    });
    const md = reportCard.flush(Date.now());
    // eslint-disable-next-line no-console
    console.log(`[e2e-s5] graded report written to ${REPORT_PATH} (${md.length} chars).`);
  });

  it(
    "scores the selected corpus (smoke subset OR full 100) against the pre-registered oracle (hard gates + soft metrics + report)",
    async () => {
      // S4 sanity: the oracle module imports and is internally consistent (its
      // module-load coverage assert ran on import). Not scored against here.
      expect(Object.keys(ORACLE.predictions).length).toBeGreaterThan(0);
      expect(ORACLE.retrieval.length).toBeGreaterThan(0);

      const subsetIds = selectSubsetIds();
      const { memories, trades, regimes } = resolveSubset(subsetIds);

      // One agent session for the whole stream (the faithful seeders need it).
      const sessionId = await makeSession();

      const capture = await runStream({ sessionId, memories, trades, regimes });

      // ── 1. The run processed every chosen memory item. ──
      expect(capture.processedItemIds.length).toBe(subsetIds.length);
      for (const id of subsetIds) {
        expect(capture.perItem.has(id)).toBe(true);
      }

      // ── 2. Tally the per-item captures by kind + feed the F31 headline. ──
      let judgeReached = 0;
      let judgeValid = 0;
      let doorRejects = 0;
      let seeds = 0;
      const verdicts: string[] = [];

      for (const id of subsetIds) {
        const result = capture.perItem.get(id);
        expect(result).toBeDefined();
        if (!result) continue;
        recordItemCapture(id, result);
        switch (result.kind) {
          case "judge": {
            if (result.reached) judgeReached += 1;
            if (result.verdictValid) judgeValid += 1;
            reportCard.recordJudgeAttempt({
              scenario: `${SUITE}/${id}`,
              reached: result.reached,
              valid: result.verdictValid,
              invalidReason: mapInvalidReason(result.invalidReason),
            });
            verdicts.push(
              result.verdictValid
                ? `${id}:${result.decisionType ?? "?"}`
                : `${id}:invalid(${result.invalidReason ?? "?"})`,
            );
            break;
          }
          case "door_reject":
            doorRejects += 1;
            verdicts.push(`${id}:door(${result.success ? "passed" : "rejected"})`);
            break;
          case "seed":
            seeds += 1;
            break;
          default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled item result ${JSON.stringify(_exhaustive)}`);
          }
        }
      }

      // ── 3. The live judge was REACHED for the judge-path items. ──
      // The selected corpus always carries judge-path items (the smoke subset
      // includes A01 / F03 / R01 / B02; the full corpus adds every A/B/C/D/E/F-
      // successor/G-second/H-member/I/N suggest item). At least one must have
      // escalated to the real judge (a call attempted), else the run never
      // exercised the load-bearing live-judge seam.
      expect(judgeReached).toBeGreaterThan(0);

      // eslint-disable-next-line no-console
      console.log(
        `[e2e-s4] processed=${capture.processedItemIds.length} ` +
          `judgeReached=${judgeReached} judgeValid=${judgeValid} ` +
          `doorRejects=${doorRejects} seeds=${seeds}\n` +
          `[e2e-s4] verdicts: ${verdicts.join("  ")}`,
      );

      reportCard.recordCheck(SUITE, {
        label: `S4 runner: ${subsetIds.length}-item corpus executed end-to-end; capture populated; judge reached`,
        pass: true,
        note:
          `processed=${capture.processedItemIds.length} judgeReached=${judgeReached} ` +
          `judgeValid=${judgeValid} doorRejects=${doorRejects} seeds=${seeds}`,
      });

      // ── Honest path-split: how each processed item REACHED the pipeline, so a
      // green run's meaning is explicit (real door+judge vs residual scaffold). ──
      recordPathSplit(memories);

      // ════════════════════════════════════════════════════════════════════
      //  S5 — SNAPSHOT + SCORING
      // ════════════════════════════════════════════════════════════════════
      await runScoringPhase(capture);
    },
    // WALL-CLOCK BOTTLENECK = the live judge. The full corpus escalates ~40–50
    // suggest items to the consolidate judge + tier-raise consults; each call
    // has a 30s timeout (JUDGE_TIMEOUT_MS) and on the F31-prone model many
    // calls run to that cap, so the worst-case wall clock is ~50×30s ≫ the
    // 600s smoke cap. Raise to 30 min for the full path; the smoke subset
    // (9 items) finishes in well under the old 600s.
    1_800_000,
  );
});

/**
 * The S5 snapshot + scoring phase. Reads the REAL final state, then scores it
 * against the pre-registered oracle under the HARD-vs-SOFT firewall:
 *   - SOFT dimensions + precision are recorded via the scorer (recordOracleScore /
 *     recordPrecision / recordFinding) — never assert.
 *   - HARD spec-structural gates are collected as `HardGate[]` and expect()-ed
 *     here, EXCEPT known-gap gates (F5 leakers) which are recorded-not-failed.
 */
async function runScoringPhase(capture: RunCapture): Promise<void> {
  const snapshot = await captureFinalSnapshot(capture);

  // ── SOFT metrics + findings (recorded; never red the suite). ──
  scorePromotionCorrectness(capture);
  scoreSupersession(capture);
  scoreGraph(capture, snapshot);
  scoreSteeredJudge(capture, snapshot);
  scoreRetrievalPrecision(capture, snapshot);

  // ── HARD gates (+ their internal soft/finding rows). ──
  const hardGates: HardGate[] = [
    ...scoreDoorRejects(capture),
    ...(await scoreSecrets(capture, snapshot)),
    ...(await scoreRetrievalMustNotAppear(capture, snapshot)),
    ...scoreSupersededStatus(capture, snapshot),
    ...scoreRejectNoRow(capture),
    ...scoreDecay(capture, snapshot),
    ...scoreClampCeiling(capture, snapshot),
  ];

  // Partition: known-gap gates are FINDINGS (recorded by the scorer), never red.
  const enforced = hardGates.filter((g) => !g.knownGap);
  const knownGaps = hardGates.filter((g) => g.knownGap);
  const enforcedFailures = enforced.filter((g) => !g.pass);

  // eslint-disable-next-line no-console
  console.log(
    `[e2e-s5] hard gates: ${enforced.length} enforced (${enforcedFailures.length} failing), ` +
      `${knownGaps.length} known-gap (recorded-not-failed).\n` +
      `[e2e-s5] enforced failures: ${enforcedFailures.map((g) => `${g.id}{${g.detail}}`).join("  ") || "none"}\n` +
      `[e2e-s5] known gaps: ${knownGaps.map((g) => `${g.id}{${g.detail}}`).join("  ") || "none"}`,
  );

  reportCard.recordCheck(SUITE, {
    label: "S5 scorer: hard gates evaluated; soft metrics + findings recorded",
    pass: enforcedFailures.length === 0,
    note: `enforced=${enforced.length} failing=${enforcedFailures.length} knownGap=${knownGaps.length}`,
  });

  // HARD assertion: every ENFORCED spec-structural gate passes. A failure here is
  // a REAL correctness bug (the firewall — known gaps are excluded above).
  for (const gate of enforced) {
    expect(gate.pass, `hard gate ${gate.id} failed: ${gate.detail}`).toBe(true);
  }
}

/** Record one per-item capture as a metrics-only check row (no candidate text). */
function recordItemCapture(id: string, result: ItemResult): void {
  switch (result.kind) {
    case "judge": {
      // A judge-path item that did NOT reach the LLM was terminated by the
      // deterministic stage (near-dup / recurrence-first-sibling / premature-
      // generalization) — correct pipeline behavior, NOT a failure. Label it a
      // deterministic terminal; only a reached-but-INVALID verdict (F31) is a fail.
      const terminal = !result.reached;
      reportCard.recordCheck(SUITE, {
        label: `item ${id}: ${terminal ? "deterministic terminal" : "judge path"}`,
        pass: terminal ? true : result.verdictValid,
        note: terminal
          ? "not escalated — deterministic stage terminated (near-dup / recurrence-first / premature_generalization)"
          : result.verdictValid
            ? `valid verdict=${result.decisionType ?? "?"} supersedes=${result.supersedesKnowledgeId ?? "—"} graphPlan=${result.hasGraphPlan}`
            : `reached but invalid=${result.invalidReason ?? "—"} (F31)`,
      });
      break;
    }
    case "door_reject":
      reportCard.recordCheck(SUITE, {
        label: `item ${id}: door`,
        pass: true,
        note: `success=${result.success} candidate=${result.candidateId ? "yes" : "no"}`,
      });
      break;
    case "seed":
      reportCard.recordCheck(SUITE, {
        label: `item ${id}: seed`,
        pass: true,
        note: `via=${result.via} knowledgeId=${result.knowledgeId ?? "—"} candidate=${result.candidateId ? "yes" : "no"}`,
      });
      break;
    default: {
      const _exhaustive: never = result;
      throw new Error(`recordItemCapture: unhandled ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Map the runner's bounded invalid-reason string to the report-card enum. */
function mapInvalidReason(
  reason: string | null,
):
  | "schema_invalid"
  | "judge_timeout"
  | "judge_malformed"
  | "provider_config"
  | "judge_unknown"
  | null {
  switch (reason) {
    case "schema_invalid":
    case "judge_timeout":
    case "judge_malformed":
    case "provider_config":
    case "judge_unknown":
      return reason;
    case null:
      return null;
    default:
      return "judge_unknown";
  }
}

/**
 * The reason the LIVE judge cannot bootstrap a residual `seedPromotedLessonDirect`
 * precondition, by corpus category. Each is a genuine pipeline-bootstrap limit
 * (the item's PRE-EXISTING state must exist BEFORE the scored item runs), so the
 * row is seeded directly and reported with this scaffold reason. Bounded strings only.
 */
function scaffoldReasonFor(item: MemoryItem): string {
  switch (item.category) {
    case "F":
      return "supersession predecessor (an active prior-version entry the later 'suggest' successor must supersede) — must pre-exist before the successor is judged";
    case "G":
      return "conflict-pair baseline (an active claim the later 'suggest' rival contradicts) — must pre-exist before the rival is judged";
    case "H":
      return "graph-cluster owner node (a pre-existing active node sibling members link to) — must exist before cluster members are judged";
    case "L":
      return "regime-bound decay owner (a bull-tagged active entry aged via the real sweep, then it decays once the effective regime turns bear)";
    case "M":
      return "time-only decay owner (an active entry aged via the real decay sweep over the sim window)";
    // ── S7 expansion seeded categories (same precondition classes as above). ──
    case "LQ":
      return "supersession predecessor (the active prior margin-buffer thesis the post-mortem successor supersedes) — must pre-exist before the successor is judged";
    case "RG":
      return "rug-pattern graph-cluster owner (a pre-existing active node the rug/honeypot members link to) — must exist before cluster members are judged";
    case "PB":
      return "perp basis/leverage precondition: either a conflict-pair baseline (the active claim the later rival contradicts) or a regime-bound decay owner (a high-vol-bull-tagged entry aged via the sweep that decays once the effective regime turns bear) — must pre-exist the scored event";
    case "DP":
      return "stablecoin-depeg precondition: either a time-only decay owner (a regime-neutral playbook note aged via the sweep) or a supersession predecessor (the active wait-for-recovery thesis the refined rule supersedes) — must pre-exist the scored event";
    case "XV":
      return "cross-venue supersession predecessor (the active SPOT thesis the later PERP-evidence 'suggest' successor supersedes across kind+venue, the F7 surface) — must pre-exist before the successor is judged";
    default:
      return "direct-seed scaffold (judge cannot bootstrap this pre-existing precondition)";
  }
}

/**
 * Compute + record the honest entry-path distribution for the processed corpus.
 * Classification is by the corpus authoring intent (NOT the capture kind) so the
 * report reflects HOW each item was designed to reach the pipeline:
 *   - door-only adversarial: `intent.adversarial` set (N/O/P/Q/R),
 *   - full door→judge:       `entryVia === 'suggest'` and non-adversarial,
 *   - judge via seeded cand:  `entryVia === 'seedGemmaCandidate'` (recurrence sibling),
 *   - residual direct-seed:   `entryVia === 'seedPromotedLessonDirect'` (scaffold).
 */
function recordPathSplit(memories: readonly MemoryItem[]): void {
  let fullDoorJudge = 0;
  let judgeViaCandidate = 0;
  let doorOnlyAdversarial = 0;
  let directSeedScaffold = 0;
  const scaffoldReasons: Record<string, string> = {};

  for (const item of memories) {
    if (item.intent.adversarial !== undefined) {
      doorOnlyAdversarial += 1;
    } else if (item.entryVia === "seedPromotedLessonDirect") {
      directSeedScaffold += 1;
      scaffoldReasons[item.id] = scaffoldReasonFor(item);
    } else if (item.entryVia === "seedGemmaCandidate") {
      judgeViaCandidate += 1;
    } else {
      fullDoorJudge += 1;
    }
  }

  reportCard.recordPathSplit({
    suite: SUITE,
    fullDoorJudge,
    judgeViaCandidate,
    doorOnlyAdversarial,
    directSeedScaffold,
    scaffoldReasons,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[e2e-path-split] fullDoorJudge=${fullDoorJudge} judgeViaCandidate=${judgeViaCandidate} ` +
      `doorOnlyAdversarial=${doorOnlyAdversarial} directSeedScaffold=${directSeedScaffold}`,
  );
}
