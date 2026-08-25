import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { ToolResult } from "../types.js";
import { fail, type InternalToolContext } from "./types.js";
import { executeProtocolTool } from "../protocols/runtime.js";

type InternalHandler = (
  params: Record<string, unknown>,
  context: InternalToolContext,
) => Promise<ToolResult>;

const FORWARDED_PARAMS = [
  "walletAddress",
  "amountIn",
  "marketId",
  "marketSymbol",
] as const;

/**
 * Build a fixed-environment alias for the existing deterministic onboarding
 * read. Target params come from an allowlist instead of spread model input, so
 * a hand-crafted `environment` value cannot cross the Core/RHC boundary.
 */
function makeLighterOnboardingStatusHandler(
  environment: LighterEnvironment,
): InternalHandler {
  return async (params, context) => {
    const hasAmount = params.amountIn !== undefined;
    const hasNamedTrade = params.marketId !== undefined || params.marketSymbol !== undefined;
    if (hasAmount && !hasNamedTrade) {
      return fail(
        "This onboarding shortcut accepts amountIn only for a named trade. "
        + "For a direct deposit or funding request, use ToolSearch once to select "
        + "lighter.deposit.prepare and pass the user's requested amount unchanged. "
        + "Do not call WalletBalances first; deposit preparation owns its live preflight.",
      );
    }

    const targetParams: Record<string, unknown> = { environment };
    for (const key of FORWARDED_PARAMS) {
      if (params[key] !== undefined) targetParams[key] = params[key];
    }

    return executeProtocolTool(
      {
        toolId: "lighter.account.onboarding.status",
        params: targetParams,
      },
      {
        sessionPermission: context.sessionPermission,
        approved: context.approved,
        sessionId: context.sessionId,
        contextUsageBand: context.contextUsageBand,
        preparationBypassesBarrier: context.preparationBypassesBarrier === true,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        missionId: context.missionId,
        missionRunId: context.missionRunId,
        approvalId: context.approvalId,
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      },
    );
  };
}

export const handleLighterRhcOnboardingStatus =
  makeLighterOnboardingStatusHandler("rhc");

export const handleLighterCoreOnboardingStatus =
  makeLighterOnboardingStatusHandler("core");
