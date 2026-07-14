/**
 * Action-named internal tool aliases (Stage 8a read-only + Stage 8b mutating).
 *
 * These present the model with an obvious, action-named menu that routes to
 * existing protocol tools. They are ADDITIVE — the underlying protocol tools
 * stay reachable via discover_tools / execute_tool.
 *
 *   swap_quote   → family router: EVM → kyberswap.swap.quote, Solana → solana.swap.quote
 *   token_check  → kyberswap.tokens.check   (EVM honeypot / fee-on-transfer)
 *   bridge_status→ khalani.orders.get (with id) / khalani.orders.list (without)
 *   bridge_quote → khalani.quote.get        (read-only bridge preview)
 *   swap         → MUTATING family router (Stage 8b): EVM → kyberswap.swap.buy /
 *                  kyberswap.swap.sell, Solana → solana.swap.execute
 *   bridge       → MUTATING router (Stage 8c): → khalani.bridge (cross-chain)
 *
 * The four 8a aliases are non-mutating, so dispatching them through
 * `executeProtocolTool` fires no approval gate. `swap` (8b) and `bridge` (8c)
 * ARE mutating: each is dispatched through a DEDICATED dispatcher branch
 * (`mutating-aliases.ts`) that resolves the target and calls `executeProtocolTool`
 * directly — letting that function SOLELY own the ordering (prequote gate →
 * approval gate → capture). A mutating alias MUST NOT travel through the
 * dispatcher's internal mutating-approval gate (that would enqueue approval
 * BEFORE the prequote gate). `bridge` REQUIRES a fresh `bridge_quote` first — the
 * bridge prequote (kind 'bridge', verdict always 'unknown') seeds the gate.
 *
 * `swap_quote` routes to the kyber/solana quote toolIds that already record a
 * Stage-6c prequote via the hook in `executeProtocolTool` — calling a quote
 * before a swap naturally seeds the Stage-7 execute gate. No prequote wiring
 * lives here.
 *
 * NOTE: `swap_quote` / `swap` are deliberately NOT `requiresEnv`-gated. They
 * are routers spanning both families; the Solana target's `JUPITER_API_KEY`
 * requirement is enforced downstream by `executeProtocolTool`
 * (manifest.requiresEnv) only when a Solana route is actually taken — gating the
 * whole alias on a Solana-only env var would wrongly hide the EVM path.
 */

import type { ToolDef } from "../types.js";

export const ACTION_ALIAS_TOOLS: readonly ToolDef[] = [
  {
    name: "swap_quote",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a token swap WITHOUT executing — best route, expected output, price impact, and token-safety signals. Auto-routes by chain: KyberSwap on its supported EVM chains (incl. Robinhood Chain), with Uniswap as the all-EVM fallback; chain \"solana\" → Jupiter. EVM tokens must be a CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native — EVM symbol resolution is disabled here to avoid wrong-contract matches; Solana accepts a symbol or mint. `amount` is the HUMAN decimal of tokenIn (e.g. \"1.5\", not wei/lamports). Call this BEFORE any swap: a fresh matching quote (same venue) is what unlocks execution.",
    parameters: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description:
            "Chain to swap on. EVM slugs/aliases route to KyberSwap where supported (ethereum, base, arbitrum, robinhood, …) with Uniswap as fallback; the literal \"solana\" routes to Jupiter.",
        },
        tokenIn: {
          type: "string",
          description: "Input token. EVM: the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Solana: symbol or mint.",
        },
        tokenOut: {
          type: "string",
          description: "Output token. EVM: the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Solana: symbol or mint.",
        },
        amount: {
          type: "string",
          description: "Amount of tokenIn to swap, in HUMAN decimal units (e.g. \"1.5\"). Not wei/lamports.",
        },
        slippageBps: {
          type: "number",
          description: "Optional slippage tolerance in basis points (50 = 0.5%).",
        },
      },
      required: ["chain", "tokenIn", "tokenOut", "amount"],
    },
  },
  {
    name: "swap",
    kind: "internal",
    mutating: true,
    // Mirrors the TARGET swap-execute manifests (kyberswap.swap.sell/buy,
    // solana.swap.execute are all mutating). At context pressure barrier+ the
    // dispatcher hard-denies the alias before the router resolves — conservative
    // and equivalent to denying the mutating target directly.
    pressureSafety: "mutating",
    // SAME actionKind the target swap manifests carry (user_wallet_broadcast) —
    // do NOT invent one. Used as the dispatcher fallback stamp; on dispatch the
    // result already carries the target's actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL on-chain token swap (spends funds, broadcasts a signed transaction). Auto-routes by chain: KyberSwap on its supported EVM chains (incl. Robinhood Chain), with Uniswap as the all-EVM fallback; chain \"solana\" → Jupiter. REQUIRES a fresh matching swap_quote FIRST on the SAME venue — the execute gate blocks a swap that has no fresh matching quote (a Kyber quote can't authorize a Uniswap swap, and vice-versa), so always preview with swap_quote before calling this. EVM tokens must be a CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native — EVM symbol resolution is disabled to avoid wrong-contract matches; Solana accepts a symbol or mint. `amount` is the HUMAN decimal of tokenIn (e.g. \"1.5\", not wei/lamports). `side` (\"sell\"/\"buy\") is EVM-only; it tags the trade for portfolio tracking and does not apply to Solana.",
    parameters: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          description:
            "Chain to swap on. EVM slugs/aliases route to KyberSwap where supported (ethereum, base, arbitrum, robinhood, …) with Uniswap as fallback; the literal \"solana\" routes to Jupiter.",
        },
        tokenIn: {
          type: "string",
          description: "Input token. EVM: the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Solana: symbol or mint.",
        },
        tokenOut: {
          type: "string",
          description: "Output token. EVM: the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Solana: symbol or mint.",
        },
        amount: {
          type: "string",
          description: "Amount of tokenIn to swap, in HUMAN decimal units (e.g. \"1.5\"). Not wei/lamports.",
        },
        side: {
          type: "string",
          enum: ["sell", "buy"],
          description:
            "EVM-only. \"sell\" (default) routes to kyberswap.swap.sell; \"buy\" routes to kyberswap.swap.buy (opens a portfolio lot on tokenOut). Do not set for Solana swaps.",
        },
        slippageBps: {
          type: "number",
          description: "Optional slippage tolerance in basis points (50 = 0.5%).",
        },
        recipient: {
          type: "string",
          description: "EVM-only. Recipient address for the output token (defaults to the sender). Do not set for Solana swaps.",
        },
      },
      required: ["chain", "tokenIn", "tokenOut", "amount"],
    },
  },
  {
    name: "bridge",
    kind: "internal",
    mutating: true,
    // Mirrors the TARGET khalani.bridge manifest (mutating). At context pressure
    // barrier+ the dispatcher hard-denies the alias before the router resolves —
    // conservative and equivalent to denying the mutating target directly.
    pressureSafety: "mutating",
    // SAME actionKind the target khalani.bridge manifest carries
    // (user_wallet_broadcast) — do NOT invent one. Used as the dispatcher
    // fallback stamp; on dispatch the result already carries the target's
    // actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL cross-chain bridge (spends funds, signs + broadcasts on the source chain). Auto-routes by chain: Khalani between its supported chains; Relay to/from Robinhood Chain (which Khalani does NOT cover). REQUIRES a fresh matching bridge_quote FIRST on the SAME provider — the execute gate blocks a bridge with no fresh matching quote, so always preview with bridge_quote before calling this. Resolve fromToken/toToken addresses via token_find first. `amount` is in SMALLEST units (wei/lamports), matching the bridge quote.",
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address." },
        amount: { type: "string", description: "Amount in smallest units (wei/lamports)." },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        fromAddress: { type: "string", description: "Source wallet address override." },
        recipient: { type: "string", description: "Destination recipient override (defaults to your dest-chain wallet)." },
        refundTo: { type: "string", description: "Refund address override (defaults to fromAddress)." },
        referrer: { type: "string", description: "EVM referrer address for fee sharing." },
        referrerFeeBps: { type: "string", description: "Referrer fee in basis points (0-9999)." },
        filler: { type: "string", description: "Restrict quotes to a specific filler." },
        // NOTE: routeId / depositMethod are intentionally NOT exposed. They are
        // EXECUTE-ONLY (the bridge quote has no counterpart), so they can never be
        // bound to a quote — the bridge auto-selects the best route. The execute
        // gate fail-closes (block "unbindable_param") if they reach khalani.bridge
        // via the direct execute_tool path, so dropping them here is the menu half
        // of a defense-in-depth pair (8c security fix).
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amount"],
    },
  },
  {
    name: "token_check",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Safety-check an EVM token before trading it: detects honeypots and fee-on-transfer (tax) tokens via KyberSwap. Pass the chain and the token contract `address` (resolve it with token_find first). Read-only.",
    parameters: {
      type: "object",
      properties: {
        chain: { type: "string", description: "EVM chain slug or alias (ethereum, base, arbitrum, …)." },
        address: { type: "string", description: "Token contract address to inspect." },
      },
      required: ["chain", "address"],
    },
  },
  {
    name: "bridge_status",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Check cross-chain bridge order status via Khalani. Pass `orderId` to fetch one order's full lifecycle; omit it to list your recent bridge orders (with optional filters/pagination). Read-only.",
    parameters: {
      type: "object",
      properties: {
        orderId: {
          type: "string",
          description: "Khalani order ID. Provide to fetch a single order; omit to list your orders.",
        },
        address: { type: "string", description: "List mode: wallet address (optional — uses your configured wallet)." },
        wallet: { type: "string", description: "List mode: wallet family — eip155 or solana." },
        limit: { type: "number", description: "List mode: max results." },
        cursor: { type: "number", description: "List mode: pagination cursor for the next page." },
        fromChain: { type: "string", description: "List mode: source chain filter (ID or alias)." },
        toChain: { type: "string", description: "List mode: destination chain filter (ID or alias)." },
        orderIds: { type: "string", description: "List mode: comma-separated order IDs to filter." },
        txHashSearch: { type: "string", description: "List mode: search by transaction hash." },
      },
    },
  },
  {
    name: "bridge_quote",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a cross-chain bridge WITHOUT executing — routes, pricing, fees, and ETA. Auto-routes by chain: Khalani between its supported chains; Relay to/from Robinhood Chain (which Khalani doesn't cover). Resolve fromToken/toToken addresses via token_find first. `amount` is in SMALLEST units (wei/lamports), matching the underlying bridge quote. Read-only.",
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address." },
        amount: { type: "string", description: "Amount in smallest units (wei/lamports)." },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        fromAddress: { type: "string", description: "Source wallet address override." },
        recipient: { type: "string", description: "Destination recipient override." },
        refundTo: { type: "string", description: "Refund address override (defaults to fromAddress)." },
        referrer: { type: "string", description: "EVM referrer address for fee sharing." },
        referrerFeeBps: { type: "string", description: "Referrer fee in basis points (0-9999)." },
        filler: { type: "string", description: "Restrict quotes to a specific filler." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amount"],
    },
  },
];
