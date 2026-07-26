/**
 * Action-named READ-ONLY alias handlers (Stage 8a; Agent Scan plan §4.2/§11.2
 * rewired the swap quotes).
 *
 * Each handler validates its (untrusted) args with Zod at the boundary,
 * translates them into the TARGET protocol tool's exact param names, and
 * dispatches via `executeProtocolTool`. Because every target is non-mutating,
 * no approval gate fires. `swap_quote` / `swap_quote_uniswap` are each a
 * family ROUTER (EVM vs Solana for `swap_quote`; EVM-only for the hidden
 * Uniswap pair); the other three are pass-through / mode selectors.
 *
 * Param translation is the whole point — the alias presents ONE clean
 * LLM-facing shape and maps to whatever the underlying manifest calls things:
 *
 *   swap_quote (EVM)    { chain, tokenIn, tokenOut, amountIn, slippageBps? }
 *                       → kyberswap.swap.quote (SAME keys — KyberSwap ONLY, no venue fallback)
 *   swap_quote (Solana) → solana.swap.quote   { inputToken: tokenIn, outputToken: tokenOut, amount: Number(amountIn), slippageBps? }
 *   swap_quote_uniswap  → uniswap.swap.quote (SAME keys) — HIDDEN, dispatch-gated on
 *                         `isUniswapPairRevealed(sessionId)` (plan §11.2)
 *   token_check         { chain, address }      → kyberswap.tokens.check (same keys)
 *   bridge_status (id)  { orderId }              → khalani.orders.get { orderId }
 *   bridge_status (list)→ khalani.orders.list (pass through list filters)
 *   bridge_quote        → khalani.quote.get (same keys)
 *
 * Units: kyber/uniswap/jupiter swap `amountIn` is HUMAN decimal (e.g. "1.5");
 * khalani bridge `amount` is SMALLEST units (wei/lamports). The alias schemas
 * document this and translation preserves it (no unit conversion happens here).
 *
 * Chain params on the swap/token aliases accept BOTH a slug and a chain ID, in
 * either JSON type (`"base"`, `"8453"`, `8453`) — `token_find`
 * (khalani.tokens.search) returns `chainId` as a NUMBER, so an id is the form
 * the agent normally holds. All three normalize to one value before venue
 * classification (`./chain-param.js`), so the way a chain was spelled can never
 * change which venue it routes to. The MUTATING executes share that exact
 * schema (`../mutating-aliases.ts`) — quote and execute must accept the same
 * forms or a legal quote cannot be executed. The bridge aliases are
 * deliberately NOT included: their chain names belong to the Khalani/Relay
 * namespaces and feed the bridge prequote match-hash, so widening them is a
 * separate change.
 *
 * KyberSwap route-not-found reveal (plan §11.2): when `classifySwapFamily`
 * determines an EVM chain has NO KyberSwap aggregator support at all
 * (`family.venue === "uniswap"`), `swap_quote` reveals the hidden Uniswap pair
 * for the session BEFORE failing — this is the "local chain-not-Kyber-
 * supported, registry gate, pre-call" reveal-eligible case (the ONLY one this
 * module owns). The other eligible cases — Kyber codes 4008/4010/4011, and
 * (REVISION 1 — reveal-on-execute-revert design) a `swap`-role MINED on-chain
 * revert of `kyberswap.swap.execute`'s staged broadcast — fire from INSIDE the
 * `kyberswap.swap.quote`/`kyberswap.swap.execute` handlers themselves (they
 * hold the raw failure code/outcome + already know `context.sessionId`) —
 * this module does not re-derive them.
 */

import { z } from "zod";

import type { ToolResult } from "../types.js";
import type { InternalToolContext } from "./types.js";
import { fail } from "./types.js";
import { executeProtocolTool } from "../protocols/runtime.js";
import { ChainParam } from "./chain-param.js";
import { classifySwapFamily, isEvmSwapTokenInput } from "./swap-family.js";
import { isNumericChainIdInput } from "@tools/kyberswap/chains.js";
import { resolveBridgeVenue } from "@tools/relay/bridge-venue.js";
import { findCallerSuppliedForbiddenParam } from "@tools/khalani/request.js";
import { revealUniswapPair, isUniswapPairRevealed } from "../registry/uniswap-reveal.js";
import { evaluateRelayRevealGate } from "../registry/relay-reveal.js";
import { resolveUniswapDeployment } from "@tools/uniswap/chains.js";
import logger from "@utils/logger.js";

// ── Shared dispatch context projection ───────────────────────────────
//
// The read-only aliases need the same execution-context slice the Khalani
// read aliases pass (no `contextUsageBand` — these are never mutating, so the
// protocol-runtime pressure guard is a no-op for them; mirrors
// internal/khalani.ts).

function protocolContext(context: InternalToolContext): Parameters<typeof executeProtocolTool>[1] {
  return {
    sessionPermission: context.sessionPermission,
    approved: context.approved,
    sessionId: context.sessionId,
    walletResolution: context.walletResolution,
    walletPolicy: context.walletPolicy,
  };
}

// ── swap_quote — EVM (KyberSwap ONLY)/Solana family router ───────────
//
// The family classifier (`classifySwapFamily`) is shared with the Stage 8b
// MUTATING `swap_execute` alias router (`tools/mutating-aliases.ts`) so the
// read-only quote and the execute can never disagree on which family/venue a
// chain maps to.

// `.strict()` (FIX-SPINE round 1, finding 14/C4) — the removed legacy
// `side`/`recipient`/`amount` fields are REJECTED with a clear message, never
// silently stripped. Silently dropping `recipient` in particular would be a
// transaction-safety-significant silent behavior change (the agent believes
// it redirected output that in fact went to the sender).
const SwapQuoteArgs = z.object({
  chain: ChainParam,
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapQuoteArgs = z.infer<typeof SwapQuoteArgs>;

export async function handleSwapQuote(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = SwapQuoteArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`swap_quote: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const a: SwapQuoteArgs = parsed.data;

  const family = classifySwapFamily(a.chain);
  if (family.kind === "unknown") {
    // A chain ID is refused AS an id. It came from token_find, so "cannot
    // determine swap family" would read as a lookup mistake rather than the
    // truth: no venue in the tree serves that chain. This branch runs BEFORE
    // the Uniswap reveal below on purpose — revealing the fallback would claim
    // Uniswap covers a chain nothing registers, and would spend the session's
    // one-shot reveal to say it.
    if (isNumericChainIdInput(a.chain)) {
      return fail(
        `swap_quote: chain id ${a.chain} is not a chain Vex can swap on. ` +
          `Pass a supported EVM chain — either its slug or the chain id token_find ` +
          `returns (ethereum/1, base/8453, arbitrum/42161, …) — or "solana".`,
      );
    }
    return fail(
      `swap_quote: cannot determine swap family for chain "${a.chain}". ` +
        `Use a supported EVM chain (e.g. ethereum, base, arbitrum) or "solana".`,
    );
  }

  if (family.kind === "solana") {
    // Solana quote manifest types `amount` as a NUMBER (human decimal) — coerce
    // the unified string here so the protocol-runtime type check passes.
    const amount = Number(a.amountIn);
    if (!Number.isFinite(amount) || amount <= 0) {
      return fail(`swap_quote: amountIn "${a.amountIn}" is not a positive number.`);
    }
    const params: Record<string, unknown> = {
      inputToken: a.tokenIn,
      outputToken: a.tokenOut,
      amount,
      ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
    };
    return executeProtocolTool({ toolId: "solana.swap.quote", params }, protocolContext(context));
  }

  // EVM → KyberSwap ONLY (plan §11.2 — the silent Uniswap fallback is removed).
  // Both quote handlers resolve tokens strictly (address-only), so DEX symbol
  // search is disabled to avoid wrong-contract matches (e.g. "USDC" → axlUSDC).
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    return fail(
      "swap_quote: EVM tokens must be a contract address — resolve the symbol " +
        "with token_find first, or pass native ETH/native. (Symbol resolution " +
        "via the DEX is disabled to avoid wrong-contract matches.)",
    );
  }

  // `family.venue === "uniswap"` means the venue classifier found NO KyberSwap
  // aggregator support for this chain at all (kyberAggregatorSlug undefined) —
  // this is the "local chain-not-Kyber-supported, registry gate, pre-call"
  // reveal-eligible case (plan §11.2). Reveal BEFORE failing so the very next
  // turn can call swap_quote_uniswap.
  if (family.venue === "uniswap") {
    revealUniswapPair(context.sessionId);
    logger.info("swap_quote.uniswap_reveal", { reason: "chain_unsupported", chain: a.chain });
    return fail(
      `swap_quote: KyberSwap does not support chain "${a.chain}". ` +
        `swap_quote_uniswap is now available for this session as a fallback (Uniswap venue).`,
    );
  }

  const params: Record<string, unknown> = {
    chain: family.chain,
    tokenIn: a.tokenIn,
    tokenOut: a.tokenOut,
    amountIn: a.amountIn,
    ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
  };
  return executeProtocolTool({ toolId: "kyberswap.swap.quote", params }, protocolContext(context));
}

// ── swap_quote_uniswap — HIDDEN EVM-only Uniswap fallback quote ──────

const SwapQuoteUniswapArgs = z.object({
  chain: ChainParam,
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapQuoteUniswapArgs = z.infer<typeof SwapQuoteUniswapArgs>;

/**
 * Dispatch-side gate (plan §11.2 hard rule): rejected with a clean ToolResult
 * for a session that has no active reveal — independent of whatever the tool
 * list showed the model (a direct dispatch attempt is rejected the same way).
 */
export async function handleSwapQuoteUniswap(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  if (!isUniswapPairRevealed(context.sessionId)) {
    return fail(
      "swap_quote_uniswap is not available yet for this session — it unlocks after an eligible "
        + "KyberSwap route-not-found failure at quote time, or the Kyber swap transaction reverting "
        + "on-chain at execute time (try swap_quote first).",
    );
  }

  const parsed = SwapQuoteUniswapArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`swap_quote_uniswap: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const a: SwapQuoteUniswapArgs = parsed.data;

  // Resolve DIRECTLY against the Uniswap deployment registry — NOT via
  // `classifySwapFamily` (which prioritizes KyberSwap whenever it ALSO covers
  // the chain; the whole point of this fallback is to reach Uniswap even on a
  // chain Kyber supports, e.g. after a 4011 token-not-found reveal).
  const deployment = resolveUniswapDeployment(a.chain);
  if (!deployment) {
    return fail(`swap_quote_uniswap: "${a.chain}" has no verified Uniswap deployment.`);
  }
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    return fail(
      "swap_quote_uniswap: EVM tokens must be a contract address — resolve the symbol "
        + "with token_find first, or pass native ETH/native.",
    );
  }

  const params: Record<string, unknown> = {
    chain: deployment.key,
    tokenIn: a.tokenIn,
    tokenOut: a.tokenOut,
    amountIn: a.amountIn,
    ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
  };
  return executeProtocolTool({ toolId: "uniswap.swap.quote", params }, protocolContext(context));
}

// ── token_check — EVM honeypot / fee-on-transfer ─────────────────────

const TokenCheckArgs = z.object({
  chain: ChainParam,
  address: z.string().min(1, { message: "address is required" }),
});

export async function handleTokenCheck(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = TokenCheckArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`token_check: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const { chain, address } = parsed.data;
  return executeProtocolTool(
    { toolId: "kyberswap.tokens.check", params: { chain, address } },
    protocolContext(context),
  );
}

// ── bridge_status — order get (by id) / orders list ──────────────────

const BridgeStatusArgs = z.object({
  orderId: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  wallet: z.string().min(1).optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.number().int().nonnegative().optional(),
  fromChain: z.string().min(1).optional(),
  toChain: z.string().min(1).optional(),
  orderIds: z.string().min(1).optional(),
  txHashSearch: z.string().min(1).optional(),
});

export async function handleBridgeStatus(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = BridgeStatusArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`bridge_status: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const a = parsed.data;

  if (a.orderId !== undefined) {
    return executeProtocolTool(
      { toolId: "khalani.orders.get", params: { orderId: a.orderId } },
      protocolContext(context),
    );
  }

  // List mode — forward only the list filters that were provided.
  const params: Record<string, unknown> = {};
  if (a.address !== undefined) params.address = a.address;
  if (a.wallet !== undefined) params.wallet = a.wallet;
  if (a.limit !== undefined) params.limit = a.limit;
  if (a.cursor !== undefined) params.cursor = a.cursor;
  if (a.fromChain !== undefined) params.fromChain = a.fromChain;
  if (a.toChain !== undefined) params.toChain = a.toChain;
  if (a.orderIds !== undefined) params.orderIds = a.orderIds;
  if (a.txHashSearch !== undefined) params.txHashSearch = a.txHashSearch;
  return executeProtocolTool({ toolId: "khalani.orders.list", params }, protocolContext(context));
}

// ── bridge_quote — read-only cross-chain bridge preview ──────────────

const BridgeQuoteArgs = z.object({
  fromChain: z.string().min(1, { message: "fromChain is required" }),
  fromToken: z.string().min(1, { message: "fromToken is required" }),
  toChain: z.string().min(1, { message: "toChain is required" }),
  toToken: z.string().min(1, { message: "toToken is required" }),
  amount: z.string().min(1, { message: "amount is required (smallest units)" }),
  tradeType: z.string().min(1).optional(),
  fromAddress: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  // No `refundTo` — the refund destination is derived from the selected
  // source wallet, never taken from tool input (refund-destination policy in
  // `@tools/khalani/request.js`).
  filler: z.string().min(1).optional(),
  slippageBps: z.string().min(1).optional(),
});

export async function handleBridgeQuote(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  // Fee params and the refund destination are rejected BY NAME, never silently
  // stripped. This schema is not `.strict()`, so dropping the keys alone would
  // let the attempt pass unnoticed — and the QUOTE is precisely what the
  // prequote gate would later bind a matching execute against, so an attacker
  // who sets the same value on both would collide the hashes and pass the gate.
  // See the two policy blocks in `@tools/khalani/request.js`.
  const forbiddenParam = findCallerSuppliedForbiddenParam(args);
  if (forbiddenParam !== null) {
    return fail(
      `bridge_quote: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  const parsed = BridgeQuoteArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`bridge_quote: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const a = parsed.data;

  // Route the quote to the SAME venue the `bridge` execute alias uses (Relay when
  // either side is Robinhood Chain, else Khalani), so the venue-bound bridge
  // prequote gate collides between the quote and the execute.
  if (resolveBridgeVenue(a.fromChain, a.toChain) === "relay") {
    const params: Record<string, unknown> = {
      fromChain: a.fromChain,
      fromToken: a.fromToken,
      toChain: a.toChain,
      toToken: a.toToken,
      amount: a.amount,
    };
    if (a.tradeType !== undefined) params.tradeType = a.tradeType;
    if (a.recipient !== undefined) params.recipient = a.recipient;
    if (a.slippageBps !== undefined) params.slippageBps = a.slippageBps;
    return executeProtocolTool({ toolId: "relay.quote.get", params }, protocolContext(context));
  }

  const params: Record<string, unknown> = {
    fromChain: a.fromChain,
    fromToken: a.fromToken,
    toChain: a.toChain,
    toToken: a.toToken,
    amount: a.amount,
  };
  if (a.tradeType !== undefined) params.tradeType = a.tradeType;
  if (a.fromAddress !== undefined) params.fromAddress = a.fromAddress;
  if (a.recipient !== undefined) params.recipient = a.recipient;
  if (a.filler !== undefined) params.filler = a.filler;
  return executeProtocolTool({ toolId: "khalani.quote.get", params }, protocolContext(context));
}

// ── bridge_quote_relay — HIDDEN Relay-only bridge preview (route-bound reveal) ──
//
// The read half of the hidden Relay fallback pair (bridge factory W5; plan R7).
// Unlike the generic `bridge_quote` (which stays Khalani-routed except the
// local-chain static exception), this alias ALWAYS targets `relay.quote.get`. It
// is dispatch-gated on the ROUTE-BOUND reveal (`evaluateRelayRevealGate`) here as
// an early, clean rejection; `executeProtocolTool`'s own gate on
// `relay.quote.get` is the un-bypassable backstop. Robinhood/local routes pass
// the gate via the always-allowed carve-out.

const BridgeQuoteRelayArgs = z.object({
  fromChain: z.string().min(1, { message: "fromChain is required" }),
  fromToken: z.string().min(1, { message: "fromToken is required" }),
  toChain: z.string().min(1, { message: "toChain is required" }),
  toToken: z.string().min(1, { message: "toToken is required" }),
  amount: z.string().min(1, { message: "amount is required (smallest units)" }),
  tradeType: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  // No `refundTo` — the refund destination is derived from the selected
  // source wallet, never taken from tool input (refund-destination policy in
  // `@tools/khalani/request.js`).
  slippageBps: z.string().min(1).optional(),
});

export async function handleBridgeQuoteRelay(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  if (evaluateRelayRevealGate(args, context.sessionId).decision === "deny") {
    return fail(
      "bridge_quote_relay is not available for this route yet — it unlocks after an eligible "
        + "Khalani no-route failure for this exact route, or the Khalani deposit transaction reverting "
        + "on-chain for this exact route (Robinhood routes are always available via bridge_quote). "
        + "Try bridge_quote first.",
    );
  }

  // This schema is not `.strict()` either, so the same by-name refusal applies
  // — otherwise a redirected refund address would be dropped here in silence.
  const forbiddenParam = findCallerSuppliedForbiddenParam(args);
  if (forbiddenParam !== null) {
    return fail(
      `bridge_quote_relay: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  const parsed = BridgeQuoteRelayArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`bridge_quote_relay: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const a = parsed.data;

  const params: Record<string, unknown> = {
    fromChain: a.fromChain,
    fromToken: a.fromToken,
    toChain: a.toChain,
    toToken: a.toToken,
    amount: a.amount,
  };
  if (a.tradeType !== undefined) params.tradeType = a.tradeType;
  if (a.recipient !== undefined) params.recipient = a.recipient;
  if (a.slippageBps !== undefined) params.slippageBps = a.slippageBps;
  return executeProtocolTool({ toolId: "relay.quote.get", params }, protocolContext(context));
}
