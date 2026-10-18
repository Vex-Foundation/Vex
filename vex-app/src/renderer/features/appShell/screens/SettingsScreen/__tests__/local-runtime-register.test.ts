import { describe, expect, it } from "vitest";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";
import { formatDiskSize } from "../local-runtime-copy.js";
import {
  localRuntimeRegisterStatus,
  settingsNav,
  settingsSectionStatus,
  visibleSettingsSections,
} from "../settings-sections.js";

describe("the Local runtime register row", () => {
  it("is listed only on the native runtime, under The agent after Tuning", () => {
    expect(visibleSettingsSections(false).map((s) => s.id)).not.toContain("localRuntime");
    expect(visibleSettingsSections(true)).toHaveLength(visibleSettingsSections(false).length + 1);
    expect(settingsNav(true).find((g) => g.name === "The agent")?.items.map((i) => i.id)).toEqual([
      "model",
      "memory",
      "tuning",
      "localRuntime",
    ]);
    expect(settingsNav(false).flatMap((g) => g.items.map((i) => i.id))).not.toContain("localRuntime");
  });

  it.each<[string, NativeRuntimeStatus | null, string, string]>([
    ["no status yet", null, "-", "neutral"],
    ["a ready runtime", { seq: 3, phase: "ready" }, "Running", "success"],
    ["a start", { seq: 1, phase: "postgres", initializing: false }, "Starting", "neutral"],
    ["a model check", { seq: 2, phase: "model", model: { state: "checking" } }, "Starting", "neutral"],
    ["the embeddings server loading", { seq: 2, phase: "embeddings" }, "Starting", "neutral"],
    ["a deliberate stop", { seq: 4, phase: "idle" }, "Stopped", "neutral"],
    [
      "a failure",
      { seq: 5, phase: "failed", step: "postgres", kind: "disk_full", message: "The disk is full." },
      "Stopped with an error",
      "warning",
    ],
  ])("words %s", (_label, status, word, tone) => {
    expect(localRuntimeRegisterStatus(status)).toEqual({ word, tone });
    // The register reads the runtime status, never envState, for this row.
    expect(settingsSectionStatus("localRuntime", null, null, status)).toEqual({ word, tone });
  });
});

describe("formatDiskSize", () => {
  it("speaks decimal megabytes, like the runtime screen, and gigabytes past a thousand", () => {
    expect(formatDiskSize({ bytes: 333_590_944, files: 1, complete: true })).toBe("333.6 MB");
    expect(formatDiskSize({ bytes: 0, files: 0, complete: true })).toBe("0.0 MB");
    expect(formatDiskSize({ bytes: 2_345_678_901, files: 9, complete: true })).toBe("2.35 GB");
  });

  it("says a measurement that stopped at its bound is a lower bound", () => {
    expect(formatDiskSize({ bytes: 52_000_000, files: 200_000, complete: false })).toBe("at least 52.0 MB");
  });
});
