import type { ProtocolToolManifest } from "../../types.js";
import { UNISWAP_SWAP_DISCOVERY } from "../../embeddings/uniswap/swap.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { UNISWAP_SWAP_VEX_FEE } from "../../../vex-fee-notes.js";
import {
  SWAP_VENUE_GUIDANCE,
  UNISWAP_BEST_FOR,
  UNISWAP_REGIONAL_GUIDANCE,
} from "@vex-agent/tools/registry/swap-venue-guidance.js";
import { UNISWAP_CHAINS } from "../discovery-text.js";

// C24 (Codex final-review round 1, finding 8): the five-field contract is
// FINAL - no `dryRun`. A preview is `uniswap.swap.quote`; the execute always
// broadcasts. The handler hard-rejects a caller that still passes `dryRun`
// (the runtime's `RESERVED_RUNTIME_PARAM_KEYS` always accepts that key
// regardless of manifest declaration, so omitting it here is not sufficient
// on its own - mirrors kyberswap.swap.execute).
const SWAP_EXECUTION_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: `The chain to swap on. ${CANONICAL_CHAIN_SENTENCE} Robinhood Chain is \`robinhood\` / \`4663\`.` },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS or native ETH/native." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units. This is the TOTAL debited: the swap executes on this amount minus Vex's 25 bps fee." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It sets the minimum output written into the swap calldata, and is the ONLY price protection on the trade. Must match the uniswap__swap_quote value (or be omitted on both) - a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails, in one of two ways. USUALLY it fails for FREE: the router's "Too little received" / "INSUFFICIENT_OUTPUT_AMOUNT" comes back from the pre-sign gas estimate, so nothing is signed and NO gas is spent - this call returns status "not_attempted" with retryable true, and the activity row records failure code slippage. LESS OFTEN the pool moves after that estimate passes: the router REVERTS once mined, the row records mined_revert, and the gas IS spent. Either is the signal to retry with more tolerance, not to give up on the pair: re-quote with a higher slippageBps and pass the same value here. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping. Raise it in steps, starting tight since the usual failure costs nothing - no tolerance is known to fit a given pair in advance, and every increase widens the worst-case price you accept.` },
];

export const UNISWAP_SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "uniswap.swap.quote",
    publicName: "uniswap__swap_quote",
    namespace: "uniswap",
    lifecycle: "active",
    description:
      "Price an exact-input EVM swap straight against Uniswap V2, V3 and verified V4 pools without signing "
      + "anything, and seed the prequote `uniswap__swap_execute` is matched against. The route is read "
      + "from the on-chain quoter with no aggregator in the path, and the best of the available pool "
      + `versions wins. Chains with a verified Vex deployment: ${UNISWAP_CHAINS.join(", ")}. `
      + `${UNISWAP_BEST_FOR} `
      + `${UNISWAP_REGIONAL_GUIDANCE} `
      + "Use this before every Uniswap execute, and whenever the user asks what a trade would return, "
      + "what the rate or the price impact is, or which pools the route would cross. "
      + `${SWAP_VENUE_GUIDANCE} `
      + "Both token params take a CONTRACT ADDRESS or the native keyword - Uniswap has no symbol "
      + "search, so resolve a symbol with TokenFind first - and `amountIn` is human decimals. Pass the "
      + "SAME `slippageBps` on the execute, or omit it on both: the prequote match requires identical "
      + "params. Vex charges 25 bps (0.25%) on the input token; Uniswap's routers carry no fee field, "
      + "so it is Vex's OWN transfer leg signed after the swap confirms. The route here is priced for "
      + "`amountIn` MINUS that fee (`swapAmount`, `swapAmountRaw`, and the `vexFee` block), while "
      + "`amountIn` is the requested debit ceiling. The rate and the receiver are fixed - `fee`, "
      + "`feeBps`, `feeReceiver` and `feeAmount` are rejected BY NAME rather than ignored. "
      + "RETURNS `chain`, `chainId`, `tokenIn` and `tokenOut` each with address, symbol, decimals and a "
      + "native marker, `route` (`version` V2, V3 or V4, the pool `path`, V3 fee tiers or null, and bound V4 PoolKey, pool ID and hook when applicable), "
      + "`amountIn`/`amountInRaw` (the total debited), `swapAmount`/`swapAmountRaw` (what the route was "
      + "priced for), `amountOut`/`amountOutRaw`, `minAmountOut`/`minAmountOutRaw` (the floor the "
      + "execute writes into its calldata), `slippageBps`, `priceImpact` as a fraction where 0.0015 is "
      + "0.15% and null when the pool could not be measured, `gasEstimate`, `router`, `spender` (null on "
      + "a native input, which needs no allowance), `safety` (factory allowlist, output liquidity, "
      + "fee-on-transfer signal), `vexFee`, `eligibility`, and the two separate sentences `impactNote` "
      + "and `eligibilityNote`. The `...Raw` fields are base units and the unsuffixed ones are human. "
      + "Gas is an ESTIMATE, and `safety` is evidence rather than a guarantee. It never gates HERE: the "
      + "prequote gate re-validates it and is where a fail verdict refuses the execute. This venue "
      + "reports a router-factory allowlist check, an output-liquidity read and a fee-on-transfer "
      + "signal; it has no honeypot verdict of its own. "
      + "V4 probes standard hookless PoolKeys on-chain and discovers additional pools through DexScreener; hooked pools remain DexScreener-discovered only. Every candidate is cryptographically bound through PositionManager. "
      + "Hooked pools are disclosed explicitly: their quote is not a guarantee because hooks can distinguish the quoter from the router. "
      + "Native input settlement may be a labelled lower bound and reduce the quoted fee. Unproven native output stays NULL on a confirmed swap; proven ERC-20 input can still incur the fee. "
      + "`selectionBasis` states whether gas costs were comparable; V2 has no quoter gas estimate. "
      + "READ `eligibility` BEFORE PROPOSING THE TRADE: only `executable` authorizes an execute, and it "
      + "authorizes exactly ONE - the execute consumes this quote, and a newer quote for the same trade "
      + "replaces it. `impactMeasured` false means the impact was never measured rather than measured "
      + "and fine; `excessive_impact` means the route gives up 15% or more of the input's reference "
      + "value, and `provider_usd_invalid` that the measured impact was not a number anything can "
      + "interpret. A ROUTE IS NOT AN OFFER, and three further outcomes say so, each distinct: "
      + "`insufficient_balance` (the wallet holds less of the input token than the trade needs - "
      + "required, current and missing are stated), `gas_reserve_insufficient` (the wallet cannot cover "
      + "the TOTAL NATIVE debit, which is every transaction this swap would broadcast - the allowance "
      + "legs, the swap, and the separate Vex fee transfer - plus a measured reserve for the next move, "
      + "so an ERC-20 swap needs native too), and `balance_unavailable` (a balance could not be READ, so "
      + "nothing is known and it fails closed - retry rather than resize). `balanceChecked` false means "
      + "no wallet was read and this answer states nothing about funds. Those figures are a QUOTE-TIME "
      + "observation at the pending block, advisory and ageing: the authoritative read happens again "
      + "immediately before each transaction is signed, and it refuses there if the wallet no longer "
      + "covers the remaining legs.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: `The chain to quote on. ${CANONICAL_CHAIN_SENTENCE} Robinhood Chain is \`robinhood\` / \`4663\`.` },
      { key: "tokenIn", type: "string", required: true, description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search - resolve a symbol to its address first." },
      { key: "tokenOut", type: "string", required: true, description: "Output token CONTRACT ADDRESS or native ETH/native." },
      { key: "amountIn", type: "string", required: true, description: "Amount in human-readable units. This is the TOTAL debited: the route is priced for this amount minus Vex's 25 bps fee." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It pins the minimum output the resulting swap will enforce, and is the ONLY price protection that trade has. Pass the SAME value to uniswap__swap_execute, or omit it on both - a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails at execute time, in one of two ways. USUALLY it fails for FREE: the router's "Too little received" / "INSUFFICIENT_OUTPUT_AMOUNT" comes back from the pre-sign gas estimate, so nothing is signed and NO gas is spent, and the activity row records failure code slippage. LESS OFTEN the pool moves after that estimate passes: the router REVERTS once mined, the row records mined_revert, and the gas IS spent. After either, re-quote with a higher slippageBps rather than abandoning the pair - and since the usual failure costs nothing, a tighter tolerance is the cheap thing to try first. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept.` },
    ],
    exampleParams: { chain: "robinhood", tokenIn: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", tokenOut: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", amountIn: "10" },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.quote"],
  },
  {
    toolId: "uniswap.swap.execute",
    publicName: "uniswap__swap_execute",
    namespace: "uniswap",
    lifecycle: "active",
    description:
      "Swap tokens FOR REAL straight against Uniswap V2, V3 and verified V4 pools: signs and broadcasts an "
      + "exact-input trade with the session's wallet. SPENDS REAL FUNDS AND IS IRREVERSIBLE, and it "
      + "requires approval before it runs. The route is read from the on-chain quoter with no "
      + `aggregator in the path. Chains with a verified Vex deployment: ${UNISWAP_CHAINS.join(", ")}. `
      + `${UNISWAP_BEST_FOR} `
      + `${UNISWAP_REGIONAL_GUIDANCE} `
      + "Use this once the user has agreed to a trade you already priced here. "
      + `${SWAP_VENUE_GUIDANCE} `
      + "PRECONDITIONS, each refused BY NAME rather than worked around: a fresh `uniswap__swap_quote` "
      + "with IDENTICAL params including `slippageBps` must already exist, and a KyberSwap quote cannot "
      + "authorize this tool; there is no preview here, so a `dryRun` call is refused and pointed at the "
      + "quote; both token params must be a CONTRACT ADDRESS or the native keyword, because Uniswap has "
      + "no symbol search; a `slippageBps` above 1000 (10%) is rejected rather than clamped. "
      + "The ERC-20 allowance is handled automatically - an exact-amount approve to the allowlisted "
      + "router, with a reset-to-zero first for the tokens that require it, and none at all on a native "
      + "input. V4 uses an exact ERC-20 allowance to Permit2 and an exact, expiring Permit2 allowance to the verified UniversalRouter. "
      + "The approved V4 pool and hook cannot be silently replaced; the same pool is revalidated immediately before signing. "
      + "Native input can be recorded as a lower bound and caps the fee downward; missing required evidence withholds it. Native output may stay unproven on a confirmed swap while proven ERC-20 input still incurs the fee. "
      + "There is NO separate approve tool and none is needed. Vex charges 25 bps (0.25%) on "
      + "the input token; Uniswap's routers carry no fee field, so it is Vex's OWN transfer leg, signed "
      + "only AFTER the swap confirms, and a swap that fails is therefore never charged: the router "
      + "swaps `amountIn` MINUS the fee while `amountIn` is the requested total ceiling, and the "
      + "`vexFee` block in the result reports what was collected. The rate and the receiver are fixed - "
      + "`fee`, `feeBps`, `feeReceiver` and `feeAmount` are rejected BY NAME. "
      + "BALANCE IS RE-READ HERE AND THAT READ IS THE AUTHORITY, not the quote's: before EACH "
      + "transaction is signed, Vex re-reads the input-token and native balances at the pending block "
      + "and requires them to cover that transaction, every transaction still authorized after it (the "
      + "fee transfer included) and a measured follow-up reserve. A wallet that no longer covers them is "
      + "refused with NOTHING signed and nothing broadcast, stating required, held and missing, and "
      + "distinguishing a wallet that is SHORT from a balance that could not be READ. "
      + "Returns the transaction hash and the executed amounts. The outcomes are distinct and none of "
      + "them may be guessed: confirmed, reverted once mined with the gas spent, refused before signing "
      + "with nothing broadcast, and broadcast but not yet confirmed - which is NOT a failure and must "
      + "not be retried. Slippage is the only price protection on the trade: the floor from the matching "
      + "quote is written into the calldata, and a pool that moves past it fails for free at the "
      + "pre-sign gas estimate (failure code slippage, nothing signed) or, less often, reverts once "
      + "mined (`mined_revert`, gas spent). Either is a signal to re-quote at a higher `slippageBps`, "
      + "never to raise it silently.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    returns: "Returns the transaction hash and the executed amounts.",
    vexFee: UNISWAP_SWAP_VEX_FEE,
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", tokenOut: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", amountIn: "100", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.execute"],
  },
];
