import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { SOLANA_SWAP_DISCOVERY } from "../../embeddings/solana-jupiter/swap.js";

// W5 (design §6/R4): the fee-bearing `/build` knobs, shared verbatim between
// quote and execute so the SAME economics are bound at both ends (a
// divergence between quote and execute params BLOCKS at the execute-time
// prequote gate — see `prequote/identity/hash.ts`'s Jupiter tail). A fresh
// array per call — manifests must never share a mutable `params` reference.
function feeBearingSwapParams(): ProtocolParamDef[] {
  return [
    { key: "inputToken", type: "string", required: true, description: "Input token symbol or mint." },
    { key: "outputToken", type: "string", required: true, description: "Output token symbol or mint." },
    { key: "amount", type: "number", required: true, description: "Amount in human-readable units." },
    { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
    { key: "tipLamports", type: "number", description: "SOL tip in lamports for /tx/v1/submit landing (default 1,000,000 = 0.001 SOL; max 10,000,000 = 0.01 SOL)." },
    { key: "computeUnitPricePercentile", type: "string", description: "Priority-fee strategy: medium, high (default), or veryHigh." },
    { key: "dexes", type: "string", description: "Comma-separated DEX allow-list. Mutually exclusive with excludeDexes." },
    { key: "excludeDexes", type: "string", description: "Comma-separated DEX deny-list. Mutually exclusive with dexes." },
    { key: "maxAccounts", type: "number", description: "Max account count in the route (1-64, default 64) — trims transaction size at the cost of route choice." },
    { key: "wrapAndUnwrapSol", type: "boolean", description: "Auto wrap/unwrap native SOL (default true)." },
    { key: "forJitoBundle", type: "boolean", description: "Exclude DEXes incompatible with Jito bundles (default false)." },
  ];
}

export const SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.swap.quote",
    namespace: "solana",
    lifecycle: "active",
    description: "Preview a Solana token swap via Jupiter's Router before committing funds — price, route, and a full fee/tip/ATA-rent disclosure. Requires a selected Solana wallet (the quote is wallet-scoped — the fee-bearing route depends on the payer). Call this FIRST, then pass the identical params to solana.swap.execute; execute rejects if any economically-relevant param drifts from this quote. Returned inputAmountRaw/outputAmountRaw/otherAmountThreshold are raw atomic units of the resolved input/output token (see the returned token.decimals to convert to a human amount); otherAmountThreshold is the worst-case minimum output the swap enforces on-chain. priceImpactFraction is a decimal FRACTION, not a percent (0.0015 = 0.15%, same convention as kyberswap.swap.quote's priceImpact) and is null when Jupiter reported none — never read a missing impact as zero. routePlan lists the venues the swap actually routes through and each one's share. No execution happens here.",
    mutating: false,
    actionKind: "read",
    params: feeBearingSwapParams(),
    exampleParams: { inputToken: "SOL", outputToken: "USDC", amount: 1.0, slippageBps: 50 },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_SWAP_DISCOVERY["solana.swap.quote"],
  },
  {
    toolId: "solana.swap.execute",
    namespace: "solana",
    lifecycle: "active",
    description: "Execute a token swap via Jupiter's Router (/build) — routes through Metis, self-managed landing via /tx/v1/submit. Must use EXACTLY the params from a prior solana.swap.quote call (including every knob below); a mismatch aborts before signing, never silently re-quotes. This BROADCASTS and returns truthful-pending — it never confirms success in this call. The output's signature/explorerUrl are tracked automatically; do not resubmit or call this again for the same swap while a signature is pending.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: feeBearingSwapParams(),
    exampleParams: { inputToken: "SOL", outputToken: "USDC", amount: 1.0 },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_SWAP_DISCOVERY["solana.swap.execute"],
  },
];
