import type { JsonSchema, ToolDef } from "../types.js";

interface LighterOnboardingShortcutDefinition {
  readonly name: "lighter_rhc_onboarding_status" | "lighter_core_onboarding_status";
  readonly environmentName: string;
  readonly environmentShortName: "RHC" | "Core";
  readonly settlementAsset: "USDG" | "USDC";
  readonly settlementNetwork: string;
}

function onboardingParameters(
  definition: LighterOnboardingShortcutDefinition,
): JsonSchema {
  const { environmentShortName, settlementAsset } = definition;
  return {
    type: "object",
    properties: {
      walletAddress: {
        type: "string",
        description:
          "Optional 0x-prefixed EVM wallet address to check. Omit to use the session's selected Vex wallet. Never a private key.",
      },
      amountIn: {
        type: "string",
        description:
          `Optional intended collateral in human ${settlementAsset} decimals, for example "1" or "11". Omit only for amount-free setup discovery.`,
      },
      marketId: {
        type: "number",
        description:
          `Optional Lighter ${environmentShortName} market id. Provide at most one of marketId or marketSymbol, and include amountIn when checking a market minimum.`,
      },
      marketSymbol: {
        type: "string",
        description:
          `Optional Lighter ${environmentShortName} market symbol, for example SUI. Provide at most one of marketSymbol or marketId, and include amountIn when checking a market minimum.`,
      },
    },
    additionalProperties: false,
  };
}

function defineOnboardingShortcut(
  definition: LighterOnboardingShortcutDefinition,
): ToolDef {
  const {
    name,
    environmentName,
    environmentShortName,
    settlementAsset,
    settlementNetwork,
  } = definition;
  return {
    name,
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      `Check the selected Vex wallet's complete live Lighter onboarding readiness on ${environmentName} (${environmentShortName}) in ONE read-only call. This tool is fixed to ${environmentShortName}. It already checks wallet ${settlementAsset} on ${settlementNetwork}, native ETH for gas, Lighter collateral/account ownership, gateway allowance, the live deposit minimum, and locally managed trading-credential readiness. Prefer this directly for ${environmentShortName} setup, readiness, funding checks, and 'can I deposit?' questions; do NOT run protocol discovery or a separate wallet-balance read first. After it returns, answer directly from its deterministic result without another diagnostic or research pass unless the call failed. It moves no funds, signs nothing, creates no approval, and never registers a key. Omit walletAddress to use the selected Vex EVM wallet. amountIn is human ${settlementAsset}; include marketSymbol or marketId only when checking a named trade's live minimum.`,
    parameters: onboardingParameters(definition),
  };
}

/**
 * Fixed-environment hot paths for the common Lighter readiness read.
 *
 * Environment is intentionally absent from both schemas and bound inside the
 * handlers. A Core-named tool cannot drift to RHC and an RHC-named tool cannot
 * drift to Core, including under a hand-crafted dispatcher call.
 */
export const LIGHTER_ONBOARDING_TOOLS: readonly ToolDef[] = [
  defineOnboardingShortcut({
    name: "lighter_rhc_onboarding_status",
    environmentName: "Robinhood Chain",
    environmentShortName: "RHC",
    settlementAsset: "USDG",
    settlementNetwork: "Robinhood Chain",
  }),
  defineOnboardingShortcut({
    name: "lighter_core_onboarding_status",
    environmentName: "Lighter Core",
    environmentShortName: "Core",
    settlementAsset: "USDC",
    settlementNetwork: "Ethereum mainnet",
  }),
];
