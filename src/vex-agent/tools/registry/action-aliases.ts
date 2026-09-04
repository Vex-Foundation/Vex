/**
 * Action-named internal tool aliases (Stage 8a read-only + Stage 8b mutating;
 * Agent Scan plan §4.2/§11.2 rewired the swap pair).
 *
 * These present the model with an obvious, action-named menu that routes to
 * existing protocol tools. They are ADDITIVE - the underlying protocol tools
 * stay reachable through ToolSearch.
 *
 *   SwapQuote          → family router: EVM → KyberSwap ONLY, Solana → solana.swap.quote
 *   SwapExecute         → family router: EVM → KyberSwap ONLY, Solana → solana.swap.execute
 *                          (renamed from `swap` in place - Agent Scan plan §11.2)
 *   SwapQuoteUniswap   → uniswap.swap.quote     (alternative swap venue)
 *   SwapExecuteUniswap → uniswap.swap.execute   (alternative swap venue)
 *   TokenCheck          → kyberswap.tokens.check   (EVM honeypot / fee-on-transfer; { chain, tokenAddress })
 *   BridgeStatus        → khalani.orders.get (with id) / khalani.orders.list (without)
 *   BridgeQuote         → khalani.quote.get        (read-only bridge preview)
 *   BridgeExecute        → MUTATING router (Stage 8c): → khalani.bridge (cross-chain)
 *
 * Param convention (SPEC §1.3): the bridge legs take `amountRaw` - RAW base
 * units - and the swap legs take `amountIn` - HUMAN decimals. The bare `amount`
 * key is retired on both lanes; it meant either unit, 10^6 apart, on the same
 * menu.
 *
 * EVM branch is KyberSwap-only - the previous silent Kyber→Uniswap runtime
 * quote fallback is REMOVED. `SwapQuoteUniswap`/`SwapExecuteUniswap` are the
 * ONLY path to Uniswap, and since owner decision D4 they are ALWAYS VISIBLE
 * alongside the routers rather than unlocked by a session reveal. Preference is
 * stated to the model in the prompt stack (KyberSwap is the primary swap route),
 * never enforced by hiding: the approval gate is what protects the money, and a
 * venue the model cannot see is a venue it cannot fall back to when the primary
 * one refuses the pair. Public schema for all four swap tools:
 * `{ chain, tokenIn, tokenOut, amountIn, slippageBps? }` - `side` and
 * `recipient` are REMOVED (no lot-direction/PnL tracking survives Agent Scan;
 * wallet-delta receipt decoding is the truth invariant, so a redirected
 * output is out of scope this phase).
 *
 * The read-only quote aliases are non-mutating, so dispatching them through
 * `executeProtocolTool` fires no approval gate. `SwapExecute` /
 * `SwapExecuteUniswap` / `BridgeExecute` ARE mutating: each is dispatched through a
 * DEDICATED dispatcher branch (`mutating-aliases.ts`) that resolves the target
 * and calls `executeProtocolTool` directly - letting that function SOLELY own
 * the ordering (prequote gate → approval gate → capture). A mutating alias
 * MUST NOT travel through the dispatcher's internal mutating-approval gate
 * (that would enqueue approval BEFORE the prequote gate). `BridgeExecute` REQUIRES a
 * fresh `BridgeQuote` first - the bridge prequote (kind 'bridge', verdict
 * always 'unknown') seeds the gate; the two swap executes REQUIRE their own
 * matching quote on the SAME venue (provider-bound prequote identity - a
 * KyberSwap quote can never authorize a Uniswap execute and vice versa).
 *
 * `SwapQuote` / `SwapQuoteUniswap` route to quote toolIds that already
 * record a Stage-6c prequote via the hook in `executeProtocolTool` - calling a
 * quote before an execute naturally seeds the Stage-7 execute gate. No
 * prequote wiring lives here.
 *
 * NOTE: none of the swap aliases are `requiresEnv`-gated. They are routers
 * spanning both families; the Solana target's `JUPITER_API_KEY` requirement is
 * enforced downstream by `executeProtocolTool` (manifest.requiresEnv) only
 * when a Solana route is actually taken - gating the whole alias on a
 * Solana-only env var would wrongly hide the EVM path.
 */

import type { ToolDef } from "../types.js";
import { CANONICAL_MCP_APPROVAL_SENTENCE } from "../protocols/conventions.js";
import {
  BRIDGE_QUOTE_NO_VEX_FEE,
  BRIDGE_VEX_FEE,
  READ_ONLY_NO_VEX_FEE,
  SWAP_ROUTER_QUOTE_NO_VEX_FEE,
  SWAP_ROUTER_VEX_FEE,
  UNISWAP_SWAP_QUOTE_NO_VEX_FEE,
  UNISWAP_SWAP_VEX_FEE,
} from "../vex-fee-notes.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";
import { BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION } from "@vex-agent/tools/protocols/bridge-token-identity-contract.js";

const TOKEN_FIND_EVM_IDENTITY_RULE =
  "For an EVM token, call TokenFind with exactly one target chain and continue only when mutationReady is true. Ambiguous, provider-capped, or metadata-unreadable results are not executable identities. If the swap pair is already known, prefer its exact base or quote token address and use TokenFind to validate that address on the target chain. TokenFind reads symbol and decimals from the contract, never provider list metadata.";

const TOKEN_FIND_RAW_AMOUNT_RULE =
  "Read decimals from a contract-verified TokenFind candidate on the exact source chain. A provider-list decimal is not signing authority, and a raw amount without contract decimals is unsafe.";

/**
 * The BRIDGE lane's identity rule, stating the same obligations as
 * `TOKEN_FIND_EVM_IDENTITY_RULE` in bridge vocabulary (two tokens on two
 * chains, no "swap pair" to prefer an address from).
 *
 * It exists because the four bridge descriptions are ALWAYS-LOADED and bounded
 * at `ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS` (2048 characters, the point a
 * client cuts one): interpolating the swap rule plus the raw-amount rule into
 * each of them puts every one of the four over the bound, and a description
 * over the bound is the truncation the bound exists to prevent. Nothing is
 * lost: the raw-amount rule keeps its FULL text on every `amountRaw` param,
 * which no client cuts, and the swap rule keeps its full text on the swap
 * params.
 */
const BRIDGE_TOKEN_FIND_IDENTITY_RULE =
  "Resolve fromToken and toToken separately with TokenFind, each with exactly one target chain, continuing only when mutationReady is true; ambiguous, provider-capped or metadata-unreadable results are not executable identities. `amountRaw` decimals come from that contract-verified candidate: a provider-list decimal is not signing authority.";

/**
 * What the swap approval card DOES and does not carry, shared by both execute
 * aliases because it is one contract with one owner (the card builder), not two
 * similar sentences.
 */
const SWAP_CARD_BOUNDARY =
  "Restricted approval shows chain, token addresses, human `amountIn`, and the quote/floor with its quote-time contract-read output symbol; it omits decimals and atomic input. Its QUOTE-TIME spendability line carries the source-token requirement and the total native debit including every fee leg and the reserve; it is disclosure, not the check, and it is not a live balance. Execution re-reads both token contracts before signing; the card is not proof. Full permission shows no card.";

/** Shared JSON-schema properties for the Kyber/Jupiter-routed pair (SwapQuote/SwapExecute - unified §11.2 contract). */
const SWAP_SCHEMA_PROPERTIES = {
  chain: {
    type: "string" as const,
    description: "Chain to swap on. EVM slugs/aliases route to KyberSwap (ethereum, base, arbitrum, robinhood, …); the literal \"solana\" routes to Jupiter. Accepts a chain slug/alias or the numeric chain id TokenFind returns (e.g. base or 8453).",
  },
  tokenIn: {
    type: "string" as const,
    description: `Input token. EVM: the token CONTRACT ADDRESS or native ETH/native. ${TOKEN_FIND_EVM_IDENTITY_RULE} Solana: symbol or mint.`,
  },
  tokenOut: {
    type: "string" as const,
    description: `Output token. EVM: the token CONTRACT ADDRESS or native ETH/native. ${TOKEN_FIND_EVM_IDENTITY_RULE} Solana: symbol or mint.`,
  },
  amountIn: {
    type: "string" as const,
    description: "Amount of tokenIn to swap, in HUMAN decimal units (e.g. \"1.5\"). Not wei/lamports.",
  },
  slippageBps: {
    type: "number" as const,
    description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It is the ONLY price protection on the trade. Pass the SAME value to the quote and the execute, or omit it on both - a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails. When it fails, the message says so and names this parameter: re-quote with a higher slippageBps and pass the same value to the execute. Do not read a slippage failure as "this pair is untradeable" and do not switch venue for it - another venue at ${VEX_DEFAULT_SLIPPAGE_BPS} bps fails the same way. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept, so raise it in steps.`,
  },
};
const SWAP_SCHEMA_REQUIRED = ["chain", "tokenIn", "tokenOut", "amountIn"];

/**
 * JSON-schema properties for the HIDDEN Uniswap-only pair (FIX-SPINE round 1,
 * finding 14/C4 - the shared `SWAP_SCHEMA_PROPERTIES` text above wrongly told
 * this EVM-only, Uniswap-only pair that chains route to KyberSwap and that
 * Solana is an option; neither is true here). Same param NAMES/shape (unified
 * §11.2 contract) - only the descriptive text differs.
 */
const UNISWAP_SWAP_SCHEMA_PROPERTIES = {
  chain: {
    type: "string" as const,
    description: "EVM chain to swap on (ethereum, base, arbitrum, robinhood, …) - Uniswap ONLY, no venue routing. Solana is NOT supported by this tool.",
  },
  tokenIn: {
    type: "string" as const,
    description: `Input token: the token CONTRACT ADDRESS or native ETH/native. ${TOKEN_FIND_EVM_IDENTITY_RULE}`,
  },
  tokenOut: {
    type: "string" as const,
    description: `Output token: the token CONTRACT ADDRESS or native ETH/native. ${TOKEN_FIND_EVM_IDENTITY_RULE}`,
  },
  amountIn: {
    type: "string" as const,
    description: "Amount of tokenIn to swap, in HUMAN decimal units (e.g. \"1.5\"). Not wei.",
  },
  slippageBps: {
    type: "number" as const,
    description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It is the ONLY price protection on the trade. Pass the SAME value to the quote and the execute, or omit it on both - a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails. When it fails, the message says so and names this parameter: re-quote with a higher slippageBps and pass the same value to the execute. Do not read a slippage failure as "this pair is untradeable" and do not switch venue for it - another venue at ${VEX_DEFAULT_SLIPPAGE_BPS} bps fails the same way. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept, so raise it in steps.`,
  },
};

export const ACTION_ALIAS_TOOLS: readonly ToolDef[] = [
  {
    name: "SwapQuote",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a token swap WITHOUT executing - route, output, price impact, token safety. EVM routes to KyberSwap ONLY; \"solana\" → Jupiter, which requires JUPITER_API_KEY and answers `configuration_unavailable` if missing. EVM tokens must be a CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native; Solana a symbol or mint. `amountIn` is the HUMAN decimal of tokenIn. Call this BEFORE SwapExecute: a fresh quote (same venue) authorizes SwapExecute ONLY; every other authorizes its own. A ROUTE BEING AVAILABLE DOES NOT MEAN THE WALLET CAN PAY FOR IT: each quote reads the selected wallet into an `eligibility` block, and only `eligibility.executable` true authorizes an execute. The three balance outcomes are DISTINCT facts with distinct remedies. `insufficient_balance` means the wallet holds less of the input token than the trade needs; it names required, current and missing. `gas_reserve_insufficient` means native cannot cover the swap's TOTAL NATIVE DEBIT: every transaction it would broadcast, including the L1 data fee where the chain charges one, plus a measured reserve for one more transaction afterwards. `balance_unavailable` means a balance could not be READ, which is never the same statement as the wallet being short and always fails closed. On Solana only initialized, non-frozen token accounts count as spendable, so a FROZEN holding is present and NOT spendable. An ineligible quote still returns its route and is recorded, so a later execute cannot fall back on an older funded quote. Every balance figure here is a QUOTE-TIME OBSERVATION, advisory and ageing: the authoritative read happens again immediately before each signature, so an execute can still refuse for balance after this call said executable. Fee already inside the route: EVM `extraFee - THE VEX FEE, 25 bps of the input token`; Solana `feePreview`, the same 25 bps Vex fee, taken inside the Jupiter route. KyberSwap is the primary swap venue; if it cannot route the pair, quote SwapQuoteUniswap instead. Full contract: vex_ToolDescribe.",
    returns:
      "RETURNS on EVM a summary, chain, chainId, tokenIn/tokenOut with address, symbol and decimals, routerAddress, a routeSummary (amountIn/amountOut raw, amountInUsd/amountOutUsd, gasUsd, l1FeeUsd, priceImpact as a fraction, extraFee - THE VEX FEE, 25 bps of the input token, already applied inside the quoted route - routeHops, routePaths) and a safety verdict per leg carrying isHoneypot, isFOT and tax. On Solana it returns a summary, inputToken/outputToken metadata, inputAmountRaw, outputAmountRaw, otherAmountThreshold, slippageBps, priceImpactFraction, routePlan and feePreview (the same 25 bps Vex fee, taken inside the Jupiter route) - no USD figures at all on that side, and safety is present only when the provider has a verdict.",
    vexFee: SWAP_ROUTER_QUOTE_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "SwapExecute",
    kind: "internal",
    mutating: true,
    // Mirrors the TARGET swap-execute manifests (kyberswap.swap.execute,
    // solana.swap.execute are both mutating). At context pressure barrier+ the
    // dispatcher hard-denies the alias before the router resolves - conservative
    // and equivalent to denying the mutating target directly.
    pressureSafety: "mutating",
    // SAME actionKind the target swap manifests carry (user_wallet_broadcast) -
    // do NOT invent one. Used as the dispatcher fallback stamp; on dispatch the
    // result already carries the target's actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL swap on-chain: it spends funds, broadcasts a signed transaction. Vex charges 25 bps of the input token in the route. EVM routes to KyberSwap ONLY; \"solana\" → Jupiter, which requires JUPITER_API_KEY and answers `configuration_unavailable` when missing. REQUIRES a fresh SwapQuote FIRST on the SAME venue: a SwapQuoteUniswap or a namespaced quote authorizes its own execute, never this one. "
      + CANONICAL_MCP_APPROVAL_SENTENCE
      + " "
      + SWAP_CARD_BOUNDARY
      + " BALANCE IS RE-READ HERE AND THAT READ IS THE AUTHORITY, not the quote's: before EVERY signature Vex re-reads the wallet - EVM input-token and native balances at the pending block; Solana the spendable input balance (frozen token accounts do not count), lamports, tip, every account rent this wallet pays and the node's fee for that exact message - and must cover it, every transaction still authorized after it, and a measured follow-up reserve. Else it refuses with NOTHING signed and nothing broadcast, distinguishing a wallet that is SHORT from a balance that could not be READ; one executable minutes ago is not a guarantee here. Full contract: vex_ToolDescribe.",
    returns:
      "RETURNS, on a confirmed EVM swap, a summary with chain, chainId, txHash, tokenIn, tokenOut, the DECODED amountIn and amountOut in human units, a status of confirmed or confirmed_unrecorded, and a deliveryCheck when one was made. Every other EVM outcome is a sentence, and they differ: reverted on-chain, confirmed but the amounts could not be decoded yet, refused before signing, and broadcast but NOT yet confirmed - that last one says do not retry and names the ChainRead tx_receipt call you can make yourself. On Solana there is no JSON success arm at all: a broadcast answers \"Swap broadcast (signature ...) - confirmation pending, tracked automatically. Do not retry.\", and terminality is settled by a background sweep, so never read that sentence as a completed swap. Failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
    vexFee: SWAP_ROUTER_VEX_FEE,
    parameters: {
      type: "object",
      properties: SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "SwapQuoteUniswap",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a token swap on Uniswap WITHOUT executing. Returns the expected output amount, price impact, the route Uniswap would take, and the fees. EVM ONLY (chain must NOT be \"solana\") and only on the EVM chains with a verified Vex Uniswap deployment. Tokens must be a CONTRACT ADDRESS or native ETH/native; `amountIn` is the HUMAN decimal of tokenIn. Call this BEFORE SwapExecuteUniswap: this quote authorizes SwapExecuteUniswap and nothing else, and a KyberSwap quote cannot authorize a Uniswap execute. A ROUTE BEING AVAILABLE DOES NOT MEAN THE WALLET CAN PAY FOR IT: it also reads the selected wallet into an `eligibility` block with its own `eligibilityNote`, and only `eligibility.executable` true authorizes an execute. The three balance outcomes are DISTINCT facts with distinct remedies. `insufficient_balance` means the wallet holds less of the input token than the trade needs, and names required, current and missing. `gas_reserve_insufficient` means native cannot cover the TOTAL NATIVE DEBIT: every transaction this swap would broadcast - the allowance legs where they are needed, the swap and the SEPARATE Vex fee transfer - including the L1 data fee where the chain charges one, plus a measured reserve for one more transaction afterwards. `balance_unavailable` means a balance could not be READ, which is never the same statement as the wallet being short and always fails closed: retry rather than resize. `balanceChecked` false means no wallet was read and this answer states nothing about funds. An ineligible quote still returns its route and is recorded, so a later execute cannot fall back on an older funded quote. Every balance figure here is a QUOTE-TIME OBSERVATION at the pending block, advisory and ageing: the authoritative read happens again immediately before each signature, so an execute can still refuse for balance after this call said executable. KyberSwap is the primary swap route - reach for this one when KyberSwap cannot serve the pair or its quote failed for a routing reason.",
    returns:
      "Returns the expected output amount, price impact, the route Uniswap would take, and the fees.",
    vexFee: UNISWAP_SWAP_QUOTE_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: UNISWAP_SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "SwapExecuteUniswap",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL on-chain swap on Uniswap. SPENDS FUNDS: it signs and broadcasts from your wallet. "
      + CANONICAL_MCP_APPROVAL_SENTENCE
      + " Call it only after a fresh matching SwapQuoteUniswap on the SAME venue, the only quote that authorizes this tool - a KyberSwap or namespaced quote cannot. EVM ONLY, on the EVM chains with a verified Vex Uniswap deployment. `amountIn` is the HUMAN decimal of tokenIn. Restricted approval shows chain, token addresses, human `amountIn`, and the quote/floor with its quote-time contract-read output symbol; it omits decimals and atomic input. Its QUOTE-TIME spendability line carries the source-token requirement and the total native debit including every fee leg and the reserve; it is disclosure, not the check, and it is not a live balance. Execution re-reads both token contracts before signing; the card is not proof. Full permission shows no card. BALANCE IS RE-READ HERE AND THAT READ IS THE AUTHORITY, not the quote's: before EACH signature the input-token and native balances are read again at the pending block and must cover that transaction, every transaction still authorized after it (the fee transfer included) and a measured follow-up reserve. Else it refuses with NOTHING signed and nothing broadcast, stating required, held and missing and distinguishing a wallet that is SHORT from a balance that could not be READ; one executable minutes ago is not a guarantee here. Returns the transaction hash and the resulting wallet deltas; failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
    returns:
      "Returns the transaction hash and the resulting wallet deltas; failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
    vexFee: UNISWAP_SWAP_VEX_FEE,
    parameters: {
      type: "object",
      properties: UNISWAP_SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "BridgeExecute",
    kind: "internal",
    mutating: true,
    // Mirrors the TARGET khalani.bridge manifest (mutating). At context pressure
    // barrier+ the dispatcher hard-denies the alias before the router resolves -
    // conservative and equivalent to denying the mutating target directly.
    pressureSafety: "mutating",
    // SAME actionKind the target khalani.bridge manifest carries
    // (user_wallet_broadcast) - do NOT invent one. Used as the dispatcher
    // fallback stamp; on dispatch the result already carries the target's
    // actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL bridge. SPENDS REAL FUNDS AND IS IRREVERSIBLE: it signs and broadcasts a deposit from the user's wallet on the source chain. "
      + CANONICAL_MCP_APPROVAL_SENTENCE
      + " Run BridgeQuote first. That quote authorizes THIS tool whichever venue it chose; BridgeQuoteRelay authorizes only BridgeExecuteRelay. PRECONDITIONS, each refused BY NAME: a fresh BridgeQuote on the SAME provider, identical params, within 15 minutes. "
      + BRIDGE_TOKEN_FIND_IDENTITY_RULE
      + " The approval card shows each exact chain, token contract, contract-read symbol and decimals, and the human and atomic source amounts. The route, the refund address and the destination are derived from the source and the selected destination wallet; a caller-supplied `refundTo`, `referrer`, `referrerFeeBps`, `routeId`, `depositMethod` or `recipient` is rejected by name, and `fromAddress` redirects nothing: the session wallet signs only for itself. Venue: Khalani's live registry picks Khalani when it serves both sides, Relay otherwise (how Robinhood Chain routes). Vex charges 25 bps of the input token as a separate transfer after the deposit lands. IT NEVER REPORTS SUCCESS: a broadcast deposit is not a delivered bridge; every arm says do NOT re-bridge. Full contract: vex_ToolDescribe.",
    returns:
      "RETURNS status, summary, message, fromChain, toChain, legs (role, chain, txHash, status) and vexFee; on the Khalani route also orderId, depositTxHash, route, etaSeconds, amountIn/amountOut and nativeCost, and on the Relay route requestId, providerStatus, amounts and inTxHashes. IT NEVER REPORTS SUCCESS: a deposit that broadcast is not a delivered bridge. `status` is pending, filled_unverified, failed or refunded, delivery is verified by a background tracker, and every arm says the same thing - do NOT re-bridge. Follow the order with BridgeStatus.",
    vexFee: BRIDGE_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address." },
        amountRaw: { type: "string", description: `Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = "1000000"). ${TOKEN_FIND_RAW_AMOUNT_RULE} A raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen.` },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        fromAddress: { type: "string", description: "Source wallet address override." },
        // NOTE: recipient is intentionally NOT exposed. A bridge delivers to the
        // wallet selected for this project on the destination family, and a
        // caller-supplied value is rejected BY NAME by the khalani and relay
        // handlers (rule 90: a destination that can redirect funds never comes
        // from model input). Advertising it here taught the model a call that
        // now always fails.
        // NOTE: refundTo is intentionally NOT exposed - it is DERIVED from the
        // selected source wallet and a caller-supplied value is rejected by
        // name (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `khalani.bridge` / `khalani.quote.get` manifests.
        filler: { type: "string", description: "Restrict quotes to a specific filler." },
        // NOTE: referrer / referrerFeeBps are intentionally NOT exposed. They
        // set a referral fee (up to 99.99%) deducted from the bridged output
        // and paid to an arbitrary address, invisible in Khalani's quote
        // response and in the approval preview. Vex never derives a fee from
        // model params (same doctrine as the KyberSwap integrator fee). The
        // alias router and both Khalani handlers reject them BY NAME.
        // NOTE: routeId / depositMethod are intentionally NOT exposed. They are
        // EXECUTE-ONLY (the bridge quote has no counterpart), so they can never be
        // bound to a quote - the bridge auto-selects the best route. The execute
        // gate fail-closes (block "unbindable_param") if they reach khalani.bridge
        // via the protocol-call path, so dropping them here is the menu half
        // of a defense-in-depth pair (8c security fix).
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw"],
    },
  },
  {
    name: "TokenCheck",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Safety-check an EVM token before trading it: detects honeypots and fee-on-transfer (tax) tokens via KyberSwap. Pass the chain and the exact token contract `tokenAddress`. "
      + TOKEN_FIND_EVM_IDENTITY_RULE
      + " The former key `address` is retired and is rejected by name. Read-only. RETURNS chain, chainId, tokenAddress, isHoneypot, isFOT and tax - a closed, validated shape, never a raw provider payload. A clean verdict here is not proof the token is safe: it answers only the honeypot and transfer-tax question, and says nothing about the contract's other risks.",
    returns:
      "RETURNS chain, chainId, tokenAddress, isHoneypot, isFOT and tax - a closed, validated shape, never a raw provider payload.",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "EVM chain slug or alias (ethereum, base, arbitrum, …). Accepts a chain slug/alias or the numeric chain id TokenFind returns (e.g. base or 8453)." },
        tokenAddress: { type: "string", description: `Token contract address to inspect (0x form on the named chain). A symbol is not accepted. ${TOKEN_FIND_EVM_IDENTITY_RULE} The former key \`address\` is retired and is rejected by name.` },
      },
      required: ["chain", "tokenAddress"],
    },
  },
  {
    name: "BridgeStatus",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Check a cross-chain bridge order through Khalani. It follows KHALANI order ids only - the `orderId` a Khalani-routed BridgeExecute returned. A Relay bridge has NO status tool: its `requestId` is tracked by Vex's own background sweep, and its recorded row is read with AgentScan `view: \"transactions\"`. Use this when a bridge execute returned an orderId and you need to know whether the destination amount actually arrived, or when the user asks what happened to a recent bridge - it is the read that settles an unresolved bridge, and the reason a bridge execute never has to be repeated. Pass `orderId` to fetch one order's full lifecycle; omit it to list your recent bridge orders with optional filters. Mixing `orderId` with the list filters is refused by name. Read-only. RETURNS, in id mode, `order` (id, type, quoteId, routeId, fromChainId/toChainId, fromToken/toToken, srcAmount, destAmount, status, recipient, refundTo, fillerAddress, depositTxHash, createdAt, updatedAt, stepsCompleted, transactions and token metadata) plus `vex`, Vex's own correlation carrying vexStatus, lastRecordedProviderStatus, legs and vexFeeCollection, or null with a note when the order is not correlated. Provider `status` is one of created, deposited, published, filled, refund_pending, refunded or failed - a different vocabulary from the status the execute returned, and `vex.note` says which view is authoritative when they disagree. In list mode it returns count, cursor and orders; `cursor` is the only continuation, so do not expect hasMore or nextCursor.",
    returns: "RETURNS, in id mode, `order` (id, type, quoteId, routeId, fromChainId/toChainId, fromToken/toToken, srcAmount, destAmount, status, recipient, refundTo, fillerAddress, depositTxHash, createdAt, updatedAt, stepsCompleted, transactions and token metadata) plus `vex`, Vex's own correlation carrying vexStatus, lastRecordedProviderStatus, legs and vexFeeCollection, or null with a note when the order is not correlated. Provider `status` is one of created, deposited, published, filled, refund_pending, refunded or failed - a different vocabulary from the status the execute returned, and `vex.note` says which view is authoritative when they disagree. In list mode it returns count, cursor and orders; `cursor` is the only continuation, so do not expect hasMore or nextCursor.",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "Khalani order ID. Provide to fetch a single order; omit to list your orders.",
        },
        walletAddress: { type: "string", description: "List mode: the ACCOUNT address whose orders to list (optional - omit to use your configured wallet)." },
        walletFamily: { type: "string", description: "List mode: wallet FAMILY, never a chain - eip155 or solana." },
        limit: { type: "number", description: "List mode: max results." },
        cursor: { type: "number", description: "List mode: the provider's own opaque continuation value, echoed back as `cursor` on the previous reply. Send back exactly what that reply returned; a reply with no `cursor` is the end of the list." },
        fromChain: { type: "string", description: "List mode: source chain filter (ID or alias)." },
        toChain: { type: "string", description: "List mode: destination chain filter (ID or alias)." },
        orderIds: { type: "string", description: "List mode: comma-separated order IDs to filter." },
        txHashSearch: { type: "string", description: "List mode: search by transaction hash." },
      },
    },
  },
  {
    name: "BridgeQuote",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a cross-chain bridge WITHOUT executing - routes, pricing, fees, and ETA. Use this when the user asks what moving an amount between two chains would cost or how long it would take, and before every BridgeExecute: the execute is authorized only by a fresh matching quote on the SAME provider, within 15 minutes and with identical params. THIS quote authorizes BridgeExecute whichever venue it routed to; it does not authorize BridgeExecuteRelay, which takes a BridgeQuoteRelay of its own. Venue comes from Khalani's live chain registry: Khalani when it serves both sides, Relay otherwise, which is how Robinhood Chain routes. "
      + BRIDGE_TOKEN_FIND_IDENTITY_RULE
      + " `amountRaw` is in RAW base units (wei/lamports), matching the underlying bridge quote. Read-only, and the quoted output is already net of Vex's 25 bps input-token fee. "
      + BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION
      + " RETURNS, on the Khalani route, quoteId, routeCount, routes (each routeId, type, amountIn, amountOut, etaSeconds and its expiry fields), vexFee and expiryNote. On the Relay route it returns a summary, serviceable, fromChain/toChain, fromToken/toToken, amounts (in and out, each with token, amountRaw, human amount and a nullable usd estimate), vexFee, estimatedTimeSeconds, minimumAmountOutRaw, totalImpactPercent, appliedSlippagePercent, steps and requestId. `vexFee` is a union: the fee amount and receiver fields exist only when it is actually charged.",
    returns:
      "RETURNS, on the Khalani route, quoteId, routeCount, routes (each routeId, type, amountIn, amountOut, etaSeconds and its expiry fields), vexFee and expiryNote. On the Relay route it returns a summary, serviceable, fromChain/toChain, fromToken/toToken, amounts (in and out, each with token, amountRaw, human amount and a nullable usd estimate), vexFee, estimatedTimeSeconds, minimumAmountOutRaw, totalImpactPercent, appliedSlippagePercent, steps and requestId. `vexFee` is a union: the fee amount and receiver fields exist only when it is actually charged.",
    vexFee: BRIDGE_QUOTE_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address." },
        amountRaw: { type: "string", description: `Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = "1000000"). ${TOKEN_FIND_RAW_AMOUNT_RULE} A raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen.` },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        fromAddress: { type: "string", description: "Source wallet address override." },
        // NOTE: recipient is intentionally NOT exposed - see the note on the
        // `BridgeExecute` alias. The destination is the selected wallet on the
        // destination family and a caller-supplied value is rejected by name.
        // NOTE: refundTo is intentionally NOT exposed - it is DERIVED from the
        // selected source wallet and a caller-supplied value is rejected by
        // name (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `khalani.bridge` / `khalani.quote.get` manifests.
        // referrer / referrerFeeBps intentionally NOT exposed - see the note on
        // the `BridgeExecute` alias above. A fee-bearing quote is what would later let
        // a matching fee-bearing execute through the prequote gate.
        filler: { type: "string", description: "Restrict quotes to a specific filler." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw"],
    },
  },
  {
    // Relay bridge PREVIEW. ALWAYS VISIBLE since owner decision D4 retired the
    // route-bound reveal; unlike generic `BridgeQuote` (Khalani except the
    // local-chain exception), this ALWAYS targets Relay.
    name: "BridgeQuoteRelay",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a cross-chain bridge via Relay WITHOUT executing. Returns the route, the expected destination amount, fees, and the ETA. "
      + BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION
      + " "
      + BRIDGE_TOKEN_FIND_IDENTITY_RULE
      + " `amountRaw` is in RAW base units (wei/lamports). Call this BEFORE BridgeExecuteRelay: this quote forces Relay and authorizes BridgeExecuteRelay ONLY, and a Khalani quote cannot authorize a Relay execute. The quoted output is already net of Vex's 25 bps input-token fee. Khalani is the primary bridge route - reach for Relay when Khalani does not cover the route (it is the only venue for Robinhood Chain) or its quote failed for a routing reason.",
    returns:
      "Returns the route, the expected destination amount, fees, and the ETA.",
    vexFee: BRIDGE_QUOTE_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address, or native ETH/native." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address, or native ETH/native." },
        amountRaw: { type: "string", description: `Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = "1000000"). ${TOKEN_FIND_RAW_AMOUNT_RULE} A raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen.` },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        // NOTE: recipient is intentionally NOT exposed - see the note on the
        // `BridgeExecute` alias. The destination is the selected wallet on the
        // destination family and a caller-supplied value is rejected by name.
        // NOTE: refundTo is intentionally NOT exposed - the Relay handler
        // DERIVES it from the resolved source wallet and both relay alias
        // routers reject a caller-supplied value by name
        // (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `relay.bridge` / `relay.quote.get` manifests.
        slippageBps: { type: "number", description: "Slippage tolerance in basis points for the destination-side fill (1 bps = 0.01%). Higher tolerance widens the worst-case received amount on the destination chain. When a bridge quote fails or fills keep expiring, re-quote with a higher value rather than retrying the same one. Vex caps it at 1000 (10%) and rejects anything above rather than clamping." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw"],
    },
  },
  {
    // Relay bridge EXECUTE. ALWAYS VISIBLE since owner decision D4, exactly like
    // BridgeQuoteRelay above. Dispatched via the dedicated mutating-alias branch
    // (`MUTATING_PROTOCOL_ALIAS_ROUTERS`), so it needs NO INTERNAL_TOOL_LOADERS
    // entry; the prequote gate and the approval gate own authorization.
    name: "BridgeExecuteRelay",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    // SAME actionKind the target relay.bridge manifest carries - do NOT invent
    // one. Dispatcher fallback stamp; on dispatch the result already carries the
    // target's actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL cross-chain bridge via Relay. SPENDS FUNDS: it signs and broadcasts on the source chain. "
      + CANONICAL_MCP_APPROVAL_SENTENCE
      + " REQUIRES a fresh matching BridgeQuoteRelay FIRST on Relay - that quote is the only one that authorizes this tool, and a BridgeQuote or a Khalani quote cannot. Vex charges 25 bps of the input token, as a separate transfer that runs only after the deposit lands. "
      + BRIDGE_TOKEN_FIND_IDENTITY_RULE
      + " `amountRaw` is in RAW base units (wei/lamports). The approval card shows each exact chain, token contract, contract-read symbol and decimals, and both the human and atomic source amounts before signing. Returns the source transaction hash and Relay's own `requestId`. BridgeStatus does NOT read it - it follows Khalani order ids - so track a Relay bridge through Vex's background sweep and read its recorded row with AgentScan `view: \"transactions\"`; failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones. Khalani is the primary bridge route - reach for Relay when Khalani does not cover the route (it is the only venue for Robinhood Chain) or its quote failed for a routing reason.",
    returns:
      "Returns the source transaction hash and Relay's own `requestId`.",
    vexFee: BRIDGE_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address, or native ETH/native." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address, or native ETH/native." },
        amountRaw: { type: "string", description: `Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = "1000000"). ${TOKEN_FIND_RAW_AMOUNT_RULE} A raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen.` },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        // NOTE: recipient is intentionally NOT exposed - see the note on the
        // `BridgeExecute` alias. The destination is the selected wallet on the
        // destination family and a caller-supplied value is rejected by name.
        // NOTE: refundTo is intentionally NOT exposed - the Relay handler
        // DERIVES it from the resolved source wallet and both relay alias
        // routers reject a caller-supplied value by name
        // (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `relay.bridge` / `relay.quote.get` manifests.
        slippageBps: { type: "number", description: "Slippage tolerance in basis points for the destination-side fill (1 bps = 0.01%). Higher tolerance widens the worst-case received amount on the destination chain. When a bridge quote fails or fills keep expiring, re-quote with a higher value rather than retrying the same one. Vex caps it at 1000 (10%) and rejects anything above rather than clamping." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amountRaw"],
    },
  },
];
