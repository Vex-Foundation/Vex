/**
 * Action-named internal tool aliases (Stage 8a read-only + Stage 8b mutating;
 * Agent Scan plan §4.2/§11.2 rewired the swap pair).
 *
 * These present the model with an obvious, action-named menu that routes to
 * existing protocol tools. They are ADDITIVE — the underlying protocol tools
 * stay reachable via discover_tools / execute_tool.
 *
 *   swap_quote          → family router: EVM → KyberSwap ONLY, Solana → solana.swap.quote
 *   swap_execute         → family router: EVM → KyberSwap ONLY, Solana → solana.swap.execute
 *                          (renamed from `swap` in place — Agent Scan plan §11.2)
 *   swap_quote_uniswap   → uniswap.swap.quote (HIDDEN — session-scoped reveal)
 *   swap_execute_uniswap → uniswap.swap.execute (HIDDEN — session-scoped reveal)
 *   token_check          → kyberswap.tokens.check   (EVM honeypot / fee-on-transfer)
 *   bridge_status        → khalani.orders.get (with id) / khalani.orders.list (without)
 *   bridge_quote         → khalani.quote.get        (read-only bridge preview)
 *   bridge               → MUTATING router (Stage 8c): → khalani.bridge (cross-chain)
 *
 * EVM branch is KyberSwap-only — the previous silent Kyber→Uniswap runtime
 * quote fallback is REMOVED. `swap_quote_uniswap`/`swap_execute_uniswap` are
 * the ONLY path to Uniswap now, and are hidden from the default tool list
 * (`visibility.ts`'s `requiresUniswapReveal`) until an eligible KyberSwap
 * route-not-found failure reveals them for the session
 * (`registry/uniswap-reveal.js`). Public schema for all four swap tools:
 * `{ chain, tokenIn, tokenOut, amountIn, slippageBps? }` — `side` and
 * `recipient` are REMOVED (no lot-direction/PnL tracking survives Agent Scan;
 * wallet-delta receipt decoding is the truth invariant, so a redirected
 * output is out of scope this phase).
 *
 * The read-only quote aliases are non-mutating, so dispatching them through
 * `executeProtocolTool` fires no approval gate. `swap_execute` /
 * `swap_execute_uniswap` / `bridge` ARE mutating: each is dispatched through a
 * DEDICATED dispatcher branch (`mutating-aliases.ts`) that resolves the target
 * and calls `executeProtocolTool` directly — letting that function SOLELY own
 * the ordering (prequote gate → approval gate → capture). A mutating alias
 * MUST NOT travel through the dispatcher's internal mutating-approval gate
 * (that would enqueue approval BEFORE the prequote gate). `bridge` REQUIRES a
 * fresh `bridge_quote` first — the bridge prequote (kind 'bridge', verdict
 * always 'unknown') seeds the gate; the two swap executes REQUIRE their own
 * matching quote on the SAME venue (provider-bound prequote identity — a
 * KyberSwap quote can never authorize a Uniswap execute and vice versa).
 *
 * `swap_quote` / `swap_quote_uniswap` route to quote toolIds that already
 * record a Stage-6c prequote via the hook in `executeProtocolTool` — calling a
 * quote before an execute naturally seeds the Stage-7 execute gate. No
 * prequote wiring lives here.
 *
 * NOTE: none of the swap aliases are `requiresEnv`-gated. They are routers
 * spanning both families; the Solana target's `JUPITER_API_KEY` requirement is
 * enforced downstream by `executeProtocolTool` (manifest.requiresEnv) only
 * when a Solana route is actually taken — gating the whole alias on a
 * Solana-only env var would wrongly hide the EVM path.
 */

import type { ToolDef } from "../types.js";

/** Shared JSON-schema properties for the Kyber/Jupiter-routed pair (swap_quote/swap_execute — unified §11.2 contract). */
const SWAP_SCHEMA_PROPERTIES = {
  chain: {
    type: "string" as const,
    description: "Chain to swap on. EVM slugs/aliases route to KyberSwap (ethereum, base, arbitrum, robinhood, …); the literal \"solana\" routes to Jupiter. Accepts a chain slug/alias or the numeric chain id token_find returns (e.g. base or 8453).",
  },
  tokenIn: {
    type: "string" as const,
    description: "Input token. EVM: the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Solana: symbol or mint.",
  },
  tokenOut: {
    type: "string" as const,
    description: "Output token. EVM: the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Solana: symbol or mint.",
  },
  amountIn: {
    type: "string" as const,
    description: "Amount of tokenIn to swap, in HUMAN decimal units (e.g. \"1.5\"). Not wei/lamports.",
  },
  slippageBps: {
    type: "number" as const,
    description: "Slippage tolerance in basis points (1 bps = 0.01%); default 50 = 0.5%, which fits deep, liquid pairs. It is the ONLY price protection on the trade. Pass the SAME value to the quote and the execute, or omit it on both — a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) 50 bps often fails. When it fails, the message says so and names this parameter: re-quote with a higher slippageBps and pass the same value to the execute. Do not read a slippage failure as \"this pair is untradeable\" and do not switch venue for it — another venue at 50 bps fails the same way. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept, so raise it in steps.",
  },
};
const SWAP_SCHEMA_REQUIRED = ["chain", "tokenIn", "tokenOut", "amountIn"];

/**
 * JSON-schema properties for the HIDDEN Uniswap-only pair (FIX-SPINE round 1,
 * finding 14/C4 — the shared `SWAP_SCHEMA_PROPERTIES` text above wrongly told
 * this EVM-only, Uniswap-only pair that chains route to KyberSwap and that
 * Solana is an option; neither is true here). Same param NAMES/shape (unified
 * §11.2 contract) — only the descriptive text differs.
 */
const UNISWAP_SWAP_SCHEMA_PROPERTIES = {
  chain: {
    type: "string" as const,
    description: "EVM chain to swap on (ethereum, base, arbitrum, robinhood, …) — Uniswap ONLY, no venue routing. Solana is NOT supported by this tool.",
  },
  tokenIn: {
    type: "string" as const,
    description: "Input token — the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native.",
  },
  tokenOut: {
    type: "string" as const,
    description: "Output token — the token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native.",
  },
  amountIn: {
    type: "string" as const,
    description: "Amount of tokenIn to swap, in HUMAN decimal units (e.g. \"1.5\"). Not wei.",
  },
  slippageBps: {
    type: "number" as const,
    description: "Slippage tolerance in basis points (1 bps = 0.01%); default 50 = 0.5%, which fits deep, liquid pairs. It is the ONLY price protection on the trade. Pass the SAME value to the quote and the execute, or omit it on both — a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) 50 bps often fails. When it fails, the message says so and names this parameter: re-quote with a higher slippageBps and pass the same value to the execute. Do not read a slippage failure as \"this pair is untradeable\" and do not switch venue for it — another venue at 50 bps fails the same way. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept, so raise it in steps.",
  },
};

export const ACTION_ALIAS_TOOLS: readonly ToolDef[] = [
  {
    name: "swap_quote",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a token swap WITHOUT executing — best route, expected output, price impact, and token-safety signals. EVM chains route to KyberSwap ONLY; chain \"solana\" → Jupiter. EVM tokens must be a CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native — EVM symbol resolution is disabled here to avoid wrong-contract matches; Solana accepts a symbol or mint. `amountIn` is the HUMAN decimal of tokenIn (e.g. \"1.5\", not wei/lamports). Call this BEFORE swap_execute: a fresh matching quote (same venue) is what unlocks execution. If KyberSwap cannot route this chain/token, the failure message offers a backup automatically when one is available — just follow what it says.",
    parameters: {
      type: "object",
      properties: SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "swap_execute",
    kind: "internal",
    mutating: true,
    // Mirrors the TARGET swap-execute manifests (kyberswap.swap.execute,
    // solana.swap.execute are both mutating). At context pressure barrier+ the
    // dispatcher hard-denies the alias before the router resolves — conservative
    // and equivalent to denying the mutating target directly.
    pressureSafety: "mutating",
    // SAME actionKind the target swap manifests carry (user_wallet_broadcast) —
    // do NOT invent one. Used as the dispatcher fallback stamp; on dispatch the
    // result already carries the target's actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL on-chain token swap (spends funds, broadcasts a signed transaction). EVM chains route to KyberSwap ONLY; chain \"solana\" → Jupiter. REQUIRES a fresh matching swap_quote FIRST on the SAME venue — the execute gate blocks a swap that has no fresh matching quote, so always preview with swap_quote before calling this. EVM tokens must be a CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native — EVM symbol resolution is disabled to avoid wrong-contract matches; Solana accepts a symbol or mint. `amountIn` is the HUMAN decimal of tokenIn (e.g. \"1.5\", not wei/lamports). Failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
    parameters: {
      type: "object",
      properties: SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "swap_quote_uniswap",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    // Hidden by default — visibility.ts's requiresUniswapReveal gate only shows
    // this once an eligible KyberSwap route-not-found failure (or a swap-role
    // mined revert, REVISION 1) revealed it for the session
    // (registry/uniswap-reveal.js). discover_tools can still find it by
    // toolId/description regardless of catalog visibility.
    visibility: { requiresUniswapReveal: true },
    description:
      "Preview a token swap on Uniswap WITHOUT executing — the KyberSwap fallback venue. Only usable after a KyberSwap swap_quote/swap_execute failure revealed it for this session (a route-not-found class failure, or the Kyber swap transaction reverting on-chain). EVM ONLY (chain must NOT be \"solana\"). Tokens must be a CONTRACT ADDRESS or native ETH/native. `amountIn` is the HUMAN decimal of tokenIn. Call this BEFORE swap_execute_uniswap: a fresh matching quote unlocks execution, and only on THIS venue (a KyberSwap quote cannot authorize a Uniswap execute).",
    parameters: {
      type: "object",
      properties: UNISWAP_SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
    },
  },
  {
    name: "swap_execute_uniswap",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    actionKind: "user_wallet_broadcast",
    visibility: { requiresUniswapReveal: true },
    description:
      "Execute a REAL on-chain token swap on Uniswap (spends funds, broadcasts a signed transaction) — the KyberSwap fallback venue. Only usable after a KyberSwap failure revealed it for this session. REQUIRES a fresh matching swap_quote_uniswap FIRST on the SAME venue. EVM ONLY. `amountIn` is the HUMAN decimal of tokenIn. Failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
    parameters: {
      type: "object",
      properties: UNISWAP_SWAP_SCHEMA_PROPERTIES,
      required: SWAP_SCHEMA_REQUIRED,
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
        amount: { type: "string", description: "Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). Get the token's decimals from token_find / khalani.tokens.search, which returns decimals per chain — a raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen." },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        fromAddress: { type: "string", description: "Source wallet address override." },
        recipient: { type: "string", description: "Destination recipient override (defaults to your dest-chain wallet)." },
        // NOTE: refundTo is intentionally NOT exposed — it is DERIVED from the
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
        chain: { type: "string", description: "EVM chain slug or alias (ethereum, base, arbitrum, …). Accepts a chain slug/alias or the numeric chain id token_find returns (e.g. base or 8453)." },
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
        amount: { type: "string", description: "Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). Get the token's decimals from token_find / khalani.tokens.search, which returns decimals per chain — a raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen." },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        fromAddress: { type: "string", description: "Source wallet address override." },
        recipient: { type: "string", description: "Destination recipient override." },
        // NOTE: refundTo is intentionally NOT exposed — it is DERIVED from the
        // selected source wallet and a caller-supplied value is rejected by
        // name (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `khalani.bridge` / `khalani.quote.get` manifests.
        // referrer / referrerFeeBps intentionally NOT exposed — see the note on
        // the `bridge` alias above. A fee-bearing quote is what would later let
        // a matching fee-bearing execute through the prequote gate.
        filler: { type: "string", description: "Restrict quotes to a specific filler." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amount"],
    },
  },
  {
    // HIDDEN Relay-fallback bridge PREVIEW (bridge factory W5; plan R7). Hidden
    // from the default tool list until the session has an active route reveal —
    // `registry/visibility.ts` filters `RELAY_REVEAL_GATED_ALIAS_NAMES` out of
    // `getVisibleToolDefs` (a route-bound reveal has no route context at
    // visibility time, so this is the session-level predicate; the EXACT-route
    // enforcement is at dispatch). Unlike generic `bridge_quote` (Khalani except
    // the local-chain exception), this ALWAYS targets Relay.
    name: "bridge_quote_relay",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      "Preview a cross-chain bridge via Relay WITHOUT executing — the Khalani fallback venue. Only usable after a Khalani no-route failure revealed it for this exact route, or the Khalani deposit transaction reverting on-chain for this exact route (or for a Robinhood-Chain route, always available). Resolve fromToken/toToken addresses via token_find first. `amount` is in SMALLEST units (wei/lamports). Call this BEFORE bridge_execute_relay: a fresh matching quote on Relay is what unlocks execution.",
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address, or native ETH/native." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address, or native ETH/native." },
        amount: { type: "string", description: "Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). Get the token's decimals from token_find / khalani.tokens.search, which returns decimals per chain — a raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen." },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        recipient: { type: "string", description: "Destination recipient override (defaults to your dest-chain wallet)." },
        // NOTE: refundTo is intentionally NOT exposed — the Relay handler
        // DERIVES it from the resolved source wallet and both relay alias
        // routers reject a caller-supplied value by name
        // (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `relay.bridge` / `relay.quote.get` manifests.
        slippageBps: { type: "string", description: "Slippage tolerance in basis points for the destination-side fill (1 bps = 0.01%). Higher tolerance widens the worst-case received amount on the destination chain. When a bridge quote fails or fills keep expiring, re-quote with a higher value rather than retrying the same one. Vex caps it at 1000 (10%) and rejects anything above rather than clamping." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amount"],
    },
  },
  {
    // HIDDEN Relay-fallback bridge EXECUTE (bridge factory W5; plan R7/R8).
    // Hidden pre-reveal exactly like bridge_quote_relay above. Dispatched via the
    // dedicated mutating-alias branch (`MUTATING_PROTOCOL_ALIAS_ROUTERS`), so it
    // needs NO INTERNAL_TOOL_LOADERS entry. The route-bound reveal is enforced by
    // the router AND by `executeProtocolTool`'s gate on `relay.bridge`.
    name: "bridge_execute_relay",
    kind: "internal",
    mutating: true,
    pressureSafety: "mutating",
    // SAME actionKind the target relay.bridge manifest carries — do NOT invent
    // one. Dispatcher fallback stamp; on dispatch the result already carries the
    // target's actionKind from executeProtocolTool.
    actionKind: "user_wallet_broadcast",
    description:
      "Execute a REAL cross-chain bridge via Relay (spends funds, signs + broadcasts on the source chain) — the Khalani fallback venue. Only usable after a Khalani no-route failure revealed it for this exact route, or the Khalani deposit transaction reverting on-chain for this exact route (or for a Robinhood-Chain route, always available). REQUIRES a fresh matching bridge_quote_relay FIRST on Relay. Resolve fromToken/toToken addresses via token_find first. `amount` is in SMALLEST units (wei/lamports). Failed and pending attempts are recorded and shown with chain + tx hash + explorer link, same as confirmed ones.",
    parameters: {
      type: "object",
      properties: {
        fromChain: { type: "string", description: "Source chain ID or alias." },
        fromToken: { type: "string", description: "Source token address, or native ETH/native." },
        toChain: { type: "string", description: "Destination chain ID or alias." },
        toToken: { type: "string", description: "Destination token address, or native ETH/native." },
        amount: { type: "string", description: "Amount in raw atomic units of fromToken (e.g. USDC has 6 decimals, so 1 USDC = \"1000000\"). Get the token's decimals from token_find / khalani.tokens.search, which returns decimals per chain — a raw amount next to a token whose decimals you have not read is a thousandfold error waiting to happen." },
        tradeType: { type: "string", description: "EXACT_INPUT or EXACT_OUTPUT (default: EXACT_INPUT)." },
        recipient: { type: "string", description: "Destination recipient override (defaults to your dest-chain wallet)." },
        // NOTE: refundTo is intentionally NOT exposed — the Relay handler
        // DERIVES it from the resolved source wallet and both relay alias
        // routers reject a caller-supplied value by name
        // (`findCallerSuppliedForbiddenParam`). Advertising it here only
        // taught the model a call that always fails. Same policy as the
        // `relay.bridge` / `relay.quote.get` manifests.
        slippageBps: { type: "string", description: "Slippage tolerance in basis points for the destination-side fill (1 bps = 0.01%). Higher tolerance widens the worst-case received amount on the destination chain. When a bridge quote fails or fills keep expiring, re-quote with a higher value rather than retrying the same one. Vex caps it at 1000 (10%) and rejects anything above rather than clamping." },
      },
      required: ["fromChain", "fromToken", "toChain", "toToken", "amount"],
    },
  },
];
