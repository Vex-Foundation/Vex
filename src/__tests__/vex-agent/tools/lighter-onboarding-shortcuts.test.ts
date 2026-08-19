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
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import {
  handleLighterCoreOnboardingStatus,
  handleLighterRhcOnboardingStatus,
} from "@vex-agent/tools/internal/lighter-onboarding.js";
import {
  defaultVisibilityContext,
  getOpenAITools,
  getToolDef,
} from "@vex-agent/tools/registry.js";
import { makeTestContext } from "./_test-context.js";

const SHORTCUTS = [
  {
    name: "lighter_rhc_onboarding_status",
    environment: "rhc",
    forbiddenEnvironment: "core",
    settlementAsset: "USDG",
    handler: handleLighterRhcOnboardingStatus,
  },
  {
    name: "lighter_core_onboarding_status",
    environment: "core",
    forbiddenEnvironment: "rhc",
    settlementAsset: "USDC",
    handler: handleLighterCoreOnboardingStatus,
  },
] as const;

describe("Lighter environment-fixed onboarding shortcuts", () => {
  beforeEach(() => {
    mocks.executeProtocolTool.mockReset();
    resetProtocolsPromptCache();
  });

  it("shows both read-only shortcuts in a fresh restricted session", () => {
    const visible = getOpenAITools(defaultVisibilityContext())
      .map((tool) => tool.function.name);

    for (const shortcut of SHORTCUTS) {
      const def = getToolDef(shortcut.name);
      expect(def).toMatchObject({
        kind: "internal",
        mutating: false,
        pressureSafety: "read_only",
        actionKind: "read",
      });
      expect(def?.parameters.additionalProperties).toBe(false);
      expect(def?.parameters.properties).not.toHaveProperty("environment");
      expect(def?.description).toContain(shortcut.settlementAsset);
      expect(visible).toContain(shortcut.name);
    }
  });

  it.each(SHORTCUTS)(
    "$name fixes the target to $environment and allowlists model input",
    async ({ environment, forbiddenEnvironment, handler }) => {
      const expected = {
        success: true,
        output: JSON.stringify({ environment, live: true }),
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

      const result = await handler({
        environment: forbiddenEnvironment,
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
            environment,
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
    },
  );

  it("dispatches the Core shortcut through the production lazy-loader route", async () => {
    mocks.executeProtocolTool.mockResolvedValue({
      success: true,
      output: JSON.stringify({ environment: "core", live: true }),
      actionKind: "read",
    });

    const result = await dispatchTool(
      {
        name: "lighter_core_onboarding_status",
        args: { amountIn: "1" },
        toolCallId: "call_core_readiness",
      },
      makeTestContext(),
    );

    expect(result.success).toBe(true);
    expect(result.actionKind).toBe("read");
    expect(result.durationMs).toEqual(expect.any(Number));
    expect(mocks.executeProtocolTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "lighter.account.onboarding.status",
        params: { environment: "core", amountIn: "1" },
      }),
      expect.any(Object),
    );
  });

  it("teaches one-call routing for Core and RHC", () => {
    const toolModel = buildToolModelPrompt();
    expect(toolModel).toContain("`lighter_rhc_onboarding_status`");
    expect(toolModel).toContain("fixed to Robinhood Chain");
    expect(toolModel).toContain("`lighter_core_onboarding_status`");
    expect(toolModel).toContain("fixed to Core");

    const onboarding = buildProtocolsPrompt()
      .split("## Lighter Onboarding Routing")[1]
      ?.split("\n## ")[0] ?? "";
    expect(onboarding).toContain("RHC fast path");
    expect(onboarding).toContain("call `lighter_rhc_onboarding_status` directly");
    expect(onboarding).toContain("defaults to Robinhood Chain (RHC)");
    expect(onboarding).toContain("use Core only when the user explicitly selects Core");
    expect(onboarding).toContain("Core fast path");
    expect(onboarding).toContain("call `lighter_core_onboarding_status` directly");
    expect(onboarding).toContain("Keep the selected environment stable");
    expect(onboarding).toContain("Never omit it downstream");
    expect(onboarding).not.toContain("Core by default");
    expect(onboarding).toContain("do not run protocol discovery or a separate wallet-balance read");
    expect(onboarding).toContain("answer directly from its deterministic result");
  });
});
