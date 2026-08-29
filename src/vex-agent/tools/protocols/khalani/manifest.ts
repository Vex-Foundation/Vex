/**
 * Khalani protocol tool manifests — 9 tools (8 read + 1 mutating).
 *
 * Each manifest declares what the tool does, what params it takes,
 * and whether it mutates state. The runtime uses this for discovery
 * and parameter validation before calling handlers.
 */

import type { ProtocolToolManifest } from "../types.js";
import { KHALANI_MAIN_DISCOVERY } from "../embeddings/khalani/manifest.js";
import { CANONICAL_RAW_AMOUNT_SENTENCE } from "../conventions.js";

/**
 * The ONE raw-amount description both Khalani bridge tools declare (W5b). It
 * ends with the shared convention sentence, which names `TokenFind` as the
 * decimals source — rule 90: a raw amount that travels without the decimals
 * needed to read it is a thousandfold error waiting to happen.
 */
const AMOUNT_RAW_DESCRIPTION =
  "Amount to bridge, in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). "
  + CANONICAL_RAW_AMOUNT_SENTENCE;

/**
 * Both list spellings are equivalent (W2d). `["1","8453"]` is what an LLM
 * emitting JSON reaches for first, and every Khalani list param rejected it
 * until `acceptsStringArray` was declared — a silent-looking failure on a param
 * whose comma spelling worked.
 */
const STRING_OR_ARRAY_CLAUSE =
  'Accepts either a comma-separated string ("1,8453") or an array of strings (["1","8453"]) — the two '
  + "are equivalent.";

/**
 * The provider's own documented ceiling, stated where the agent reads it
 * instead of being learnt from an HTTP 400 (live 2026-08-03: `limit=100` →
 * `Validation failed (limit: Too big: expected number to be <=20)`). Vex
 * rejects an out-of-range value before the wire — see `@tools/khalani/bounds.ts`.
 */
const LIMIT_1_TO_20_CLAUSE = "Range 1-20 (provider maximum, default 10); anything else is rejected before the call.";

/**
 * `wallet` was the pre-convention spelling of `walletFamily` on the two Khalani
 * reads that take a family (owner decision D15). Declared as an input alias, so
 * a session that read the old schema is rewritten at the boundary instead of
 * spending a call on an unknown-parameter answer. The schema, discovery and
 * every description advertise `walletFamily` alone.
 */
const WALLET_FAMILY_RETIRED_SPELLING = {
  key: "wallet",
  removeAfter:
    "D5 owner acceptance: a stale call carrying `wallet` is rewritten to `walletFamily`; the alias goes "
    + "when the owner accepts that such a call should instead receive the unknown-parameter answer naming "
    + "`walletFamily`.",
} as const;

export const KHALANI_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "khalani.chains.list",
    publicName: "khalani__chains_list",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "List every chain Khalani can bridge to or from, EVM and Solana alike, read from the live provider registry. "
      + "Use this before quoting or executing a bridge when it is not certain a chain is covered, or when the user "
      + "asks which networks can be bridged. The set is DYNAMIC and Vex states no count for it, so read it here "
      + "rather than assuming one. RETURNS `chains`, the number of rows, and `data`, one concise row per chain: "
      + "`id` (the chain id every other khalani param accepts), `name`, `type` (the chain family, eip155 or solana), "
      + "`nativeSymbol` and `nativeDecimals`, each null when the registry carried no native currency. RPC and "
      + "explorer URLs are deliberately not returned. Robinhood Chain (4663) is NOT in this registry; "
      + "`BridgeQuoteRelay` and `BridgeExecuteRelay` are the only route that reaches it. The list is complete and "
      + "there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "refresh", type: "boolean", description: "Force refresh chain cache." },
    ],
    exampleParams: {},
    discovery: KHALANI_MAIN_DISCOVERY["khalani.chains.list"],
  },
  {
    toolId: "khalani.tokens.top",
    publicName: "khalani__tokens_top_list",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "List the most commonly bridged tokens across the chains Khalani supports, optionally narrowed to given chain "
      + "ids. Use this when the user wants to browse what is worth moving cross-chain, or asks which major assets a "
      + "chain carries, before they have named a specific token. It is a POPULARITY list, not a resolver: when the "
      + "user already named a ticker or address, use TokenFind (or `khalani__tokens_search`) instead, because this "
      + "tool can legitimately not carry a token that exists. RETURNS `count` and `tokens`, one concise row each: "
      + "`symbol`, `name`, `address`, `chainId`, `decimals`, plus `priceUsd`, `balance` and `isRiskToken` when the "
      + "provider carried them. Logos and the provider's open extensions bag are dropped. Answers with the "
      + "provider's own list in one reply; there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainIds", type: "string", acceptsStringArray: true, description: `Comma-separated chain IDs or aliases (e.g. '1,solana'). ${STRING_OR_ARRAY_CLAUSE}` },
    ],
    exampleParams: { chainIds: "1,solana" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.top"],
  },
  {
    toolId: "khalani.tokens.search",
    publicName: "khalani__tokens_search",
    namespace: "khalani",
    lifecycle: "active",
    description: "Cross-chain token search: resolve a symbol, name, or address to exact token metadata across Khalani's chains. This is the engine behind `TokenFind`, the canonical token resolver - prefer that shortcut (one call, its schema already in front of you); reach for this tool only when `TokenFind` is not enough. Use either before any EVM mutation to get exact contract addresses. Its chain universe is KHALANI-REGISTERED CHAINS ONLY and that set is dynamic - list it with `khalani__chains_list` rather than assuming it. App-local chains such as Robinhood Chain (4663) are NOT resolvable here; there use `dexscreener__pairs_search` (symbol to address lookup on the chain slug), `WalletTrackToken` (save a token so Vex tracks it on app-local chains, action:\"list\" for the tracked set), or `WalletBalances` (the tokens the wallet actually holds). RETURNS `count` and `tokens`, one concise row per match: `symbol`, `name`, `address`, `chainId`, `decimals`, plus `priceUsd`, `balance` and `isRiskToken` when the provider carried them. A ticker can match SEVERAL contracts across chains, so pick the row whose `chainId` is the chain you are about to act on rather than the first row. The provider answers with its own match set in one reply; there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "query", type: "string", required: true, description: "Search phrase or token address." },
      { key: "chainIds", type: "string", acceptsStringArray: true, description: `Comma-separated chain IDs or aliases. ${STRING_OR_ARRAY_CLAUSE}` },
    ],
    exampleParams: { query: "USDC", chainIds: "1,8453" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.search"],
  },
  {
    toolId: "khalani.tokens.autocomplete",
    publicName: "khalani__tokens_autocomplete",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "Parse a partial natural-language token phrase such as '100 usdc on ethereum' into structured token, amount "
      + "and chain suggestions. Use this when the user typed an incomplete bridge or swap intent and you need to "
      + "know which slot to ask for next, or to offer completions; when the user has already named a token "
      + "unambiguously, resolve it with TokenFind instead of guessing from suggestions here. RETURNS `data`, one "
      + "row per suggestion carrying `description`, `chain` (`id`, `name`, `type`, `nativeSymbol`, "
      + "`nativeDecimals`), `token` (`symbol`, `name`, `address`, `chainId`, `decimals`, plus `priceUsd`, `balance` "
      + "and `isRiskToken` when carried), `amount` and `usdAmount`; plus `parsed`, what the provider understood "
      + "from the phrase, and `nextSlots`, which field it expects next. These are SUGGESTIONS, not a resolution: "
      + "confirm the address before it reaches a bridge or a swap. `limit` bounds the reply at the provider "
      + "maximum of 20; there is no pagination beyond it.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "keyword", type: "string", required: true, description: "Autocomplete keyword." },
      { key: "chainIds", type: "string", acceptsStringArray: true, description: `Comma-separated chain IDs or aliases. ${STRING_OR_ARRAY_CLAUSE}` },
      { key: "limit", type: "number", description: `Max results. ${LIMIT_1_TO_20_CLAUSE}` },
    ],
    exampleParams: { keyword: "eth", limit: 5 },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.autocomplete"],
  },
  {
    toolId: "khalani.tokens.balances",
    publicName: "khalani__token_balances_get",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "Scan one wallet's token balances across the supported chains of ONE wallet family (eip155 or "
      + "solana), with USD prices. EVM balances come from Khalani; SOLANA balances come DIRECTLY from Solana RPC, "
      + "the same read the portfolio uses, so a funded Solana wallet is never reported as empty. "
      + "Use this when the user asks what they hold across chains, or when you need to "
      + "find a funded source asset before quoting a bridge or a swap. Defaults to the session's own wallet; pass "
      + "`walletAddress` to read a different one, which under a session-scoped wallet must equal the selected "
      + "wallet or the call fails with WALLET_SCOPE_MISMATCH. One call covers ONE family, so an EVM and a Solana "
      + "answer are two calls. It does NOT cover app-local chains such as Robinhood Chain (4663); read those with "
      + "`WalletBalances`. RETURNS `address`, `wallet` (the family scanned), `count`, `totalUsd`, "
      + "`scannedChainIds`, `chainErrors` (the chains whose scan failed, so a missing token is distinguishable "
      + "from an unscanned chain), `accountErrors` (Solana token ACCOUNTS the read could not trust, each "
      + "`{chainId, accountAddress, reason}`, whose holdings are therefore absent from `tokens`; empty on an EVM "
      + "scan), `accountErrorsOmitted` (present only when more than 20 accounts failed, counting those the cap "
      + "left out, so a truncated error list is never mistaken for the whole story), and `tokens`, one concise "
      + "row each: `symbol`, `name`, `address`, `chainId`, "
      + "`decimals`, plus `priceUsd`, `balance` and `isRiskToken` when carried. On Solana rows `symbol` and `name` "
      + "are NULL when no metadata source could label the mint - an unlabelled holding, not a missing balance, and "
      + "the mint address is never substituted for a ticker. Balances are RAW base units; read "
      + "them with the row's own `decimals`. Every matching row is returned; there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "walletAddress", type: "string", description: "Optional. The ACCOUNT address whose balances to read; omit to use your personal wallet. Under a session-scoped wallet it must equal the selected wallet, or the call fails with WALLET_SCOPE_MISMATCH." },
      { key: "walletFamily", type: "string", aliases: [WALLET_FAMILY_RETIRED_SPELLING], description: "Wallet FAMILY, never a chain: eip155 or solana (default: eip155)." },
      { key: "chainIds", type: "string", acceptsStringArray: true, description: `Comma-separated chain IDs or aliases. Omit to scan all chains in the family. ${STRING_OR_ARRAY_CLAUSE}` },
    ],
    exampleParams: { walletFamily: "eip155", chainIds: "1,8453" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.balances"],
  },
  {
    toolId: "khalani.quote.get",
    publicName: "khalani__bridge_quote_get",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "Price a cross-chain transfer on Khalani without signing anything: the routes available for this pair, what "
      + "would arrive, how long it would take, and each route's DEADLINE. Use this before every bridge, and "
      + "whenever the user asks what they would receive, how long a transfer takes, or which route is best. "
      + "Khalani is the PRIMARY bridge; `BridgeQuoteRelay` is the alternative when Khalani has no route, and it is "
      + "the ONLY route that reaches Robinhood Chain (4663), which Khalani does not carry. Resolve `fromToken` and "
      + "`toToken` to addresses with TokenFind first, and pass `amountRaw` in the source token's RAW atomic units. "
      + "Vex takes 25 bps (0.25%) of the input token, quoted INSIDE the amounts below so the output shown is what "
      + "actually arrives. `refundTo`, `referrer` and `referrerFeeBps` are NOT parameters here and are rejected by "
      + "name: the refund destination is derived from the source wallet and Vex never takes a fee from a "
      + "caller-supplied address. RETURNS `quoteId`, `routeCount`, `routes` and `vexFee`, plus an `expiryNote`. "
      + "Each route carries `routeId`, `type`, `amountIn` and `amountOut` (RAW atomic units), `etaSeconds`, "
      + "`expiresAtUnixSeconds` with `expiresInSeconds` remaining, `validBeforeUnixSeconds`, "
      + "`quoteExpiresAtUnixSeconds`, `estimatedGas` and `tags`. `vexFee` states `charged`, `bps`, the fee amount "
      + "raw and decimal, its USD estimate, the receiver, and `bridgedAmountRaw` versus `totalDebitedRaw`; when no "
      + "fee applies it says so with a `reason`. Treat `expiresInSeconds` as the window you have to act in, not a "
      + "guarantee the same route survives it: `khalani__bridge_execute` re-quotes and hard-fails with "
      + "deadline_expired once the deadline passes, so re-quote instead of retrying. A no-route answer is a "
      + "FAILURE that names the Relay alternative, not an empty list. All routes come back in one reply; there is "
      + "no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "fromChain", type: "string", required: true, description: "Source chain ID or alias." },
      { key: "fromToken", type: "string", required: true, description: "Source token address." },
      { key: "toChain", type: "string", required: true, description: "Destination chain ID or alias." },
      { key: "toToken", type: "string", required: true, description: "Destination token address." },
      { key: "amountRaw", type: "string", required: true, description: AMOUNT_RAW_DESCRIPTION },
      { key: "tradeType", type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
      { key: "fromAddress", type: "string", description: "Source wallet address override." },
      { key: "recipient", type: "string", description: "Destination recipient override." },
      // `refundTo` is deliberately NOT exposed: it decides where funds land
      // when a bridge fails, and a model-chosen fund destination is the same
      // vector as a model-chosen fee. Vex derives it from the selected source
      // wallet; both handlers reject it by name. See the refund-destination
      // policy in `@tools/khalani/request.js`.
      // `referrer` / `referrerFeeBps` are deliberately NOT exposed: they set a
      // referral fee (bps of the bridged amount) payable to an arbitrary
      // address, and Vex never derives a fee from tool params. Both handlers
      // reject them by name. See the policy in `@tools/khalani/request.js`.
      { key: "filler", type: "string", description: "Restrict quotes to a specific filler." },
    ],
    exampleParams: {
      fromChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toChain: "solana",
      toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: "1000000",
    },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.quote.get"],
  },
  {
    toolId: "khalani.orders.list",
    publicName: "khalani__orders_list",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "List a wallet's Khalani bridge orders, newest page first, filterable by source chain, destination chain, "
      + "order ids or transaction hash. Use this when the user asks about their bridge history, wants to see which "
      + "transfers are still in flight, or is looking for a bridge they only remember by transaction hash; for the "
      + "full lifecycle of ONE order, including Vex's own record of it, call `khalani__order_get` with the id. "
      + "Defaults to the session's own wallet, and under a session-scoped wallet `walletAddress` must equal the "
      + "selected wallet. RETURNS `count`, `orders` (the provider's own order rows, carried through unprojected) "
      + "and, when another page exists, `cursor`. `cursor` IS THE ONLY CONTINUATION SIGNAL: it is the provider's "
      + "own opaque value, and the way to read the next page is to send it back verbatim as the `cursor` "
      + "parameter. Never compute one. A reply with NO `cursor` field is the end of the list - there is no "
      + "`hasMore`, no `nextCursor` and no total. `limit` is capped at the provider maximum of 20, with anything "
      + "outside 1-20 rejected before the call.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "walletAddress", type: "string", description: "Optional. The ACCOUNT address whose orders to list; omit to use your personal wallet. Under a session-scoped wallet it must equal the selected wallet." },
      { key: "walletFamily", type: "string", aliases: [WALLET_FAMILY_RETIRED_SPELLING], description: "Wallet FAMILY, never a chain: eip155 or solana." },
      { key: "limit", type: "number", description: `Max results. ${LIMIT_1_TO_20_CLAUSE}` },
      { key: "cursor", type: "number", description: "The provider's own continuation value, echoed back as `cursor` on the previous reply. Pass back exactly what that reply returned; never compute one. Omit for the first page, and when a reply carries no `cursor` there is no next page." },
      { key: "fromChain", type: "string", description: "Source chain filter (ID or alias)." },
      { key: "toChain", type: "string", description: "Destination chain filter (ID or alias)." },
      { key: "orderIds", type: "string", acceptsStringArray: true, description: `Comma-separated order IDs to filter. ${STRING_OR_ARRAY_CLAUSE}` },
      { key: "txHashSearch", type: "string", description: "Search by transaction hash. At most 66 characters (0x + 64 hex, the provider maximum); a longer value is rejected before the call." },
    ],
    exampleParams: { walletFamily: "solana", limit: 20 },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.orders.list"],
  },
  {
    toolId: "khalani.orders.get",
    publicName: "khalani__order_get",
    namespace: "khalani",
    lifecycle: "active",
    description: "Get a single Khalani bridge order by ID with full lifecycle details, MERGED with Vex's own record of it: `order` is the provider's view, `vex` carries the execution id, Vex's logical status, every Vex leg (deposit, fee, expected fill) and the Vex fee collection outcome, and `vexNote` says why there is no Vex record when there is none. The two views can legitimately disagree, because Khalani may report a fill before Vex has verified it on-chain, so read `vex.note` before concluding anything about the funds. RETURNS `order` (the provider's own order record), `vex` (`_executionId`, `vexStatus`, `lastRecordedProviderStatus`, `legs` each with `role`, `status`, `chainSlug`, `txHash` and `failureReason`, `vexFeeCollection`, and `note`), `vexNote` when there is no Vex record to correlate, and `_executionId` mirrored at the top level. `vex` is null when Vex has no record of this order, which is normal for a bridge Vex did not itself execute. One order per call; there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "orderId", type: "string", required: true, description: "Khalani order ID." },
    ],
    exampleParams: { orderId: "order_abc123" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.orders.get"],
  },
  {
    toolId: "khalani.bridge",
    publicName: "khalani__bridge_execute",
    namespace: "khalani",
    lifecycle: "active",
    description:
      "Move tokens between chains FOR REAL: signs and broadcasts the origin-chain deposit with the session's "
      + "wallet and submits it to Khalani. SPENDS REAL FUNDS AND IS IRREVERSIBLE. Use this once the user has agreed "
      + "to a transfer you already quoted; Khalani is the PRIMARY bridge, and `BridgeExecuteRelay` is the "
      + "alternative when Khalani has no route and the ONLY route that reaches Robinhood Chain (4663). "
      + "CALL IT WITH `dryRun: true` FIRST: that branch quotes and signs nothing, and it is the only branch that "
      + "returns success. APPROVAL: in a RESTRICTED session the real call does not execute, it returns pending "
      + "approval for a human to see first; in a FULL-permission session it executes directly. PRECONDITIONS, each "
      + "refused BY NAME: a fresh matching quote must already exist; a route whose deadline has passed fails with "
      + "deadline_expired and must be re-quoted, never retried; a bridge already in flight on the same route "
      + "refuses rather than starting a second; and `refundTo`, `referrer` and `referrerFeeBps` are NOT parameters "
      + "and are rejected, because the refund destination is derived from the source wallet and Vex never takes a "
      + "fee from a caller-supplied address. UNITS: `amountRaw` is RAW atomic units of `fromToken`; resolve the "
      + "decimals with TokenFind. Vex takes 25 bps (0.25%) of the input token as a SEPARATE transfer that runs "
      + "after the deposit, so a bridge that never happens is never charged. The `dryRun` preview RETURNS "
      + "`dryRun`, `quoteId`, `route`, `fromChain`, `toChain`, `vexFee` and `nativeCost`. A real run RETURNS "
      + "`summary`, `status`, `message`, `fromChain`, `toChain`, `route`, `etaSeconds`, `amountIn` and `amountOut` "
      + "(each with `token`, `tokenAddress`, `amountHuman`, `amountRaw`, `usdEstimate`), `usdNote`, `vexFee` with "
      + "its `collection` outcome, `nativeCost`, `legs`, `orderId`, `depositTxHash` and `_executionId`. "
      + "A REAL RUN NEVER REPORTS SUCCESS, and that is not a failure: the deposit broadcasts while the destination "
      + "fill is still in progress, so read `status`. `pending` and `filled_unverified` both mean the deposit went "
      + "through and delivery is not yet independently verified; `failed` and `refunded` mean Khalani says the "
      + "destination amount did NOT arrive and money coming back is not a successful bridge; `reverted`, "
      + "`not_attempted` and `broadcast_unconfirmed` describe the deposit leg itself. In EVERY one of those states "
      + "the attempt is already recorded and reconciled automatically, so DO NOT re-bridge or call this again for "
      + "the same transfer. Follow it with `BridgeStatus` or `khalani__order_get` on the returned `orderId`.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "fromChain", type: "string", required: true, description: "Source chain ID or alias." },
      { key: "fromToken", type: "string", required: true, description: "Source token address." },
      { key: "toChain", type: "string", required: true, description: "Destination chain ID or alias." },
      { key: "toToken", type: "string", required: true, description: "Destination token address." },
      { key: "amountRaw", type: "string", required: true, description: AMOUNT_RAW_DESCRIPTION },
      { key: "tradeType", type: "string", description: "EXACT_INPUT or EXACT_OUTPUT." },
      { key: "fromAddress", type: "string", description: "Source wallet address override." },
      { key: "recipient", type: "string", description: "Destination recipient override." },
      // `refundTo` is deliberately NOT exposed: it decides where funds land
      // when a bridge fails, and a model-chosen fund destination is the same
      // vector as a model-chosen fee. Vex derives it from the selected source
      // wallet; both handlers reject it by name. See the refund-destination
      // policy in `@tools/khalani/request.js`.
      // `referrer` / `referrerFeeBps` deliberately NOT exposed — see the note on
      // `khalani.quote.get` above. `executeKhalaniBridge` rejects them by name.
      { key: "filler", type: "string", description: "Restrict quotes to a specific filler." },
      { key: "routeId", type: "string", description: "Specific route ID (default: best route)." },
      { key: "depositMethod", type: "string", description: "CONTRACT_CALL, PERMIT2, or TRANSFER." },
      { key: "dryRun", type: "boolean", description: "If true, build deposit plan without executing." },
    ],
    exampleParams: {
      fromChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toChain: "base",
      toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amountRaw: "100000000",
    },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.bridge"],
  },
];
