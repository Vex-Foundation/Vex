/**
 * Action-named READ-ONLY alias handlers (Stage 8a; Agent Scan plan §4.2/§11.2
 * rewired the swap quotes).
 *
 * Each handler validates its (untrusted) args with Zod at the boundary,
 * translates them into the TARGET protocol tool's exact param names, and
 * dispatches via `executeProtocolTool`. Because every target is non-mutating,
 * no approval gate fires. `SwapQuote` / `SwapQuoteUniswap` are each a
 * family ROUTER (EVM vs Solana for `SwapQuote`; EVM-only for the hidden
 * Uniswap pair); the other three are pass-through / mode selectors.
 *
 * Param translation is the whole point — the alias presents ONE clean
 * LLM-facing shape and maps to whatever the underlying manifest calls things:
 *
 *   SwapQuote (EVM)    { chain, tokenIn, tokenOut, amountIn, slippageBps? }
 *                       → kyberswap.swap.quote (SAME keys — KyberSwap ONLY, no venue fallback)
 *   SwapQuote (Solana) → solana.swap.quote (SAME keys — W5a unified them: tokenIn/tokenOut/amountIn)
 *   SwapQuoteUniswap  → uniswap.swap.quote (SAME keys) — always available
 *   TokenCheck         { chain, tokenAddress } → kyberswap.tokens.check (same keys; the
 *                       retired `address` spelling is rejected by name on BOTH lanes, and
 *                       supplying both spellings is rejected too)
 *   BridgeStatus (id)  { orderId }              → khalani.orders.get { orderId }
 *   BridgeStatus (list)→ khalani.orders.list (pass through list filters)
 *   BridgeQuote        → khalani.quote.get (same keys)
 *
 * Units (SPEC §1.3): kyber/uniswap/jupiter swap `amountIn` is HUMAN decimal
 * (e.g. "1.5"); the bridge legs take `amountRaw`, RAW base units (wei/lamports)
 * — the same key the khalani/relay manifests declare. The alias schemas document
 * this and translation preserves it (no unit conversion happens here). The
 * retired bare `amount` key is rejected by name on both lanes.
 *
 * Chain params on the swap/token aliases accept BOTH a slug and a chain ID, in
 * either JSON type (`"base"`, `"8453"`, `8453`) — `TokenFind`
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
 * VENUE ROUTING (owner decision D4). The Uniswap and Relay venue tools are
 * ALWAYS callable; nothing here unlocks them. When `classifySwapFamily`
 * determines an EVM chain has NO KyberSwap aggregator support at all
 * (`family.venue === "uniswap"`), `SwapQuote` refuses and NAMES
 * `SwapQuoteUniswap` as the venue that covers the chain, which the model can
 * act on in the same turn. Failure-shaped venue guidance for the cases this
 * module cannot see — Kyber codes 4008/4010/4011, a mined revert, a pre-sign
 * revert, an unavailable edge — is worded inside the KyberSwap handlers
 * themselves (`kyberswap/handlers/swap/fallback-messaging.ts`), which hold the
 * raw failure code; this module does not re-derive them.
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
import { findCallerSuppliedForbiddenParamOrDestinationKey } from "@tools/khalani/request.js";
import { khalaniSlippageRejection } from "../protocols/khalani/slippage-unsupported.js";
import { rejectBridgeStatusModeConflict } from "../protocols/khalani/bridge-status-mode.js";
import { dropEmptyModelValues, formatZodIssuesForModel } from "./arg-validation.js";
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
    // Operator Stop — an alias must not be the path that drops it.
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  };
}

// ── SwapQuote — EVM (KyberSwap ONLY)/Solana family router ───────────
//
// The family classifier (`classifySwapFamily`) is shared with the Stage 8b
// MUTATING `SwapExecute` alias router (`tools/mutating-aliases.ts`) so the
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
    return fail(`SwapQuote: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }
  const a: SwapQuoteArgs = parsed.data;

  const family = classifySwapFamily(a.chain);
  if (family.kind === "unknown") {
    // A chain ID is refused AS an id. It came from TokenFind, so "cannot
    // determine swap family" would read as a lookup mistake rather than the
    // truth: no venue in the tree serves that chain. This branch runs BEFORE
    // the Uniswap branch below on purpose — naming the Uniswap venue would
    // claim it covers a chain nothing registers.
    if (isNumericChainIdInput(a.chain)) {
      return fail(
        `SwapQuote: chain id ${a.chain} is not a chain Vex can swap on. ` +
          `Pass a supported EVM chain — either its slug or the chain id TokenFind ` +
          `returns (ethereum/1, base/8453, arbitrum/42161, …) — or "solana".`,
      );
    }
    return fail(
      `SwapQuote: cannot determine swap family for chain "${a.chain}". ` +
        `Use a supported EVM chain (e.g. ethereum, base, arbitrum) or "solana".`,
    );
  }

  if (family.kind === "solana") {
    // W5a: the Solana quote manifest now uses the SAME keys as the alias
    // (tokenIn/tokenOut/amountIn, amount as a human decimal STRING), so this
    // lane no longer coerces the amount through a float on its way in.
    const params: Record<string, unknown> = {
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amountIn: a.amountIn,
      ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
    };
    return executeProtocolTool({ toolId: "solana.swap.quote", params }, protocolContext(context));
  }

  // EVM → KyberSwap ONLY (plan §11.2 — the silent Uniswap fallback is removed).
  // Both quote handlers resolve tokens strictly (address-only), so DEX symbol
  // search is disabled to avoid wrong-contract matches (e.g. "USDC" → axlUSDC).
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    return fail(
      "SwapQuote: EVM tokens must be a contract address — resolve the symbol " +
        "with TokenFind first, or pass native ETH/native. (Symbol resolution " +
        "via the DEX is disabled to avoid wrong-contract matches.)",
    );
  }

  // `family.venue === "uniswap"` means the venue classifier found NO KyberSwap
  // aggregator support for this chain at all (kyberAggregatorSlug undefined).
  // Name the venue that DOES cover it: SwapQuoteUniswap is always callable, so
  // this refusal is actionable in the same turn.
  if (family.venue === "uniswap") {
    return fail(
      `SwapQuote: KyberSwap does not support chain "${a.chain}". ` +
        `Use SwapQuoteUniswap for this chain.`,
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

// ── SwapQuoteUniswap — HIDDEN EVM-only Uniswap fallback quote ──────

const SwapQuoteUniswapArgs = z.object({
  chain: ChainParam,
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapQuoteUniswapArgs = z.infer<typeof SwapQuoteUniswapArgs>;

/**
 * Resolves DIRECTLY against the Uniswap deployment registry — NOT
 * `classifySwapFamily`, which prioritizes KyberSwap whenever it ALSO covers the
 * chain. Naming the venue in the tool is what lets the model reach Uniswap even
 * on a chain Kyber serves.
 */
export async function handleSwapQuoteUniswap(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const parsed = SwapQuoteUniswapArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`SwapQuoteUniswap: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }
  const a: SwapQuoteUniswapArgs = parsed.data;

  // Resolve DIRECTLY against the Uniswap deployment registry — NOT via
  // `classifySwapFamily` (which prioritizes KyberSwap whenever it ALSO covers
  // the chain; the whole point of this fallback is to reach Uniswap even on a
  // chain Kyber supports, e.g. after a 4011 token-not-found refusal).
  const deployment = resolveUniswapDeployment(a.chain);
  if (!deployment) {
    return fail(`SwapQuoteUniswap: "${a.chain}" has no verified Uniswap deployment.`);
  }
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    return fail(
      "SwapQuoteUniswap: EVM tokens must be a contract address — resolve the symbol "
        + "with TokenFind first, or pass native ETH/native.",
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

// ── TokenCheck — EVM honeypot / fee-on-transfer ─────────────────────

/**
 * `.strict()` is the point, not decoration.
 *
 * A plain `z.object()` IGNORES an undeclared key, so a call that still spelled
 * the token `address` parsed "successfully" and dispatched with the field
 * missing — the alias lane silently dropping what the protocol lane rejects by
 * name. Strict parsing closes that hole for every unknown key; the retired key
 * gets the explicit message below because "unrecognized key" does not tell an
 * agent what to send instead.
 */
const TokenCheckArgs = z.object({
  chain: ChainParam,
  tokenAddress: z.string().min(1, { message: "tokenAddress is required" }),
}).strict();

/**
 * The retired `address` key, refused BY NAME and BEFORE parsing.
 *
 * Before parsing, because supplying BOTH spellings must also refuse: a call
 * carrying `address` and `tokenAddress` is ambiguous about which one the caller
 * believes is being checked, and quietly preferring one would run a honeypot
 * check against an address the agent may not have meant. There is no precedence
 * rule here on purpose — the caller re-sends one key.
 */
function refuseRetiredTokenCheckAddress(args: Record<string, unknown>): string | null {
  if (!Object.hasOwn(args, "address")) return null;
  const both = Object.hasOwn(args, "tokenAddress");
  return (
    'TokenCheck: the parameter "address" was retired and renamed to "tokenAddress"'
    + (both
      ? ' — you supplied BOTH "address" and "tokenAddress", and Vex will not guess which token you meant. Re-send the call with "tokenAddress" only.'
      : '. Re-send the call with the token contract address under "tokenAddress".')
  );
}

export async function handleTokenCheck(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const retired = refuseRetiredTokenCheckAddress(args);
  if (retired) return fail(retired);

  const parsed = TokenCheckArgs.safeParse(args);
  if (!parsed.success) {
    return fail(`TokenCheck: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }
  const { chain, tokenAddress } = parsed.data;
  return executeProtocolTool(
    { toolId: "kyberswap.tokens.check", params: { chain, tokenAddress } },
    protocolContext(context),
  );
}

// ── BridgeStatus — order get (by id) / orders list ──────────────────

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
    return fail(`BridgeStatus: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }
  const a = parsed.data;

  // Mode conflict is REJECTED BY NAME, never resolved silently — see
  // `../protocols/khalani/bridge-status-mode.ts`.
  const conflict = rejectBridgeStatusModeConflict(a);
  if (conflict !== null) return fail(conflict);

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

// ── BridgeQuote — read-only cross-chain bridge preview ──────────────

const BridgeQuoteArgs = z.object({
  fromChain: z.string().min(1, { message: "fromChain is required" }),
  fromToken: z.string().min(1, { message: "fromToken is required" }),
  toChain: z.string().min(1, { message: "toChain is required" }),
  toToken: z.string().min(1, { message: "toToken is required" }),
  amountRaw: z.string().min(1, { message: "amountRaw is required (raw base units)" }),
  tradeType: z.string().min(1).optional(),
  fromAddress: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  // No `refundTo` — the refund destination is derived from the selected
  // source wallet, never taken from tool input (refund-destination policy in
  // `@tools/khalani/request.js`).
  filler: z.string().min(1).optional(),
  // Relay-only price protection, in basis points (1 bps = 0.01%). REJECTED by
  // name on the Khalani branch — Khalani exposes no slippage tolerance.
  slippageBps: z.number().int().nonnegative().optional(),
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
  //
  // ORDER IS LOAD-BEARING: this runs BEFORE the empty-value normalization
  // below. Normalization exists to stop `recipient: ""` costing the agent a
  // turn — but applied first it would also delete `refundTo: ""`, converting an
  // attempted refund redirection into silence. The refusal comes first so the
  // key is always answered BY NAME.
  const forbiddenParam = findCallerSuppliedForbiddenParamOrDestinationKey(args);
  if (forbiddenParam !== null) {
    return fail(
      `BridgeQuote: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  // `slippageBps` is REJECTED BY NAME whenever this call routes to Khalani
  // (SPEC §2.4 item 21). It used to be dropped in silence, which told the agent
  // it had bought price protection Khalani never offered.
  const khalaniSlippage = await khalaniSlippageRejection("BridgeQuote", args);
  if (khalaniSlippage !== null) return fail(khalaniSlippage);

  const parsed = BridgeQuoteArgs.safeParse(dropEmptyModelValues(args));
  if (!parsed.success) {
    return fail(`BridgeQuote: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }
  const a = parsed.data;

  // Route the quote to the SAME venue the `bridge` execute alias uses (Khalani
  // when its live registry serves BOTH sides, else Relay), so the venue-bound
  // bridge prequote gate collides between the quote and the execute.
  const venue = await resolveBridgeVenue(a.fromChain, a.toChain);
  if (venue.venue === null) return fail(`BridgeQuote: ${venue.refusal}`);
  if (venue.venue === "relay") {
    const params: Record<string, unknown> = {
      fromChain: a.fromChain,
      fromToken: a.fromToken,
      toChain: a.toChain,
      toToken: a.toToken,
      amountRaw: a.amountRaw,
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
    amountRaw: a.amountRaw,
  };
  if (a.tradeType !== undefined) params.tradeType = a.tradeType;
  if (a.fromAddress !== undefined) params.fromAddress = a.fromAddress;
  if (a.recipient !== undefined) params.recipient = a.recipient;
  if (a.filler !== undefined) params.filler = a.filler;
  return executeProtocolTool({ toolId: "khalani.quote.get", params }, protocolContext(context));
}

// ── BridgeQuoteRelay — Relay-only bridge preview ──────────────────────────
//
// The read half of the Relay venue pair. Unlike the generic `BridgeQuote`
// (which stays Khalani-routed except the local-chain static exception), this
// alias ALWAYS targets `relay.quote.get`. Read-only: no approval, no gate
// beyond argument validation.

const BridgeQuoteRelayArgs = z.object({
  fromChain: z.string().min(1, { message: "fromChain is required" }),
  fromToken: z.string().min(1, { message: "fromToken is required" }),
  toChain: z.string().min(1, { message: "toChain is required" }),
  toToken: z.string().min(1, { message: "toToken is required" }),
  amountRaw: z.string().min(1, { message: "amountRaw is required (raw base units)" }),
  tradeType: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  // No `refundTo` — the refund destination is derived from the selected
  // source wallet, never taken from tool input (refund-destination policy in
  // `@tools/khalani/request.js`).
  // Relay-only price protection, in basis points (1 bps = 0.01%). REJECTED by
  // name on the Khalani branch — Khalani exposes no slippage tolerance.
  slippageBps: z.number().int().nonnegative().optional(),
});

export async function handleBridgeQuoteRelay(
  args: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  // This schema is not `.strict()` either, so the same by-name refusal applies
  // — otherwise a redirected refund address would be dropped here in silence.
  // Same load-bearing order as `BridgeQuote`: refusal BEFORE normalization.
  const forbiddenParam = findCallerSuppliedForbiddenParamOrDestinationKey(args);
  if (forbiddenParam !== null) {
    return fail(
      `BridgeQuoteRelay: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  const parsed = BridgeQuoteRelayArgs.safeParse(dropEmptyModelValues(args));
  if (!parsed.success) {
    return fail(`BridgeQuoteRelay: ${formatZodIssuesForModel(parsed.error.issues, args)}`);
  }
  const a = parsed.data;

  const params: Record<string, unknown> = {
    fromChain: a.fromChain,
    fromToken: a.fromToken,
    toChain: a.toChain,
    toToken: a.toToken,
    amountRaw: a.amountRaw,
  };
  if (a.tradeType !== undefined) params.tradeType = a.tradeType;
  if (a.recipient !== undefined) params.recipient = a.recipient;
  if (a.slippageBps !== undefined) params.slippageBps = a.slippageBps;
  return executeProtocolTool({ toolId: "relay.quote.get", params }, protocolContext(context));
}
