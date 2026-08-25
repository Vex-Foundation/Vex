/**
 * The failure this pins: a dense run that quietly became a lexical run, or that
 * scored a shrunken catalog, must not be accepted as a measurement. Before the
 * check moved ahead of the writer, an `--update` could record exactly that as
 * the new dense truth.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runBaselineTarget, type BaselineTarget, type MeasuredBaseline } from "./baseline.js";
import { assertDenseMeasurement, findDenseMeasurementViolations } from "./dense-measurement.js";
import { denseTarget, type EvalDataset } from "./eval-targets.js";
import { applyRequiresEnvSentinels } from "./requires-env-sentinels.js";
import { assertFullDiscoveryCandidates } from "./live-catalog.js";
import {
  MRR5_OVERALL_FLOOR,
  RECALL5_BLIND_FLOOR,
  RECALL5_OVERALL_FLOOR,
  RECALL5_PROTOCOL_AWARE_FLOOR,
  assertDenseQualityFloors,
  findQualityFloorViolations,
} from "./dense-quality-floors.js";
import { buildModeReport, type QueryResult, type SeedQuery } from "./retrieval-eval-harness.js";

const query: SeedQuery = {
  query: "bridge USDC to Base",
  awareness: "blind",
  scenario: "bridge",
  intentShape: "single",
  expectedToolIds: ["khalani.bridge.quote"],
  expectedCoverageGroups: [["khalani.bridge.quote"]],
};

function result(overrides: Partial<QueryResult>): QueryResult {
  return {
    query,
    topIds: ["khalani.bridge.quote"],
    hitRank: 0,
    coverageHit: true,
    groupMrr5: 1,
    denseFailed: false,
    retrievalMethod: "dense",
    candidateCount: 134,
    ...overrides,
  };
}

describe("assertDenseMeasurement", () => {
  it("accepts rows that are dense, did not fall back, and saw the full catalog", () => {
    const report = buildModeReport("dense", [result({}), result({})]);
    expect(() => { assertDenseMeasurement(report, 134); }).not.toThrow();
    expect(findDenseMeasurementViolations(report.results, 134)).toEqual([]);
  });

  it("rejects a lexical fallback", () => {
    const report = buildModeReport("dense", [
      result({}),
      result({ retrievalMethod: "lexical", denseFailed: true }),
    ]);
    expect(() => { assertDenseMeasurement(report, 134); }).toThrow(/retrievalMethod: lexical/);
  });

  it("rejects a shrunken candidate set even when the method is dense", () => {
    const report = buildModeReport("dense", [result({ candidateCount: 100 })]);
    expect(() => { assertDenseMeasurement(report, 134); })
      .toThrow(/candidateCount: 100 \(expected 134\)/);
  });

  it("rejects a missing candidateCount", () => {
    const report = buildModeReport("dense", [result({ candidateCount: undefined })]);
    expect(() => { assertDenseMeasurement(report, 134); }).toThrow(/candidateCount: undefined/);
  });

  it("rejects an empty report rather than reporting a vacuous pass", () => {
    expect(() => { assertDenseMeasurement(buildModeReport("dense", []), 134); })
      .toThrow(/evaluated 0 rows/);
  });

  /** Every offending row is named. A truncated list hides the diagnosis. */
  it("reports every offending row in full", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      result({
        query: { ...query, query: `offending query ${index}` },
        retrievalMethod: "lexical",
        denseFailed: true,
      }));
    const report = buildModeReport("dense", rows);
    let message = "";
    try {
      assertDenseMeasurement(report, 134);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (let index = 0; index < 12; index++) {
      expect(message).toContain(`offending query ${index}`);
    }
    expect(message).not.toContain("...");
  });
});

function metric(recall5: number, mrr5: number) {
  return { count: 116, recall1: 0.8, recall5, coverage5: 0.9, mrr5, groupMrr5: 0.9 };
}

function metrics(overallRecall5: number, overallMrr5: number, blind = 1, protocolAware = 1) {
  return {
    overall: metric(overallRecall5, overallMrr5),
    awareness: { blind: metric(blind, blind), protocolAware: metric(protocolAware, protocolAware) },
  };
}

describe("dense quality floors", () => {
  it("accepts a measurement that clears every floor", () => {
    expect(findQualityFloorViolations(metrics(1, 1))).toEqual([]);
  });

  it("names every floor a measurement misses", () => {
    const violations = findQualityFloorViolations(metrics(0.9, 0.5, 0.1, 0.2));
    expect(violations.map((violation) => violation.metric)).toEqual([
      "overall recall@5",
      "overall mrr@5",
      "blind recall@5",
      "protocol-aware recall@5",
    ]);
    expect(violations.map((violation) => violation.floor)).toEqual([
      RECALL5_OVERALL_FLOOR,
      MRR5_OVERALL_FLOOR,
      RECALL5_BLIND_FLOOR,
      RECALL5_PROTOCOL_AWARE_FLOOR,
    ]);
  });

  /** A capture with no awareness split cannot demonstrate the blind floor. */
  it("treats a missing awareness block as a missed floor, not a pass", () => {
    expect(() => { assertDenseQualityFloors({ overall: metric(1, 1) }, "ctx"); })
      .toThrow(/blind recall@5/);
  });
});

/**
 * The defect this pins: `denseTarget` asserted density and the candidate count
 * but applied NO floors, so an `--update` could write a per-namespace dense
 * baseline below the quality the canonical runner refuses to record.
 */
describe("baseline writer protection", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempBaselinePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "vex-eval-floor-"));
    dirs.push(dir);
    return join(dir, "dense-floor-probe.json");
  }

  it("never lets a below-floor measurement reach the baseline writer", async () => {
    const path = tempBaselinePath();
    const target: BaselineTarget = {
      name: "dense / floor probe",
      fileName: "dense-floor-probe.json",
      path,
      expectedCaseCount: 116,
      measure: (): MeasuredBaseline => {
        const measured = metrics(0.4, 0.3, 0.4, 0.4);
        assertDenseQualityFloors(measured, "dense / floor probe");
        return {
          mode: "dense",
          datasetId: "floor-probe",
          datasetVersion: "test-1",
          metrics: measured,
        };
      },
    };

    await expect(runBaselineTarget(target, "update")).rejects.toThrow(/overall recall@5: 0.4 </);
    expect(existsSync(path)).toBe(false);
  });

  it("writes when the same measurement clears the floors", async () => {
    const path = tempBaselinePath();
    const target: BaselineTarget = {
      name: "dense / floor probe",
      fileName: "dense-floor-probe.json",
      path,
      expectedCaseCount: 116,
      measure: (): MeasuredBaseline => {
        const measured = metrics(1, 1);
        assertDenseQualityFloors(measured, "dense / floor probe");
        return {
          mode: "dense",
          datasetId: "floor-probe",
          datasetVersion: "test-1",
          metrics: measured,
        };
      },
    };

    const outcome = await runBaselineTarget(target, "update");
    expect(outcome.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

/**
 * The same protection, exercised THROUGH `denseTarget` itself with a scripted
 * evaluator, so a refactor that dropped the floor or density assertion from the
 * target would fail here rather than only in a test that calls the assertions
 * by hand. The candidate-set gate inside the target reads the live catalog, so
 * the process needs the full catalog visible: the gated Solana tools are made
 * visible with the eval-only sentinel for the duration of this block.
 */
describe("denseTarget gates through the real target", () => {
  const dirs: string[] = [];
  let previousJupiterKey: string | undefined;

  beforeAll(() => {
    previousJupiterKey = process.env.JUPITER_API_KEY;
    applyRequiresEnvSentinels();
  });

  afterAll(() => {
    if (previousJupiterKey === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = previousJupiterKey;
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempBaselinePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "vex-eval-target-"));
    dirs.push(dir);
    return join(dir, "dense-target-probe.json");
  }

  const protocolAwareQuery: SeedQuery = {
    ...query,
    query: "use Khalani to bridge USDC to Base",
    awareness: "protocol-aware",
  };

  const dataset: EvalDataset = {
    datasetId: "target-probe",
    name: "target probe",
    version: "test-1",
    baselineSuffix: "-target-probe",
    queries: [query, protocolAwareQuery],
    validate: () => [],
  };

  /**
   * The candidate count a full-catalog dense row must carry, read from the
   * SAME source the target reads.
   *
   * Derived rather than written as a literal. The literal used elsewhere in
   * this file is deliberate: those cases assert the gate's own arithmetic and
   * want a fixed number. These three cases run the REAL target, which compares
   * against the live catalog, so a literal here is a second source of truth
   * that goes stale every time a tool is added - as it did when the surface
   * moved to 136 and again at 140, in neither case because this file changed.
   */
  function liveCandidateCount(): number {
    return assertFullDiscoveryCandidates("dense-measurement test fixture");
  }

  function scriptedTarget(rows: QueryResult[], path: string): BaselineTarget {
    return {
      ...denseTarget(dataset, { evaluate: async () => buildModeReport("dense", rows) }),
      path,
    };
  }

  it("refuses a below-floor dense measurement before the writer", async () => {
    const path = tempBaselinePath();
    const miss = result({
      topIds: [], hitRank: -1, coverageHit: false, groupMrr5: 0,
      candidateCount: liveCandidateCount(),
    });
    const target = scriptedTarget(
      [miss, { ...miss, query: protocolAwareQuery }],
      path,
    );

    await expect(runBaselineTarget(target, "update")).rejects.toThrow(/overall recall@5: 0 </);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a lexical fallback before the floors are even consulted", async () => {
    const path = tempBaselinePath();
    const target = scriptedTarget(
      [
        result({ candidateCount: liveCandidateCount() }),
        result({
          query: protocolAwareQuery,
          retrievalMethod: "lexical",
          denseFailed: true,
          candidateCount: liveCandidateCount(),
        }),
      ],
      path,
    );

    await expect(runBaselineTarget(target, "update")).rejects.toThrow(/retrievalMethod: lexical/);
    expect(existsSync(path)).toBe(false);
  });

  it("writes when every row is dense over the full catalog and the floors clear", async () => {
    const path = tempBaselinePath();
    const target = scriptedTarget(
      [
        result({ candidateCount: liveCandidateCount() }),
        result({ query: protocolAwareQuery, candidateCount: liveCandidateCount() }),
      ],
      path,
    );

    const outcome = await runBaselineTarget(target, "update");
    expect(outcome.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});
