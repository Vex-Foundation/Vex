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
      expect(def?.description).toContain("Direct deposits are the exception");
      expect(def?.description).toContain("skip this onboarding read and WalletBalances");
      expect(def?.parameters.properties?.amountIn?.description).toContain(
        "Requires marketId or marketSymbol",
      );
      expect(visible).toContain(shortcut.name);
    }
  });

  it.each(SHORTCUTS)(
    "$name rejects ambiguous amounts before entering the protocol runtime",
    async ({ handler }) => {
      const result = await handler({ amountIn: "5" }, makeTestContext());

      expect(result.success).toBe(false);
      expect(result.output).toContain("amountIn only for a named trade");
      expect(result.output).toContain("pass the user's requested amount unchanged");
      expect(result.output).toContain("Do not call WalletBalances first");
      expect(mocks.executeProtocolTool).not.toHaveBeenCalled();
    },
  );

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
        args: { amountIn: "1", marketSymbol: "SUI" },
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
        params: { environment: "core", amountIn: "1", marketSymbol: "SUI" },
      }),
      expect.any(Object),
    );
  });

  it("teaches fixed-environment shortcuts and approval-gated protocol routing", () => {
    const toolModel = buildToolModelPrompt();
    expect(toolModel).toContain("`lighter_rhc_onboarding_status`");
    expect(toolModel).toContain("fixed to Robinhood Chain");
    expect(toolModel).toContain("`lighter_core_onboarding_status`");
    expect(toolModel).toContain("fixed to Core");
    expect(toolModel).toContain("Skip the onboarding shortcuts and `WalletBalances`");
    expect(toolModel).toContain("pass the user's amount unchanged");

    const lighter = buildProtocolsPrompt()
      .split("### lighter\n")[1]
      ?.split("\n### ")[0] ?? "";
    expect(lighter).toContain("managed onboarding readiness");
    expect(lighter).toContain("The environment stays explicit once selected");
    expect(lighter).toContain("normal users never paste trading keys");
    expect(lighter).toContain("execute only through the matching user-approved card");
    expect(lighter).toContain("Ethereum USDC for Core");
    expect(lighter).toContain("Robinhood Chain USDG for RHC");

    for (const shortcut of SHORTCUTS) {
      const description = getToolDef(shortcut.name)?.description ?? "";
      expect(description).toContain("do NOT run protocol discovery or a separate wallet-balance read first");
      expect(description).toContain("answer directly from its deterministic result");
    }
  });
});
