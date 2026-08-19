import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeProtocolTool: vi.fn(),
}));

vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool: mocks.executeProtocolTool,
}));

import {
  buildProtocolsPrompt,
  resetProtocolsPromptCache,
} from "@vex-agent/engine/prompts/protocols.js";
import { buildToolModelPrompt } from "@vex-agent/engine/prompts/tool-model.js";
import { handleLighterRhcOnboardingStatus } from "@vex-agent/tools/internal/lighter-rhc.js";
import {
  defaultVisibilityContext,
  getOpenAITools,
  getToolDef,
} from "@vex-agent/tools/registry.js";
import { makeTestContext } from "./_test-context.js";

describe("Lighter RHC onboarding direct shortcut", () => {
  beforeEach(() => {
    mocks.executeProtocolTool.mockReset();
    resetProtocolsPromptCache();
  });

  it("is visible in a fresh restricted session as a read-only RHC tool", () => {
    const def = getToolDef("lighter_rhc_onboarding_status");
    expect(def).toMatchObject({
      kind: "internal",
      mutating: false,
      pressureSafety: "read_only",
      actionKind: "read",
    });
    expect(def?.parameters.additionalProperties).toBe(false);
    expect(def?.parameters.properties).not.toHaveProperty("environment");

    const visible = getOpenAITools(defaultVisibilityContext())
      .map((tool) => tool.function.name);
    expect(visible).toContain("lighter_rhc_onboarding_status");
  });

  it("runs the existing onboarding engine with RHC fixed and model input allowlisted", async () => {
    const expected = {
      success: true,
      output: JSON.stringify({ environment: "rhc", live: true }),
      actionKind: "read" as const,
    };
    mocks.executeProtocolTool.mockResolvedValue(expected);
    const abortController = new AbortController();
    const context = makeTestContext({
      missionId: "mission-1",
      missionRunId: "run-1",
      approvalId: "approval-1",
      preparationBypassesBarrier: true,
      abortSignal: abortController.signal,
    });

    const result = await handleLighterRhcOnboardingStatus({
      environment: "core",
      amountIn: "1",
      marketSymbol: "SUI",
      unexpected: "drop-me",
    }, context);

    expect(result).toBe(expected);
    expect(mocks.executeProtocolTool).toHaveBeenCalledOnce();
    expect(mocks.executeProtocolTool).toHaveBeenCalledWith(
      {
        toolId: "lighter.account.onboarding.status",
        params: {
          environment: "rhc",
          amountIn: "1",
          marketSymbol: "SUI",
        },
      },
      expect.objectContaining({
        sessionId: context.sessionId,
        sessionPermission: "restricted",
        approved: false,
        contextUsageBand: "normal",
        preparationBypassesBarrier: true,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        missionId: "mission-1",
        missionRunId: "run-1",
        approvalId: "approval-1",
        abortSignal: abortController.signal,
      }),
    );
  });

  it("teaches one-call RHC routing without changing Core onboarding", () => {
    const toolModel = buildToolModelPrompt();
    expect(toolModel).toContain("`lighter_rhc_onboarding_status`");
    expect(toolModel).toContain("fixed to Robinhood Chain");

    const onboarding = buildProtocolsPrompt()
      .split("## Lighter Onboarding Routing")[1]
      ?.split("\n## ")[0] ?? "";
    expect(onboarding).toContain("RHC fast path");
    expect(onboarding).toContain("call `lighter_rhc_onboarding_status` directly");
    expect(onboarding).toContain("Do not run protocol discovery or a separate wallet-balance read before it");
    expect(onboarding).toContain("answer directly from its deterministic result");
    expect(onboarding).toContain("Core onboarding remains on `lighter.account.onboarding.status`");
  });
});
