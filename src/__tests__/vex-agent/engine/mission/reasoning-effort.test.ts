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
  missionDefaultReasoningEffortFor,
} from "@vex-agent/engine/mission/reasoning-effort.js";
import { extractMissionPatch, sanitizePatch } from "@vex-agent/engine/mission/patch-parser.js";
import { MISSION_DEFAULT_REASONING_EFFORT, type MissionReasoningEffort } from "@vex-agent/engine/types.js";
import { buildMissionRunContractSnapshot } from "@vex-agent/engine/mission/run-contract.js";
import type { Mission } from "@vex-agent/db/repos/missions.js";
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
  it("defaults to high", () => {
    expect(MISSION_DEFAULT_REASONING_EFFORT).toBe("high");
    expect(effectiveMissionReasoningEffort(null)).toBe("high");
    expect(effectiveMissionReasoningEffort(undefined)).toBe("high");
    expect(effectiveMissionReasoningEffort("low")).toBe("low");
  });

  it("keeps the medium default a v8-or-older acceptance was bound to", () => {
    expect(missionDefaultReasoningEffortFor(7)).toBe("medium");
    expect(missionDefaultReasoningEffortFor(8)).toBe("medium");
    expect(missionDefaultReasoningEffortFor(9)).toBe("high");
    expect(missionDefaultReasoningEffortFor(null)).toBe("high");
    expect(effectiveMissionReasoningEffort(null, missionDefaultReasoningEffortFor(8))).toBe("medium");
  });

  it("reads an unknown stored value as not set", () => {
    expect(normalizeMissionReasoningEffort("turbo")).toBeNull();
    expect(normalizeMissionReasoningEffort(3)).toBeNull();
  });

  it("freezes the effective effort into the run snapshot, by the acceptance's hash version", () => {
    const mission = (constraintsJson: Record<string, unknown>, contractHashVersion: number | null): Mission => ({
      id: "m-1",
      rootSessionId: "s-1",
      status: "ready",
      title: "ETH check",
      goal: "check",
      constraintsJson,
      successCriteriaJson: [],
      stopConditionsJson: [],
      riskProfile: "conservative",
      capitalSourceJson: {},
      allowedProtocols: [],
      allowedChains: ["ethereum"],
      allowedWallets: [],
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
      approvedAt: "2026-09-30T00:00:00.000Z",
      acceptedContractHash: null,
      acceptedContractAt: null,
      acceptedContractBy: null,
      contractHashVersion,
      renewedFromMissionId: null,
    });
    const frozen = (m: Mission): MissionReasoningEffort =>
      frozenMissionReasoningEffort(buildMissionRunContractSnapshot(m));
    expect(frozen(mission({}, 9))).toBe("high");
    expect(frozen(mission({}, 8))).toBe("medium");
    expect(frozen(mission({ reasoningEffort: "low" }, 9))).toBe("low");
    expect(frozen(mission({ reasoningEffort: "max" }, 8))).toBe("max");
  });

  it("reads the frozen effort from the run's contract snapshot", () => {
    expect(frozenMissionReasoningEffort({ frozenMission: { draft: { reasoningEffort: "low" } } })).toBe("low");
  });

  it("runs a snapshot captured before E-1, or a malformed one, at medium", () => {
    expect(frozenMissionReasoningEffort({ frozenMission: { draft: { durationMinutes: 5 } } })).toBe("medium");
    expect(frozenMissionReasoningEffort(null)).toBe("medium");
    expect(frozenMissionReasoningEffort({ frozenMission: "x" })).toBe("medium");
  });

  it("applies the effort over any composer pick, raised to the model, never lowered", () => {
    const withPick = config({ reasoningEffort: "max", reasoningSupport: { efforts: ["low", "high"] } });
    expect(withMissionReasoningEffort(withPick, "medium").reasoningEffort).toBe("high");
    expect(withMissionReasoningEffort(withPick, "low").reasoningEffort).toBe("low");
    // Nothing at or above the request: the model's highest level, the closest it accepts.
    expect(withMissionReasoningEffort(withPick, "max").reasoningEffort).toBe("high");
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
