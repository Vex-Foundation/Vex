import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { SOLANA_SWAP_DISCOVERY } from "../../embeddings/solana-jupiter/swap.js";
import { CANONICAL_HUMAN_AMOUNT_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

// W5 (design §6/R4): the fee-bearing `/build` knobs, shared verbatim between
// quote and execute so the SAME economics are bound at both ends (a
// divergence between quote and execute params BLOCKS at the execute-time
// prequote gate — see `prequote/identity/hash.ts`'s Jupiter tail). A fresh
// array per call — manifests must never share a mutable `params` reference.
function feeBearingSwapParams(): ProtocolParamDef[] {
  return [
    { key: "tokenIn", type: "string", required: true, description: "Input token symbol or mint — the side you sell." },
    { key: "tokenOut", type: "string", required: true, description: "Output token symbol or mint — the side you buy." },
    { key: "amountIn", type: "string", required: true, description: `Amount to swap. ${CANONICAL_HUMAN_AMOUNT_SENTENCE} Converted to base units exactly, with no floating-point step: a value carrying more precision than the input side holds is REJECTED, never silently rounded.` },
    { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It sets otherAmountThreshold, the minimum output the swap enforces once it executes, and is the ONLY price protection on the trade — the execute does NOT re-check the price against the quote. Pass the identical value to quote and execute (a mismatch blocks the execute). On a thin or volatile pair (new mints, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails. Which failure you get depends on tipLamports. On the DEFAULT tipped lane (tipLamports omitted = 1,000,000) Jupiter forwards the transaction without simulating it, so a slippage failure ALWAYS lands on-chain FAILED: the network fee is spent, nothing is swapped, and the reason appears on the activity row rather than in this call's result — this call returns "broadcast, confirmation pending". Only tipLamports: 0 takes the RPC lane, which simulates first and can refuse for free with status "rejected_before_broadcast". Either way the remedy is the same: re-quote with a higher slippageBps and execute with the identical value. Read a slippage failure as "this pair needs more tolerance", not as "this pair is untradeable". Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping. Raise it in steps — no tolerance is known to fit a given pair in advance, and every increase widens the worst-case price you accept.` },
    { key: "tipLamports", type: "number", description: "SOL tip in lamports for /tx/v1/submit landing (default 1,000,000 = 0.001 SOL; max 10,000,000 = 0.01 SOL)." },
    { key: "computeUnitPricePercentile", type: "string", description: "Priority-fee strategy: medium (25th percentile), high (default, 50th), or veryHigh (75th). This is the LEVER for priority-fee cost — Jupiter picks the actual price per compute unit at the percentile you name, and Vex refuses to sign a build whose resulting priority fee exceeds 10,000,000 lamports (0.01 SOL). If a swap is refused for that reason, lower this and re-quote. Priority prices are congestion-driven and swing by an order of magnitude within minutes, so a fresh quote at the SAME setting often fits too — the refusal is not a property of the pair." },
    { key: "dexes", type: "string", description: "Comma-separated DEX allow-list. Mutually exclusive with excludeDexes." },
    { key: "excludeDexes", type: "string", description: "Comma-separated DEX deny-list. Mutually exclusive with dexes." },
    { key: "maxAccounts", type: "number", description: "Max account count in the route (1-64, default 64) — trims transaction size at the cost of route choice." },
    { key: "wrapAndUnwrapSol", type: "boolean", description: "Auto wrap/unwrap native SOL (default true). It also decides WHICH SOL balance the input side spends, and the two are different balances: tokenIn \"SOL\" always means the wallet's own native lamports, while tokenIn set to the explicit wrapped-SOL mint So11111111111111111111111111111111111111112 with wrapAndUnwrapSol false means an existing wrapped-SOL token account. The explicit mint WITH wrapping enabled is REJECTED by name as ambiguous, and is never silently resolved to either balance." },
    { key: "forJitoBundle", type: "boolean", description: "Exclude DEXes incompatible with Jito bundles (default false)." },
  ];
}

export const SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "solana.swap.quote",
    publicName: "solana__swap_quote",
    namespace: "solana",
    lifecycle: "active",
    description: "Preview a Solana token swap via Jupiter's Router before committing funds - price, route, and a full fee/tip/ATA-rent disclosure. Requires a selected Solana wallet (the quote is wallet-scoped - the fee-bearing route depends on the payer). Call this FIRST, then pass the identical params to solana__swap_execute; execute rejects if any economically-relevant param drifts from this quote. Returns summary, inputToken and outputToken with their decimals, a safety block whenever either token carries a flag, inputAmountRaw, outputAmountRaw, otherAmountThreshold, slippageBps, priceImpactFraction, routePlan and feePreview. inputAmountRaw/outputAmountRaw/otherAmountThreshold are raw atomic units of the resolved input/output token (see the returned token.decimals to convert to a human amount); otherAmountThreshold is the worst-case minimum output the swap enforces on-chain. priceImpactFraction is a decimal FRACTION, not a percent (0.0015 = 0.15%, same convention as kyberswap__swap_quote's priceImpact) and is null when Jupiter reported none - never read a missing impact as zero. routePlan lists the venues the swap actually routes through and each one's share. No execution happens here.\n\nA ROUTE IS NOT AN AUTHORIZATION. Every quote also reports eligibility.executable, read from a live chain read of this wallet, and only an executable quote lets solana__swap_execute run. eligibility.kind is one of: executable; insufficient_balance, when the input side cannot cover inputAmountRaw (only initialized, non-frozen token accounts count as spendable, so a frozen holding is present and unspendable and sourceSpendability reports spendableAmountRaw and frozenAmountRaw separately); gas_reserve_insufficient, when the input side is covered but the wallet's lamports cannot cover the swap's FULL native cost; or balance_unavailable, when a balance or the transaction's cost could not be read, which fails closed and is never reported as a zero balance. An ineligible quote still returns its route, price and fee facts and still records itself, so the next execute for these params is blocked rather than running on an older funded quote.\n\nnativeDebit itemizes that full native cost in lamports: totalLamports is what the wallet must hold and is the sum of walletPaidLamports (every lamport the transaction itself debits, which includes the wrapped principal when native SOL is the input, the tip and every account rent this wallet pays), messageFeeLamports (the node's own price for this exact transaction, network fee AND priority fee together, so never add feePreview.priorityFeeLamportsEstimate to it), and followUpReserveLamports (a freshly measured one-signature transaction fee, so the wallet can still act afterwards). Vex's 25 bps is taken out of inputAmountRaw by the swap itself and is never added on top of it.\n\nThese figures are a QUOTE-TIME observation and are disclosure, not the check: solana__swap_execute re-reads all of them against the exact transaction immediately before signing and refuses there if the wallet no longer covers them.",
    mutating: false,
    actionKind: "read",
    params: feeBearingSwapParams(),
    exampleParams: { tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.0", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_SWAP_DISCOVERY["solana.swap.quote"],
  },
  {
    toolId: "solana.swap.execute",
    publicName: "solana__swap_execute",
    namespace: "solana",
    lifecycle: "active",
    description: "Execute a token swap via Jupiter's Router (/build) - routes through Jupiter's own router selection, self-managed landing via /tx/v1/submit. Must use EXACTLY the params from a prior solana__swap_quote call (including every knob below); a mismatch aborts before signing, never silently re-quotes. This BROADCASTS and returns truthful-pending - it never confirms success in this call. The output's signature/explorerUrl are tracked automatically; do not resubmit or call this again for the same swap while a signature is pending.\n\nAUTHORITATIVE PRE-SIGN READ. Immediately before signing, and after the transaction is final, Vex re-reads the wallet against that exact transaction: the spendable input balance (frozen token accounts do not count), the wallet's lamports, the node's own fee for this exact message, the tip, every account rent this wallet pays, and a freshly measured follow-up reserve. If any of them no longer covers the swap, or if any lamport the transaction takes from this wallet cannot be accounted for, this call REFUSES before a signature exists: nothing is signed and nothing is broadcast, and the attempt is recorded with the shortfall. A quote that was executable minutes ago is not a guarantee here.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: feeBearingSwapParams(),
    exampleParams: { tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.0" },
    requiresEnv: "JUPITER_API_KEY",
    discovery: SOLANA_SWAP_DISCOVERY["solana.swap.execute"],
  },
];
