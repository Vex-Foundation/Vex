import type { LighterLiveTradingReleaseGateStatus } from "@vex-agent/tools/protocols/lighter/execution-boundary.js";

export const LIGHTER_LIVE_TRADING_RELEASE_GATE_ENV_KEY =
  "VEX_LIGHTER_LIVE_TRADING_RELEASE_GATE";

export const LIGHTER_LIVE_TRADING_RELEASE_GATE_ENABLE_VALUE =
  "approval-gated-create-v1";

export function readLighterLiveTradingReleaseGateStatus(
  env: Record<string, string | undefined> = process.env,
): LighterLiveTradingReleaseGateStatus {
  const raw = env[LIGHTER_LIVE_TRADING_RELEASE_GATE_ENV_KEY]?.trim() ?? "";
  if (raw.length === 0) {
    return {
      enabled: false,
      source: "privileged_runtime",
      reason: "The privileged Lighter live-trading release gate is not enabled.",
    };
  }
  if (raw === LIGHTER_LIVE_TRADING_RELEASE_GATE_ENABLE_VALUE) {
    return {
      enabled: true,
      source: "privileged_runtime",
      reason: "The privileged Lighter approval-gated create release gate is enabled.",
    };
  }
  return {
    enabled: false,
    source: "privileged_runtime",
    reason: "The privileged Lighter live-trading release gate value is not recognized.",
  };
}
