import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { executeProtocolTool } from "../protocols/runtime.js";

const FORWARDED_PARAMS = [
  "walletAddress",
  "amountIn",
  "marketId",
  "marketSymbol",
] as const;

/**
 * RHC-only direct alias for the existing deterministic onboarding read.
 *
 * Build the target params from an allowlist instead of spreading model input:
 * even a hand-crafted dispatch carrying `environment: "core"` cannot change
 * the environment promised by this tool's name and schema.
 */
export async function handleLighterRhcOnboardingStatus(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const targetParams: Record<string, unknown> = { environment: "rhc" };
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
}
