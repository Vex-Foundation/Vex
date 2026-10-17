import { describe, expect, it } from "vitest";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";

import { formatMegabytes, needsRuntimeScreen, stepRows } from "../bootstrap/steps.js";

const statuses = (rows: ReturnType<typeof stepRows>): string[] => rows.map((r) => r.status);

describe("runtime screen rows", () => {
  it("waits on every step before main has reported anything", () => {
    expect(statuses(stepRows(null))).toEqual(["waiting", "waiting", "waiting"]);
    expect(statuses(stepRows({ seq: 0, phase: "idle" }))).toEqual(["waiting", "waiting", "waiting"]);
  });

  it("finishes the steps before the current one and waits on the rest", () => {
    expect(statuses(stepRows({ seq: 1, phase: "postgres", initializing: false }))).toEqual(["active", "waiting", "waiting"]);
    expect(statuses(stepRows({ seq: 2, phase: "model", model: { state: "checking" } }))).toEqual(["ready", "active", "waiting"]);
    expect(statuses(stepRows({ seq: 3, phase: "embeddings" }))).toEqual(["ready", "ready", "active"]);
    expect(statuses(stepRows({ seq: 4, phase: "ready" }))).toEqual(["ready", "ready", "ready"]);
  });

  it("marks only the failed step failed", () => {
    const rows = stepRows({ seq: 3, phase: "failed", step: "model", kind: "offline", message: "x" });
    expect(statuses(rows)).toEqual(["ready", "failed", "waiting"]);
    expect(rows.every((r) => r.download === null)).toBe(true);
  });

  it("carries the download's numbers on the model row only", () => {
    const rows = stepRows({
      seq: 2,
      phase: "model",
      model: { state: "downloading", receivedBytes: 333_590_944, totalBytes: 333_590_944, bytesPerSecond: 40_000_000 },
    });
    expect(rows[1]).toMatchObject({
      word: "100%",
      detail: "333.6 MB of 333.6 MB · 40.0 MB/s",
      download: { percent: 100, bytes: "333.6 MB of 333.6 MB", speed: "40.0 MB/s" },
    });
    expect(rows[0]?.download).toBeNull();
    expect(formatMegabytes(999_999)).toBe("1.0 MB");
  });
});

describe("needsRuntimeScreen", () => {
  it.each<[NativeRuntimeStatus, boolean]>([
    [{ seq: 0, phase: "idle" }, false],
    [{ seq: 1, phase: "postgres", initializing: true }, false],
    [{ seq: 2, phase: "model", model: { state: "checking" } }, false],
    [{ seq: 2, phase: "model", model: { state: "verifying" } }, true],
    [{ seq: 2, phase: "model", model: { state: "downloading", receivedBytes: 0, totalBytes: 1, bytesPerSecond: null } }, true],
    [{ seq: 3, phase: "embeddings" }, false],
    [{ seq: 4, phase: "ready" }, false],
    [{ seq: 4, phase: "failed", step: "postgres", kind: "failed", message: "x" }, true],
  ])("%o -> %s", (status, expected) => {
    expect(needsRuntimeScreen(status)).toBe(expected);
  });
});
