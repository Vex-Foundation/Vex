/**
 * Unit tests for the baseline check/update tooling itself.
 *
 * These are stack-free and deterministic, so they run in the default
 * `pnpm test`. They prove the properties the eval gate depends on: check never
 * writes, update is the only writer and records provenance, drift is named,
 * and a zero-case run fails instead of passing silently.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertEvaluatedCaseCount,
  compareBaseline,
  formatComparison,
  resolveBaselineMode,
  runBaselineTarget,
  writeBaseline,
  type BaselineFile,
  type BaselineMetrics,
  type BaselineTarget,
  type MeasuredBaseline,
  type Metric,
} from "./baseline.js";
import { readBaseline } from "./baseline/store.js";

function metric(overrides: Partial<Metric> = {}): Metric {
  return {
    count: 10,
    recall1: 0.5,
    recall5: 0.8,
    coverage5: 0.7,
    mrr5: 0.6,
    groupMrr5: 0.55,
    ...overrides,
  };
}

function metrics(overrides: Partial<Metric> = {}): BaselineMetrics {
  return { overall: metric(overrides) };
}

function measured(overrides: Partial<MeasuredBaseline> = {}): MeasuredBaseline {
  return {
    mode: "lexical",
    datasetId: "tool-discovery-seed",
    datasetVersion: "v3-agent-116",
    metrics: metrics(),
    ...overrides,
  };
}

function baselineFile(overrides: Partial<BaselineFile> = {}): BaselineFile {
  return {
    version: "v3-agent-116",
    mode: "lexical",
    datasetId: "tool-discovery-seed",
    datasetVersion: "v3-agent-116",
    status: "captured",
    capturedAt: "2026-01-01T00:00:00.000Z",
    metrics: metrics(),
    ...overrides,
  };
}

describe("resolveBaselineMode", () => {
  it("defaults to check when neither flag nor env is given", () => {
    expect(resolveBaselineMode([], {})).toBe("check");
  });

  it("honours explicit flags and the env fallback", () => {
    expect(resolveBaselineMode(["--check"], {})).toBe("check");
    expect(resolveBaselineMode(["--update"], {})).toBe("update");
    expect(resolveBaselineMode([], { VEX_EVAL_BASELINE_MODE: "update" })).toBe("update");
  });

  it("lets an explicit flag win over the env variable", () => {
    expect(resolveBaselineMode(["--check"], { VEX_EVAL_BASELINE_MODE: "update" })).toBe("check");
  });

  it("rejects both flags at once and an unknown env value by name", () => {
    expect(() => resolveBaselineMode(["--check", "--update"], {}))
      .toThrow(/mutually exclusive/);
    expect(() => resolveBaselineMode([], { VEX_EVAL_BASELINE_MODE: "refresh" }))
      .toThrow(/not a valid baseline mode/);
  });
});

describe("compareBaseline", () => {
  it("reports ok with no drift for identical metrics", () => {
    const comparison = compareBaseline(baselineFile(), measured());
    expect(comparison.ok).toBe(true);
    expect(comparison.metricDrift).toEqual([]);
    expect(comparison.identityDrift).toEqual([]);
  });

  it("names each moved metric with its signed delta", () => {
    const comparison = compareBaseline(
      baselineFile(),
      measured({ metrics: metrics({ recall5: 0.7 }) }),
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.metricDrift).toEqual([
      { path: "overall.recall5", baseline: 0.8, measured: 0.7, delta: expect.closeTo(-0.1, 10) },
    ]);
  });

  it("has no tolerance — a three-decimal move is drift", () => {
    const comparison = compareBaseline(
      baselineFile(),
      measured({ metrics: metrics({ mrr5: 0.601 }) }),
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.metricDrift.map((drift) => drift.path)).toEqual(["overall.mrr5"]);
  });

  it("flags a dataset-version mismatch as identity drift, not as metric noise", () => {
    const stale = baselineFile({
      datasetVersion: "v3-agent-200",
      metrics: metrics({ count: 200 }),
    });
    const comparison = compareBaseline(stale, measured({ metrics: metrics({ count: 116 }) }));

    expect(comparison.identityDrift).toEqual([
      { field: "datasetVersion", baseline: "v3-agent-200", measured: "v3-agent-116" },
    ]);
    expect(formatComparison(comparison, "/tmp/x.json"))
      .toContain("captured against a different contract");
  });

  it("tolerates a legacy baseline with no datasetId but compares one that has it", () => {
    const legacy: BaselineFile = { ...baselineFile() };
    delete legacy.datasetId;
    expect(compareBaseline(legacy, measured()).identityDrift).toEqual([]);

    expect(
      compareBaseline(baselineFile(), measured({ datasetId: "tool-discovery-supplemental" }))
        .identityDrift,
    ).toEqual([
      {
        field: "datasetId",
        baseline: "tool-discovery-seed",
        measured: "tool-discovery-supplemental",
      },
    ]);
  });

  it("reports a section present on one side only as a structural problem", () => {
    const withSections = baselineFile({
      metrics: {
        overall: metric(),
        awareness: { blind: metric(), protocolAware: metric() },
      },
    });
    const comparison = compareBaseline(withSections, measured());
    expect(comparison.ok).toBe(false);
    expect(comparison.structuralProblems).toEqual([
      'section "awareness" is in the baseline but was not measured',
    ]);
  });
});

describe("assertEvaluatedCaseCount", () => {
  it("fails a zero-case run by name instead of passing silently", () => {
    expect(() => assertEvaluatedCaseCount(0, 116, "dense / seed"))
      .toThrow(/evaluated 0 of 116 cases/);
    expect(() => assertEvaluatedCaseCount(0, 116, "dense / seed"))
      .toThrow(/missing embedding endpoint/);
  });

  it("fails a partially evaluated run", () => {
    expect(() => assertEvaluatedCaseCount(90, 116, "dense / seed"))
      .toThrow(/evaluated 90 of 116 cases/);
  });

  it("accepts a fully evaluated run", () => {
    expect(() => assertEvaluatedCaseCount(116, 116, "dense / seed")).not.toThrow();
  });
});

describe("runBaselineTarget", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "vex-baseline-"));
    path = join(directory, "baseline.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Always pinned to a temp path — these tests never touch real baselines. */
  function target(overrides: Partial<BaselineTarget> = {}): BaselineTarget {
    return {
      name: "test target",
      fileName: "baseline.json",
      path,
      expectedCaseCount: 10,
      measure: () => measured(),
      ...overrides,
    };
  }

  it("fails a check when no baseline exists yet", async () => {
    const outcome = await runBaselineTarget(target(), "check");
    expect(outcome.ok).toBe(false);
    expect(outcome.report).toContain("no baseline at");
  });

  it("captures on update, then passes a check against what it wrote", async () => {
    const update = await runBaselineTarget(target(), "update");
    expect(update.ok).toBe(true);
    expect(update.report).toContain("baseline UPDATED");
    expect(update.report).toContain("First capture");

    const check = await runBaselineTarget(target(), "check");
    expect(check.ok).toBe(true);
    expect(check.report).toContain("Baseline check PASSED");
  });

  it("records the measured delta and a reconciliation block on a dataset change", async () => {
    await runBaselineTarget(
      target({
        measure: () => measured({
          datasetVersion: "v3-agent-200",
          metrics: metrics({ count: 200, recall5: 0.76 }),
        }),
        expectedCaseCount: 200,
      }),
      "update",
    );

    const outcome = await runBaselineTarget(target(), "update");
    expect(outcome.report).toContain("Measured delta vs previous baseline");
    expect(outcome.report).toContain("case count 200 -> 10");

    const written = readBaseline(path);
    expect(written?.datasetVersion).toBe("v3-agent-116");
    expect(written?.reconciliation?.previousVersion).toBe("v3-agent-200");
    expect(written?.reconciliation?.previousCaseCount).toBe(200);
    expect(written?.reconciliation?.reason).toContain("STALE");
  });

  it("fails a check and names the drift when metrics move", async () => {
    await runBaselineTarget(target(), "update");

    const outcome = await runBaselineTarget(
      target({ measure: () => measured({ metrics: metrics({ recall5: 0.3 }) }) }),
      "check",
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.report).toContain("overall.recall5: 0.8 -> 0.3 (-0.5)");
  });

  it("propagates the zero-case failure before any comparison", async () => {
    await expect(
      runBaselineTarget(
        target({ measure: () => measured({ metrics: metrics({ count: 0 }) }) }),
        "check",
      ),
    ).rejects.toThrow(/evaluated 0 of 10 cases/);
  });

  it("leaves the baseline file byte-identical on a passing check", async () => {
    writeBaseline(path, { measured: measured() });
    const before = readFileSync(path, "utf8");
    const modifiedBefore = statSync(path).mtimeMs;

    const outcome = await runBaselineTarget(target(), "check");

    expect(outcome.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(modifiedBefore);
  });

  it("leaves the baseline file byte-identical on a FAILING check", async () => {
    writeBaseline(path, { measured: measured() });
    const before = readFileSync(path, "utf8");
    const modifiedBefore = statSync(path).mtimeMs;

    const outcome = await runBaselineTarget(
      target({ measure: () => measured({ metrics: metrics({ recall5: 0.1 }) }) }),
      "check",
    );

    expect(outcome.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(modifiedBefore);
  });
});

describe("writeBaseline", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "vex-baseline-write-"));
    path = join(directory, "baseline.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("records the dataset version and the measured metrics", () => {
    const written = writeBaseline(path, {
      measured: measured(),
      notes: ["overall recall@5 0.8"],
    });

    expect(written.datasetVersion).toBe("v3-agent-116");
    expect(written.datasetId).toBe("tool-discovery-seed");
    expect(written.status).toBe("captured");
    expect(written.notes).toEqual(["overall recall@5 0.8"]);
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
  });

  it("round-trips through readBaseline", () => {
    writeBaseline(path, { measured: measured() });
    const reloaded = readBaseline(path);
    expect(reloaded?.metrics.overall.recall5).toBe(0.8);
  });

  it("writes a canonical file — a rewrite with identical metrics differs only in capturedAt", () => {
    writeBaseline(path, { measured: measured() });
    const first = readFileSync(path, "utf8");
    writeBaseline(path, { measured: measured() });
    const second = readFileSync(path, "utf8");

    const stripTimestamp = (json: string): string =>
      json.replace(/"capturedAt": "[^"]+"/, '"capturedAt": "<ts>"');
    expect(stripTimestamp(second)).toBe(stripTimestamp(first));
  });

  it("rejects an invalid baseline instead of writing it", () => {
    expect(() =>
      writeBaseline(path, { measured: measured({ metrics: metrics({ recall5: 1.5 }) }) }),
    ).toThrow();
  });

  it("names a corrupt baseline file rather than treating it as absent", () => {
    writeFileSync(path, "{ not json", "utf8");
    expect(() => readBaseline(path)).toThrow(/not valid JSON/);

    writeFileSync(path, JSON.stringify({ version: "x" }), "utf8");
    expect(() => readBaseline(path)).toThrow(/does not match the baseline contract/);
  });
});
