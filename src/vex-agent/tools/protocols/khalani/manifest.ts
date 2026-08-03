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
 * ends with the shared convention sentence, which names `token_find` as the
 * decimals source — rule 90: a raw amount that travels without the decimals
 * needed to read it is a thousandfold error waiting to happen.
 */
const AMOUNT_RAW_DESCRIPTION =
  "Amount to bridge, in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). "
  + CANONICAL_RAW_AMOUNT_SENTENCE;

export const KHALANI_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "khalani.chains.list",
    namespace: "khalani",
    lifecycle: "active",
    description: "List all Khalani-supported chains with metadata (live registry, EVM + Solana).",
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
    namespace: "khalani",
    lifecycle: "active",
    description: "List top Khalani tokens, optionally filtered by chain IDs.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainIds", type: "string", description: "Comma-separated chain IDs or aliases (e.g. '1,solana')." },
    ],
    exampleParams: { chainIds: "1,solana" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.top"],
  },
  {
    toolId: "khalani.tokens.search",
    namespace: "khalani",
    lifecycle: "active",
    description: "Cross-chain token search: resolve a symbol, name, or address to exact token metadata across Khalani's chains. This is the engine behind `token_find`, the canonical token resolver — prefer that shortcut (one call, its schema already in front of you); reach for this toolId only when you are already in an execute_tool flow. Use either before any EVM mutation to get exact contract addresses.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "query", type: "string", required: true, description: "Search phrase or token address." },
      { key: "chainIds", type: "string", description: "Comma-separated chain IDs or aliases." },
    ],
    exampleParams: { query: "USDC", chainIds: "1,8453" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.search"],
  },
  {
    toolId: "khalani.tokens.autocomplete",
    namespace: "khalani",
    lifecycle: "active",
    description: "Semantic token autocomplete — understands '100 usdc on ethereum'.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "keyword", type: "string", required: true, description: "Autocomplete keyword." },
      { key: "chainIds", type: "string", description: "Comma-separated chain IDs or aliases." },
      { key: "limit", type: "number", description: "Max results." },
    ],
    exampleParams: { keyword: "eth", limit: 5 },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.autocomplete"],
  },
  {
    toolId: "khalani.tokens.balances",
    namespace: "khalani",
    lifecycle: "active",
    description: "Read your token balances on Khalani-supported chains for one wallet family (EVM or Solana). Defaults to your personal wallet — pass `walletAddress` to override with a different one. Returns balances with USD prices, scanned per chain for complete multi-chain results. Does NOT cover local chains like Robinhood Chain (4663) — read those with the internal `wallet_balances` tool.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "walletAddress", type: "string", description: "Optional. The ACCOUNT address whose balances to read; omit to use your personal wallet. Under a session-scoped wallet it must equal the selected wallet, or the call fails with WALLET_SCOPE_MISMATCH." },
      { key: "wallet", type: "string", description: "Wallet family: eip155 or solana (default: eip155)." },
      { key: "chainIds", type: "string", description: "Comma-separated chain IDs or aliases. Omit to scan all chains in the family." },
    ],
    exampleParams: { wallet: "eip155", chainIds: "1,8453" },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.tokens.balances"],
  },
  {
    toolId: "khalani.quote.get",
    namespace: "khalani",
    lifecycle: "active",
    description: "Get cross-chain bridge quote with routes, pricing, ETA, and each route's DEADLINE (expiresAtUnixSeconds plus expiresInSeconds remaining). khalani.bridge hard-fails with deadline_expired past that deadline, so check the remaining window before acting and re-quote if it has run out. Resolve fromToken/toToken addresses via khalani.tokens.search first.",
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
      fromToken: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      toChain: "solana",
      toToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: "1000000",
    },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.quote.get"],
  },
  {
    toolId: "khalani.orders.list",
    namespace: "khalani",
    lifecycle: "active",
    description: "List Khalani bridge orders for an address with pagination and filters.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "walletAddress", type: "string", description: "Optional. The ACCOUNT address whose orders to list; omit to use your personal wallet. Under a session-scoped wallet it must equal the selected wallet." },
      { key: "wallet", type: "string", description: "Wallet family: eip155 or solana." },
      { key: "limit", type: "number", description: "Max results." },
      { key: "cursor", type: "number", description: "Pagination cursor for next page." },
      { key: "fromChain", type: "string", description: "Source chain filter (ID or alias)." },
      { key: "toChain", type: "string", description: "Destination chain filter (ID or alias)." },
      { key: "orderIds", type: "string", description: "Comma-separated order IDs to filter." },
      { key: "txHashSearch", type: "string", description: "Search by transaction hash." },
    ],
    exampleParams: { wallet: "solana", limit: 20 },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.orders.list"],
  },
  {
    toolId: "khalani.orders.get",
    namespace: "khalani",
    lifecycle: "active",
    description: "Get a single Khalani bridge order by ID with full lifecycle details.",
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
    namespace: "khalani",
    lifecycle: "active",
    description: "Execute a cross-chain bridge: quote → build deposit → sign → broadcast → submit. Requires wallet access. Resolve fromToken/toToken addresses via khalani.tokens.search first. This BROADCASTS the origin-chain deposit and returns while the destination fill is still IN PROGRESS — a returned bridge is NOT yet confirmed. Vex tracks it and finalizes the record when the fill is verified; do not resubmit or call this again for the same transfer. Check progress with bridge_status (or khalani.orders.get) using the returned order id.",
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
      fromToken: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      toChain: "base",
      toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amountRaw: "100000000",
    },
    discovery: KHALANI_MAIN_DISCOVERY["khalani.bridge"],
  },
];
