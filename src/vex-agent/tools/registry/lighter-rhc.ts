import type { ToolDef } from "../types.js";

/**
 * Hot-path alias for the most common Lighter readiness read on Robinhood Chain.
 *
 * The target environment is intentionally absent from the schema and fixed in
 * the handler. This keeps a routine RHC readiness request to one deterministic
 * live call and makes it impossible for this RHC-named tool to drift to Core.
 */
export const LIGHTER_RHC_TOOLS: readonly ToolDef[] = [
  {
    name: "lighter_rhc_onboarding_status",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Check the selected Vex wallet's complete live Lighter onboarding readiness on Robinhood Chain (RHC) in ONE read-only call. This is fixed to RHC and runs the same deterministic engine as lighter.account.onboarding.status. It already checks wallet USDG, native ETH for gas, Lighter collateral/account ownership, gateway allowance, the live deposit minimum, and locally managed trading-credential readiness. Prefer this directly for RHC setup, readiness, funding checks, and 'can I deposit?' questions; do NOT run protocol discovery or a separate wallet-balance read first. After it returns, answer directly from its deterministic result without another diagnostic or research pass unless the call failed. It moves no funds, signs nothing, creates no approval, and never registers a key. Omit walletAddress to use the selected Vex EVM wallet. amountIn is human USDG; include marketSymbol or marketId only when checking a named trade's live minimum.",
    parameters: {
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
            "Optional intended collateral in human USDG decimals, for example \"1\" or \"11\". Omit only for amount-free setup discovery.",
        },
        marketId: {
          type: "number",
          description:
            "Optional Lighter RHC market id. Provide at most one of marketId or marketSymbol, and include amountIn when checking a market minimum.",
        },
        marketSymbol: {
          type: "string",
          description:
            "Optional Lighter RHC market symbol, for example SUI. Provide at most one of marketSymbol or marketId, and include amountIn when checking a market minimum.",
        },
      },
      additionalProperties: false,
    },
  },
];
