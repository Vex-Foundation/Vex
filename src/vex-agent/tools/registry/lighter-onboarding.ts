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
          `Optional target collateral for a named trade in human ${settlementAsset} decimals, for example "1" or "11". Requires marketId or marketSymbol. Never pass a direct deposit or funding amount here; use ToolSearch once to select lighter.deposit.prepare and pass the user's amount unchanged.`,
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
      `Check the selected Vex wallet's complete live Lighter onboarding readiness on ${environmentName} (${environmentShortName}) in ONE read-only call. This tool is fixed to ${environmentShortName}. It already checks wallet ${settlementAsset} on ${settlementNetwork}, native ETH for gas, Lighter collateral/account ownership, gateway allowance, the live deposit minimum, and locally managed trading-credential readiness. Prefer this directly for ${environmentShortName} setup, readiness, named-trade funding checks, and 'can I deposit?' questions; do NOT run protocol discovery or a separate wallet-balance read first. Direct deposits are the exception: when the user says deposit or fund an explicit amount, skip this onboarding read and WalletBalances, use ToolSearch once to select lighter.deposit.prepare, and pass the requested amount unchanged. After this shortcut returns, answer directly from its deterministic result without another diagnostic or research pass unless the call failed. It moves no funds, signs nothing, creates no approval, and never registers a key. Omit walletAddress to use the selected Vex EVM wallet. amountIn is target collateral for a named trade only and requires marketSymbol or marketId.`,
    returns:
      `RETURNS source and provenance, the fixed ${environmentShortName} environment, walletAddress, walletSettlementUnits and walletSettlementAllowanceUnits (${settlementAsset} base-unit strings), walletNativeBalanceWei (ETH gas balance only), walletCanAcquireSettlement, accountExists, nullable accountIndex, accountCollateralUnits, tradingKeyRegistered, requiredCollateralUnits and minimumDepositUnits. fundingAssessment carries the funding decision, exact base-unit amounts, human-readable ${settlementAsset} displays, shortfalls and nullable deposit amounts. plan carries ready, blocked, required legs with reasons, and nullable depositUnits/acquireUnits. managedTradingAccessActive and nullable managedTradingReadiness report local trading-access checks and their reason, never credential material. tradeMinimumAssessment is null without a named trade; otherwise it compares the requested trade with the live market minimum and combined balances. fundingRoute and tradingAccessRoute name the next step with nullable toolId/params; depositAmountProvided and userGuidance explain how to proceed. These are readiness observations and suggested next steps, not an approval, registered key, deposit or placed order. Invalid inputs or unavailable reads return a failure explanation, not a readiness result.`,
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
