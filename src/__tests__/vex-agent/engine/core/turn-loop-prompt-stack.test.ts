/**
 * `buildTurnPromptStack` output pin.
 *
 * The prompt stack's independent reads (mission capital banner, bridge view,
 * resume packet, memory façade, plan read) run concurrently. That is a latency
 * change ONLY: for the same inputs the produced `PromptStackOptions` must be
 * deep-equal to the sequential build, INCLUDING key insertion order, and the
 * one-shot plan off-notice must still be consumed exactly once, after its own
 * plan read, and never when the stack build fails.
 *
 * Every collaborator is a deterministic fake that returns a value tagged with
 * its inputs, so the pin proves both what each layer received and where its
 * output landed. This suite was run green against the sequential build first;
 * the same suite passing on the concurrent build is the parity proof.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MissionBaseline } from "@vex-agent/engine/mission/baseline.js";
import type { PromptStackOptions } from "@vex-agent/engine/prompts/index.js";
import { makeEngineContext } from "../_engine-context.js";

const events: string[] = [];

const mockGetSession = vi.fn();
const mockBuildOwnTokenBanner = vi.fn();
const mockBuildMissionCapitalBanner = vi.fn();
const mockBuildResumePacket = vi.fn();
const mockGetBridgeCapabilityView = vi.fn();
const mockGetTurnContext = vi.fn();
const mockGetActivePlan = vi.fn();
const mockConsumeOffNotice = vi.fn();
const mockGetOpenAITools = vi.fn();

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));
vi.mock("@vex-agent/engine/prompts/context-pressure.js", () => ({
  buildContextPressureBanner: (band: string, fraction: number, prep: { kind: string }) =>
    `pressure:${band}:${fraction}:${prep.kind}`,
}));
vi.mock("@vex-agent/engine/prompts/own-token-banner.js", () => ({
  buildOwnTokenBanner: (...a: unknown[]) => mockBuildOwnTokenBanner(...a),
}));
vi.mock("@vex-agent/engine/prompts/mission-capital-banner.js", () => ({
  buildMissionCapitalBanner: (...a: unknown[]) => mockBuildMissionCapitalBanner(...a),
}));
vi.mock("@vex-agent/engine/prompts/resume-packet.js", () => ({
  buildResumePacket: (...a: unknown[]) => mockBuildResumePacket(...a),
}));
vi.mock("@vex-agent/engine/prompts/tool-catalog.js", () => ({
  buildToolCatalogPrompt: (ctx: { hasSessionMemory: boolean; contextUsageBand: string }) =>
    `catalog:memory=${String(ctx.hasSessionMemory)}:band=${ctx.contextUsageBand}`,
}));
vi.mock("@vex-agent/engine/prompts/protocols.js", () => ({
  buildBridgeCapabilityPrompt: (view: { kind: string }) => `bridge:${view.kind}`,
}));
vi.mock("@vex-agent/tools/protocols/khalani/capability-snapshot.js", () => ({
  getBridgeCapabilityView: (...a: unknown[]) => mockGetBridgeCapabilityView(...a),
}));
vi.mock("@vex-agent/engine/prompts/memory-section.js", () => ({
  buildMemorySection: (ctx: { sessionStats: { activeCount: number } | null }) =>
    `memory:${ctx.sessionStats === null ? "failed" : String(ctx.sessionStats.activeCount)}`,
}));
vi.mock("@vex-agent/memory/turn-context.js", () => ({
  getTurnContext: (...a: unknown[]) => mockGetTurnContext(...a),
}));
vi.mock("@vex-agent/db/repos/session-plans.js", () => ({
  getActivePlan: (...a: unknown[]) => mockGetActivePlan(...a),
  consumeOffNotice: (...a: unknown[]) => mockConsumeOffNotice(...a),
}));
vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: (...a: unknown[]) => mockGetOpenAITools(...a),
}));
vi.mock("@vex-agent/engine/core/runner/shared.js", () => ({
  toToolDefinitions: (tools: readonly { name: string }[]) => tools.map((t) => ({ def: t.name })),
}));

const { buildTurnPromptStack } = await import("@vex-agent/engine/core/turn-loop-prompt-stack.js");
const { PLAN_OFF_NOTICE, buildActivePlanBlock } = await import("@vex-agent/engine/prompts/plan.js");

const BASELINE: MissionBaseline = {
  version: 1,
  capturedAt: "2026-08-10T13:12:30.000Z",
  status: "absent",
  reasons: ["no_projection_rows"],
  source: "proj_balances",
  scope: { addresses: ["0xAAA"] },
  portfolio: null,
  deployedCapitalAtStart: null,
};

/** Resolve on a later macrotask so every fake genuinely yields. */
function later<T>(label: string, value: T, delayMs = 1): Promise<T> {
  events.push(`start:${label}`);
  return new Promise((resolve) => {
    setTimeout(() => {
      events.push(`end:${label}`);
      resolve(value);
    }, delayMs);
  });
}

function laterReject(label: string, message: string): Promise<never> {
  events.push(`start:${label}`);
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      events.push(`end:${label}`);
      reject(new Error(message));
    }, 1);
  });
}

function installDefaultFakes(): void {
  mockBuildOwnTokenBanner.mockImplementation(() => later("own", "own-banner"));
  mockBuildMissionCapitalBanner.mockImplementation((baseline: MissionBaseline | null) =>
    later("capital", `capital:${baseline === null ? "none" : baseline.status}`),
  );
  mockGetBridgeCapabilityView.mockImplementation(() => later("bridge", { kind: "unavailable" }));
  mockGetSession.mockImplementation((id: string) => later("session", { id, checkpointGeneration: 7 }));
  mockBuildResumePacket.mockImplementation((id: string, generation: number) =>
    later("resume", `resume:${id}:${generation}`),
  );
  mockGetTurnContext.mockImplementation((input: { sessionId: string }) =>
    later("memory", {
      knowledge: null,
      sessionStats: { activeCount: input.sessionId === "s-1" ? 3 : 0 },
    }),
  );
  mockGetActivePlan.mockImplementation(() => later("plan", { offNoticePending: true }));
  mockConsumeOffNotice.mockImplementation(() => later("consume", undefined));
  mockGetOpenAITools.mockImplementation((ctx: { hasSessionMemory: boolean }) => [
    { name: `tool:memory=${String(ctx.hasSessionMemory)}` },
  ]);
}

const BASE_OPTIONS: PromptStackOptions = { cutoffContinuationNote: "base-note" };

function stackArgs(overrides: {
  readonly missionRunId?: string | null;
  readonly planMode?: boolean;
  readonly planMd?: string | null;
  readonly bridge?: number;
}) {
  return {
    context: makeEngineContext({
      sessionId: "s-1",
      missionRunId: overrides.missionRunId ?? null,
      missionBaseline: BASELINE,
      planMode: overrides.planMode ?? false,
      planMd: overrides.planMd ?? null,
      planAccepted: true,
    }),
    turnBand: "normal" as const,
    currentTokenCount: 500,
    contextLimit: 1_000,
    postCompactBridgeRemaining: overrides.bridge ?? 0,
    basePromptOptions: BASE_OPTIONS,
  };
}

beforeEach(() => {
  events.length = 0;
  vi.clearAllMocks();
  installDefaultFakes();
});

describe("buildTurnPromptStack: pinned output", () => {
  it("mission run + bridge active + pending off-notice: full options pinned, keys in order", async () => {
    const result = await buildTurnPromptStack(stackArgs({ missionRunId: "run-1", bridge: 2 }));

    const expected: PromptStackOptions = {
      cutoffContinuationNote: "base-note",
      contextPressureBanner: "pressure:normal:0.5:none",
      ownTokenBanner: "own-banner",
      missionCapitalBanner: "capital:absent",
      bridgeCapabilityPrompt: "bridge:unavailable",
      resumePacket: "resume:s-1:7",
      memorySection: "memory:3",
      planOffNotice: PLAN_OFF_NOTICE,
      toolCatalogPrompt: "catalog:memory=true:band=normal",
    };
    expect(result.promptOptions).toStrictEqual(expected);
    expect(Object.keys(result.promptOptions)).toEqual(Object.keys(expected));
    expect(result.tools).toEqual([{ def: "tool:memory=true" }]);
    expect(result.nextPostCompactBridgeRemaining).toBe(1);
    expect(result.preparationBypassesBarrier).toBe(false);

    expect(mockBuildMissionCapitalBanner).toHaveBeenCalledWith(BASELINE);
    expect(mockGetSession).toHaveBeenCalledWith("s-1");
    expect(mockBuildResumePacket).toHaveBeenCalledWith("s-1", 7);
    expect(mockGetTurnContext).toHaveBeenCalledWith({ sessionId: "s-1" });
    expect(mockGetActivePlan).toHaveBeenCalledWith("s-1");
    expect(mockConsumeOffNotice).toHaveBeenCalledTimes(1);
    expect(mockConsumeOffNotice).toHaveBeenCalledWith("s-1");
  });

  it("chat turn in plan mode with a plan: no capital read, no plan read, active plan block pinned", async () => {
    const result = await buildTurnPromptStack(stackArgs({ planMode: true, planMd: "1. do it" }));

    const expected: PromptStackOptions = {
      cutoffContinuationNote: "base-note",
      contextPressureBanner: "pressure:normal:0.5:none",
      ownTokenBanner: "own-banner",
      missionCapitalBanner: "",
      bridgeCapabilityPrompt: "bridge:unavailable",
      memorySection: "memory:3",
      activePlanBlock: buildActivePlanBlock("1. do it", true),
      toolCatalogPrompt: "catalog:memory=true:band=normal",
    };
    expect(result.promptOptions).toStrictEqual(expected);
    expect(Object.keys(result.promptOptions)).toEqual(Object.keys(expected));
    expect(result.nextPostCompactBridgeRemaining).toBe(0);
    expect(mockBuildMissionCapitalBanner).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetActivePlan).not.toHaveBeenCalled();
    expect(mockConsumeOffNotice).not.toHaveBeenCalled();
  });

  it("failed resume and plan reads degrade exactly as before: counter still decrements, no notice consumed", async () => {
    mockGetSession.mockImplementation(() => laterReject("session", "db down"));
    mockGetActivePlan.mockImplementation(() => laterReject("plan", "db down"));
    mockGetTurnContext.mockImplementation(() => later("memory", { knowledge: null, sessionStats: null }));

    const result = await buildTurnPromptStack(stackArgs({ missionRunId: "run-1", bridge: 1 }));

    const expected: PromptStackOptions = {
      cutoffContinuationNote: "base-note",
      contextPressureBanner: "pressure:normal:0.5:none",
      ownTokenBanner: "own-banner",
      missionCapitalBanner: "capital:absent",
      bridgeCapabilityPrompt: "bridge:unavailable",
      memorySection: "memory:failed",
      toolCatalogPrompt: "catalog:memory=false:band=normal",
    };
    expect(result.promptOptions).toStrictEqual(expected);
    expect(Object.keys(result.promptOptions)).toEqual(Object.keys(expected));
    expect(result.nextPostCompactBridgeRemaining).toBe(0);
    expect(mockBuildResumePacket).not.toHaveBeenCalled();
    expect(mockConsumeOffNotice).not.toHaveBeenCalled();
  });

  it("an empty resume packet and no pending notice leave both layers unset", async () => {
    mockBuildResumePacket.mockImplementation(() => later("resume", ""));
    mockGetActivePlan.mockImplementation(() => later("plan", { offNoticePending: false }));

    const result = await buildTurnPromptStack(stackArgs({ bridge: 3 }));

    expect(result.promptOptions).not.toHaveProperty("resumePacket");
    expect(result.promptOptions).not.toHaveProperty("planOffNotice");
    expect(result.nextPostCompactBridgeRemaining).toBe(2);
    expect(mockConsumeOffNotice).not.toHaveBeenCalled();
  });

  it("a missing plan row consumes nothing", async () => {
    mockGetActivePlan.mockImplementation(() => later("plan", null));
    const result = await buildTurnPromptStack(stackArgs({}));
    expect(result.promptOptions).not.toHaveProperty("planOffNotice");
    expect(mockConsumeOffNotice).not.toHaveBeenCalled();
  });
});

describe("buildTurnPromptStack: the one-shot off-notice", () => {
  it("is consumed exactly once, and only after its own plan read resolved", async () => {
    await buildTurnPromptStack(stackArgs({ missionRunId: "run-1", bridge: 1 }));
    expect(mockConsumeOffNotice).toHaveBeenCalledTimes(1);
    expect(events.indexOf("end:plan")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("start:consume")).toBeGreaterThan(events.indexOf("end:plan"));
  });

  it("is NOT consumed when the stack build fails, so the note is not lost", async () => {
    mockGetTurnContext.mockImplementation(() => laterReject("memory", "memory facade exploded"));
    await expect(buildTurnPromptStack(stackArgs({ missionRunId: "run-1", bridge: 1 }))).rejects.toThrow(
      "memory facade exploded",
    );
    // Let any read still in flight settle before checking.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockConsumeOffNotice).not.toHaveBeenCalled();
  });

  it("the resume packet is built from the FRESH session read, never before it", async () => {
    await buildTurnPromptStack(stackArgs({ bridge: 1 }));
    expect(events.indexOf("start:resume")).toBeGreaterThan(events.indexOf("end:session"));
  });
});
