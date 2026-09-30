/**
 * Kairos E-1: the mission contract's `reasoningEffort` - default medium,
 * frozen per run, clamped to the model (never higher), and writable through
 * `MissionDraftUpdate`'s patch boundary as an enum only.
 */

import { describe, expect, it } from "vitest";

import {
  effectiveMissionReasoningEffort,
  frozenMissionReasoningEffort,
  normalizeMissionReasoningEffort,
  withMissionReasoningEffort,
} from "@vex-agent/engine/mission/reasoning-effort.js";
import { extractMissionPatch, sanitizePatch } from "@vex-agent/engine/mission/patch-parser.js";
import { MISSION_DEFAULT_REASONING_EFFORT } from "@vex-agent/engine/types.js";
import type { InferenceConfig } from "@vex-agent/inference/types.js";

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    contextLimit: 256_000,
    maxOutputTokens: 16_384,
    inputPricePerM: 0,
    outputPricePerM: 0,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: true,
    ...overrides,
  };
}

function sanitized(raw: unknown): unknown {
  const patch = extractMissionPatch(raw);
  if (patch === null) return "no-patch";
  return sanitizePatch(patch);
}

describe("mission reasoning effort", () => {
  it("defaults to medium", () => {
    expect(MISSION_DEFAULT_REASONING_EFFORT).toBe("medium");
    expect(effectiveMissionReasoningEffort(null)).toBe("medium");
    expect(effectiveMissionReasoningEffort(undefined)).toBe("medium");
    expect(effectiveMissionReasoningEffort("high")).toBe("high");
  });

  it("reads an unknown stored value as not set", () => {
    expect(normalizeMissionReasoningEffort("turbo")).toBeNull();
    expect(normalizeMissionReasoningEffort(3)).toBeNull();
  });

  it("reads the frozen effort from the run's contract snapshot", () => {
    expect(frozenMissionReasoningEffort({ frozenMission: { draft: { reasoningEffort: "low" } } })).toBe("low");
  });

  it("runs a snapshot captured before E-1, or a malformed one, at medium", () => {
    expect(frozenMissionReasoningEffort({ frozenMission: { draft: { durationMinutes: 5 } } })).toBe("medium");
    expect(frozenMissionReasoningEffort(null)).toBe("medium");
    expect(frozenMissionReasoningEffort({ frozenMission: "x" })).toBe("medium");
  });

  it("applies the effort over any composer pick, clamped down to the model", () => {
    const withPick = config({ reasoningEffort: "max", reasoningSupport: { efforts: ["low", "high"] } });
    expect(withMissionReasoningEffort(withPick, "medium").reasoningEffort).toBe("low");
    expect(withMissionReasoningEffort(config(), "high").reasoningEffort).toBe("high");
    expect(withPick.reasoningEffort).toBe("max");
  });
});

describe("MissionDraftUpdate patch boundary", () => {
  it("accepts a known effort, trimmed and case-insensitive", () => {
    expect(sanitized({ reasoningEffort: " High " })).toEqual({ reasoningEffort: "high" });
  });

  it("keeps an explicit null as a clear", () => {
    expect(sanitized({ reasoningEffort: null })).toEqual({ reasoningEffort: null });
  });

  it("rejects an unknown or wrong-typed value without writing", () => {
    expect(sanitized({ reasoningEffort: "turbo" })).toEqual({});
    expect(sanitized({ reasoningEffort: 3 })).toEqual({});
  });
});
