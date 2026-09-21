import type { JsonSchema, ToolDef } from "../types.js";

interface LighterOnboardingShortcutDefinition {
  readonly name: "lighter_rhc_onboarding_status" | "lighter_core_onboarding_status";
  readonly environmentName: string;
  readonly environmentShortName: "RHC" | "Core";
  readonly settlementAsset: "USDG" | "USDC";
  readonly settlementNetwork: string;
  /**
   * When to fire, worded so the pair leaves NO ambiguous case between them.
   * "I want to start trading on Lighter" names no environment, and a trigger
   * that only recognised its own name left the model to deliberate over which
   * tool it meant - the one thing this hot path exists to avoid. The unnamed
   * case belongs to RHC, which is what `LIGHTER_DEFAULT_ENVIRONMENT` already
   * resolves it to everywhere else, and the Core twin says so rather than
   * staying silent and inviting the same guess.
   */
  readonly triggerClause: string;
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
          `Optional target collateral for a named trade in human ${settlementAsset} decimals, for example "1". Requires marketId or marketSymbol, and is never a direct deposit or funding amount.`,
      },
      marketId: {
        type: "number",
        description:
          `Optional Lighter ${environmentShortName} market id. Pass at most one of marketId or marketSymbol, with amountIn.`,
      },
      marketSymbol: {
        type: "string",
        description:
          `Optional Lighter ${environmentShortName} market symbol, for example SUI. Pass at most one of marketSymbol or marketId, with amountIn.`,
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
    triggerClause,
  } = definition;
  return {
    name,
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    // Every byte here is paid on EVERY provider request of EVERY session,
    // including the ones that never mention Lighter, because both shortcuts sit
    // in the always-loaded set (see `always-loaded-schema-bytes.test.ts`). The
    // wording is therefore kept to the decisions the model cannot take without
    // it: when to call this instead of something else, the one exception, what
    // happens on handoff, and the shape of what comes back. Anything the
    // parameter schema already says is not repeated here.
    description:
      `Check the selected Vex wallet's live Lighter onboarding readiness on ${environmentName} in ONE read-only call, fixed to ${environmentShortName}: wallet ${settlementAsset} on ${settlementNetwork}, native ETH for gas, collateral and account ownership, gateway allowance, deposit minimum, and local trading-credential readiness. ${triggerClause} Prefer it for ${environmentShortName} setup, readiness, funding checks and 'can I deposit?' questions; do NOT run protocol discovery or a wallet-balance read first. Direct deposits are the exception: when the user names an amount to deposit or fund, skip this read and WalletBalances, use ToolSearch once to select lighter.deposit.prepare, and pass that amount unchanged. If the setup handoff opens, the runtime ends the turn and the modal owns it; do not continue setup in chat. Otherwise answer from its result unless the call failed. Returns balances, account collateral, trading-key and managed-access readiness, a funding assessment with amounts and shortfalls, a plan of required legs, the next-step route with its toolId, and any named-trade minimum. Read-only: moves no funds, signs nothing, creates no approval or key.`,
    returns:
      `RETURNS source and provenance, the fixed ${environmentShortName} environment, walletAddress, walletSettlementUnits and walletSettlementAllowanceUnits (${settlementAsset} base-unit strings), walletNativeBalanceWei (ETH gas balance only), walletCanAcquireSettlement, accountExists, nullable accountIndex, accountCollateralUnits, tradingKeyRegistered, requiredCollateralUnits and minimumDepositUnits. fundingAssessment carries the funding decision, exact base-unit amounts, human-readable ${settlementAsset} displays, shortfalls and nullable deposit amounts. plan carries ready, blocked, required legs with reasons, and nullable depositUnits/acquireUnits. managedTradingAccessActive and nullable managedTradingReadiness report local trading-access checks and their reason, never credential material. tradeMinimumAssessment is null without a named trade; otherwise it compares the requested trade with the live market minimum and combined balances. fundingRoute and tradingAccessRoute name the next step with nullable toolId/params; depositAmountProvided and userGuidance explain how to proceed. tradingLimits carries this wallet's live per-market leverage and the agent's capital share, which the user sets in Settings -> Lighter -> Trading setup and no Vex tool can change. These are readiness observations and suggested next steps, not an approval, registered key, deposit or placed order. Invalid inputs or unavailable reads return a failure explanation, not a readiness result.`,
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
    triggerClause:
      "When the user wants to start, set up or begin trading on Lighter and names RHC or NO environment at all, call this immediately as the first and only tool in the batch; never narrate, reason or ask which environment first - unnamed means RHC.",
  }),
  defineOnboardingShortcut({
    name: "lighter_core_onboarding_status",
    environmentName: "Lighter Core",
    environmentShortName: "Core",
    settlementAsset: "USDC",
    settlementNetwork: "Ethereum mainnet",
    triggerClause:
      "When the user NAMES Core and wants to start or set up trading, call this immediately as the first and only tool in the batch; never narrate or reason first. An unnamed environment is the RHC twin's, not this one.",
  }),
];
