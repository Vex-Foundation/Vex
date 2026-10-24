/**
 * F06: a mission's model is contract material, frozen for the run.
 *
 *  - the stored choice is read through one normalizer (unreadable = not set);
 *  - the run snapshot freezes the EFFECTIVE model: the contract's, else the
 *    default at start; a pre-v10 snapshot carries none;
 *  - the run loads the frozen model's own config (clamped to the summarizer
 *    window) and NEVER runs another model: a delisted model or one frozen
 *    under the other backend throws `SessionModelUnavailableError`, which the
 *    run's protected try parks in `paused_error`.
 */

import { describe, expect, it, vi } from "vitest";
import type { InferenceConfig } from "@vex-agent/inference/types.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { frozenMissionModel, loadMissionInferenceConfig, normalizeMissionModel } = await import(
  "@vex-agent/engine/mission/model.js"
);
const { buildMissionRunContractSnapshot } = await import("@vex-agent/engine/mission/run-contract.js");
const { SessionModelUnavailableError } = await import("@vex-agent/engine/core/runner/session-model.js");
import type { Mission } from "@vex-agent/db/repos/missions.js";

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const SONNET = { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" } as const;

function config(model: string, contextLimit: number): InferenceConfig {
  return {
    provider: "vexcloud",
    model,
    contextLimit,
    maxOutputTokens: 4_096,
    inputPricePerM: 0,
    outputPricePerM: 0,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };
}

const WINDOWS: Record<string, number> = {
  [DEFAULT_MODEL]: 200_000,
  [SONNET.modelId]: 1_000_000,
  "google/gemini-3.8-flash": 64_000,
};

function provider(id = "vexcloud") {
  return {
    id,
    loadConfig: vi.fn(async (options?: { readonly model?: string }) => {
      const model = options?.model ?? DEFAULT_MODEL;
      const window = WINDOWS[model];
      return window === undefined ? null : config(model, window);
    }),
  };
}

function snapshotWith(model: unknown): Record<string, unknown> {
  return { version: 1, capturedAt: "x", missionPromptContext: "x", frozenMission: { draft: { model } } };
}

function mission(constraintsJson: Record<string, unknown>): Mission {
  const row: Mission = {
    id: "mission-1",
    rootSessionId: "session-1",
    status: "ready",
    title: "t",
    goal: "g",
    riskProfile: null,
    allowedWallets: [],
    allowedChains: [],
    allowedProtocols: [],
    successCriteriaJson: [],
    stopConditionsJson: [],
    capitalSourceJson: {},
    constraintsJson,
    contractHashVersion: 10,
    acceptedContractHash: null,
    acceptedContractAt: null,
    acceptedContractBy: null,
    createdAt: "2026-10-23",
    updatedAt: "2026-10-23",
    approvedAt: null,
    renewedFromMissionId: null,
  };
  return row;
}

describe("normalizeMissionModel / frozenMissionModel", () => {
  it("reads a well-formed choice and nothing else", () => {
    expect(normalizeMissionModel(SONNET)).toEqual(SONNET);
    expect(normalizeMissionModel({ provider: "anthropic", modelId: "x/y" })).toBeNull();
    expect(normalizeMissionModel({ provider: "vexcloud", modelId: "-bad id" })).toBeNull();
    expect(normalizeMissionModel("anthropic/claude")).toBeNull();
    expect(normalizeMissionModel(null)).toBeNull();
  });

  it("a pre-v10 snapshot carries no model", () => {
    expect(frozenMissionModel({ version: 1, frozenMission: { draft: {} } })).toBeNull();
    expect(frozenMissionModel(null)).toBeNull();
    expect(frozenMissionModel(snapshotWith(SONNET))).toEqual(SONNET);
  });
});

describe("buildMissionRunContractSnapshot freezes the effective model", () => {
  const DEFAULT = { provider: "vexcloud", modelId: DEFAULT_MODEL } as const;

  it("the contract's own model wins over the default", () => {
    const snapshot = buildMissionRunContractSnapshot(mission({ model: SONNET }), DEFAULT);
    expect(frozenMissionModel(snapshot)).toEqual(SONNET);
  });

  it("a contract that names none freezes the default at start", () => {
    const snapshot = buildMissionRunContractSnapshot(mission({}), DEFAULT);
    expect(frozenMissionModel(snapshot)).toEqual(DEFAULT);
  });

  it("with no default known, freezes none", () => {
    expect(frozenMissionModel(buildMissionRunContractSnapshot(mission({})))).toBeNull();
  });
});

describe("loadMissionInferenceConfig", () => {
  it("a pre-v10 snapshot runs on the current default, as before", async () => {
    const p = provider();
    const base = config(DEFAULT_MODEL, 200_000);
    expect(await loadMissionInferenceConfig(p, base, snapshotWith(undefined), "session-1")).toBe(base);
    expect(p.loadConfig).not.toHaveBeenCalled();
  });

  it("runs the frozen model, clamped to the summarizer's window", async () => {
    const out = await loadMissionInferenceConfig(
      provider(),
      config(DEFAULT_MODEL, 200_000),
      snapshotWith(SONNET),
      "session-1",
    );
    expect(out.model).toBe(SONNET.modelId);
    expect(out.contextLimit).toBe(200_000);
  });

  it("keeps the run on the frozen model after the default changes", async () => {
    // The default moved to Gemini after start; the run still runs Sonnet.
    const out = await loadMissionInferenceConfig(
      provider(),
      config("google/gemini-3.8-flash", 64_000),
      snapshotWith(SONNET),
      "session-1",
    );
    expect(out.model).toBe(SONNET.modelId);
  });

  it("a delisted frozen model refuses to run, naming it", async () => {
    await expect(
      loadMissionInferenceConfig(
        provider(),
        config(DEFAULT_MODEL, 200_000),
        snapshotWith({ provider: "vexcloud", modelId: "vendor/retired" }),
        "session-1",
      ),
    ).rejects.toMatchObject({ code: "session_model_unavailable", modelId: "vendor/retired", reason: "delisted" });
  });

  it("a model frozen under the other backend refuses to run, never substitutes", async () => {
    const failure = loadMissionInferenceConfig(
      provider("openrouter"),
      config(DEFAULT_MODEL, 200_000),
      snapshotWith(SONNET),
      "session-1",
    );
    await expect(failure).rejects.toBeInstanceOf(SessionModelUnavailableError);
    await expect(failure).rejects.toMatchObject({ reason: "backend_changed" });
  });
});
