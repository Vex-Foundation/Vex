/**
 * Mutating protocol-alias routers (Stage 8b; Agent Scan plan §4.2/§11.2
 * rewired the swap pair).
 *
 * A MUTATING action-named alias (`swap_execute`, `swap_execute_uniswap`,
 * `bridge`) resolves to a TARGET protocol toolId + translated params, then is
 * dispatched DIRECTLY through `executeProtocolTool` by the dispatcher's
 * dedicated branch. This is the whole point of the dedicated path: a mutating
 * alias must NOT travel through the dispatcher's internal mutating-approval
 * gate (`routeInternalTool`), because that gate would enqueue approval BEFORE
 * `executeProtocolTool`'s Stage-7 prequote gate runs. `executeProtocolTool` is
 * the single chokepoint and SOLELY owns the ordering: prequote gate → approval
 * gate → capture.
 *
 * Each router:
 *   - validates the (untrusted) alias args with Zod at the boundary,
 *   - classifies the swap family (shared with the read-only `swap_quote` alias
 *     via `classifySwapFamily` so quote and execute can never disagree),
 *   - translates to the target's EXACT param names,
 *   - THROWS `MutatingAliasRouteError` on an un-routable request (unknown
 *     family, chain not usable on this venue, a hidden pair not yet revealed
 *     for the session). The dispatcher turns the throw into a bounded failure
 *     ToolResult — it never dispatches a guessed target.
 *
 * `side` / `recipient` are REMOVED from the unified contract (plan §11.2) — no
 * lot-direction/PnL tracking survives Agent Scan, and wallet-delta receipt
 * decoding is the truth invariant for the output leg.
 *
 * Units: `amountIn` is the HUMAN decimal of `tokenIn` (e.g. "1.5"), matching
 * the kyber/uniswap `amountIn` string and the Jupiter `amount` number —
 * translation preserves the value, it does not convert units.
 */

import { z } from "zod";

import { classifySwapFamily, isEvmSwapTokenInput } from "./internal/swap-family.js";
import { resolveBridgeVenue } from "@tools/relay/bridge-venue.js";
import { findCallerSuppliedForbiddenParam } from "@tools/khalani/request.js";
import { isUniswapPairRevealed } from "./registry/uniswap-reveal.js";
import { evaluateRelayRevealGate } from "./registry/relay-reveal.js";
import { resolveUniswapDeployment } from "@tools/uniswap/chains.js";

/** A resolved target for a mutating protocol-alias. */
export interface ResolvedAliasTarget {
  readonly toolId: string;
  readonly params: Record<string, unknown>;
}

/**
 * Thrown by a router when the alias cannot be routed to a concrete target
 * (unknown family, chain not usable on this venue, invalid args, hidden pair
 * not yet revealed). Carries a bounded, agent-facing message — never raw
 * provider/DB text. The dispatcher returns it as a failed ToolResult; the
 * predicate `dispatchTargetIsMutating` swallows it and falls back to the
 * registry mutating flag (the throw is a validation signal, not a side-effect
 * classification signal).
 *
 * `revealEligible` marks the ONE case a router can determine synchronously,
 * pre-call, that the hidden Uniswap pair should now be revealed for the
 * session (`swap_execute`'s "chain has no KyberSwap support at all" case,
 * plan §11.2). The dispatcher's dedicated branch checks this flag (it has
 * `context.sessionId`, which a pure router does not) and calls
 * `revealUniswapPair` before surfacing the failure.
 */
export class MutatingAliasRouteError extends Error {
  readonly revealEligible: boolean;
  constructor(message: string, options?: { readonly revealEligible?: boolean }) {
    super(message);
    this.name = "MutatingAliasRouteError";
    this.revealEligible = options?.revealEligible ?? false;
  }
}

/**
 * Router signature: validated-or-raw args + the calling session id → resolved
 * target, or throw. `sessionId` is `undefined` for the classification-only
 * call site (`dispatcher/mutating-targets.ts`) — a router that NEEDS session
 * scope (the hidden Uniswap pair) then always throws for that call, which
 * correctly falls back to the registry's static `mutating` flag there.
 */
export type MutatingAliasRouter = (
  args: Record<string, unknown>,
  sessionId: string | undefined,
) => ResolvedAliasTarget;

// ── swap_execute — EVM (KyberSwap ONLY) / Solana (Jupiter execute) router ──

/**
 * `swap_execute` alias args. `side` / `recipient` are REMOVED (plan §11.2 — no
 * lot-direction tracking survives, and the Jupiter execute manifest never had
 * a recipient param either). `amountIn` is a HUMAN decimal string for both
 * families.
 */
// `.strict()` (FIX-SPINE round 1, finding 14/C4) — the removed legacy
// `side`/`recipient`/`amount` fields are REJECTED with a clear message, never
// silently stripped. Silently dropping `recipient` in particular would be a
// transaction-safety-significant silent behavior change.
const SwapArgs = z.object({
  chain: z.string().min(1, { message: "chain is required" }),
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapArgs = z.infer<typeof SwapArgs>;

/**
 * Resolve the `swap_execute` alias to a concrete swap EXECUTE toolId +
 * translated params. EVM → `kyberswap.swap.execute` ONLY (plan §11.2 — the
 * silent Uniswap fallback is removed); Solana → `solana.swap.execute`
 * (unchanged). Throws `MutatingAliasRouteError` on invalid args or an unknown
 * family; throws with `revealEligible: true` when the chain has NO KyberSwap
 * aggregator support at all (the "local chain-not-Kyber-supported,
 * registry gate, pre-call" reveal case, plan §11.2) — the dispatcher's
 * dedicated branch reveals the hidden Uniswap pair for the session on that flag.
 */
function routeSwap(args: Record<string, unknown>): ResolvedAliasTarget {
  const parsed = SwapArgs.safeParse(args);
  if (!parsed.success) {
    // Prefix each issue with its field path so a missing required field names
    // the offending key (Zod's default "expected string, received undefined"
    // message omits it).
    throw new MutatingAliasRouteError(
      `swap_execute: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: SwapArgs = parsed.data;

  const family = classifySwapFamily(a.chain);
  if (family.kind === "unknown") {
    throw new MutatingAliasRouteError(
      `swap_execute: cannot determine swap family for chain "${a.chain}". ` +
        `Use a supported EVM chain (e.g. ethereum, base, arbitrum) or "solana".`,
    );
  }

  if (family.kind === "solana") {
    // Jupiter execute manifest types `amount` as a NUMBER (human decimal).
    const amount = Number(a.amountIn);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new MutatingAliasRouteError(`swap_execute: amountIn "${a.amountIn}" is not a positive number.`);
    }
    const params: Record<string, unknown> = {
      inputToken: a.tokenIn,
      outputToken: a.tokenOut,
      amount,
      ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
    };
    return { toolId: "solana.swap.execute", params };
  }

  // EVM tokens MUST be a contract address or native — the execute handler
  // resolves strictly (resolveTokenMetadataStrict), so a bare symbol would only
  // fail deeper inside with a less-clear error. Reject it EARLY with the same
  // doctrine message the quote alias uses (symmetry: a symbol is never DEX-
  // resolved on the EVM path; use token_find first).
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    throw new MutatingAliasRouteError(
      "swap_execute: EVM tokens must be a contract address — resolve the symbol with " +
        "token_find first, or pass native ETH/native.",
    );
  }

  // `family.venue === "uniswap"` means the venue classifier found NO KyberSwap
  // aggregator support for this chain at all — reveal-eligible pre-call gate.
  if (family.venue === "uniswap") {
    throw new MutatingAliasRouteError(
      `swap_execute: KyberSwap does not support chain "${a.chain}". ` +
        `swap_execute_uniswap is now available for this session as a fallback (Uniswap venue) — ` +
        `call swap_quote_uniswap first.`,
      { revealEligible: true },
    );
  }

  const params: Record<string, unknown> = {
    chain: family.chain,
    tokenIn: a.tokenIn,
    tokenOut: a.tokenOut,
    amountIn: a.amountIn,
    ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
  };
  return { toolId: "kyberswap.swap.execute", params };
}

// ── swap_execute_uniswap — HIDDEN EVM-only Uniswap fallback execute ────────

const SwapExecuteUniswapArgs = z.object({
  chain: z.string().min(1, { message: "chain is required" }),
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapExecuteUniswapArgs = z.infer<typeof SwapExecuteUniswapArgs>;

/**
 * Resolve the hidden `swap_execute_uniswap` alias. Dispatch-side hard rule
 * (plan §11.2): THROWS when the session has no active reveal, independent of
 * whatever the tool list showed the model. Resolves DIRECTLY against the
 * Uniswap deployment registry (not `classifySwapFamily`, which would
 * prioritize KyberSwap on a chain it ALSO covers — the whole point of this
 * fallback is to reach Uniswap even there).
 */
function routeSwapExecuteUniswap(
  args: Record<string, unknown>,
  sessionId: string | undefined,
): ResolvedAliasTarget {
  if (!isUniswapPairRevealed(sessionId)) {
    throw new MutatingAliasRouteError(
      "swap_execute_uniswap is not available yet for this session — it unlocks after an eligible "
        + "KyberSwap route-not-found failure at quote time, or the Kyber swap transaction reverting "
        + "on-chain at execute time (try swap_quote first).",
    );
  }

  const parsed = SwapExecuteUniswapArgs.safeParse(args);
  if (!parsed.success) {
    throw new MutatingAliasRouteError(
      `swap_execute_uniswap: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: SwapExecuteUniswapArgs = parsed.data;

  const deployment = resolveUniswapDeployment(a.chain);
  if (!deployment) {
    throw new MutatingAliasRouteError(`swap_execute_uniswap: "${a.chain}" has no verified Uniswap deployment.`);
  }
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    throw new MutatingAliasRouteError(
      "swap_execute_uniswap: EVM tokens must be a contract address — resolve the symbol with "
        + "token_find first, or pass native ETH/native.",
    );
  }

  const params: Record<string, unknown> = {
    chain: deployment.key,
    tokenIn: a.tokenIn,
    tokenOut: a.tokenOut,
    amountIn: a.amountIn,
    ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
  };
  return { toolId: "uniswap.swap.execute", params };
}

// ── bridge — Khalani cross-chain bridge EXECUTE router ─────────────────────

/**
 * `bridge` alias args. Mirrors the read-only `bridge_quote` shape (Stage 8a) so
 * the agent presents ONE bridge surface: preview with `bridge_quote`, execute
 * with `bridge`. Translation is a pass-through to `khalani.bridge`'s EXACT param
 * keys (verified against the khalani manifest:
 * fromChain/fromToken/toChain/toToken/amount + the optional overrides). `dryRun`
 * is intentionally NOT accepted — the alias is the real broadcast; a dry run is
 * reached via `execute_tool({ toolId:"khalani.bridge", params:{ dryRun:true }})`.
 * The EXECUTE-ONLY `routeId`/`depositMethod` knobs are ALSO not accepted (8c
 * security fix): the quote can never bind them, so the bridge auto-selects the
 * best route and the execute gate fail-closes them on the direct path.
 *
 * `referrer`/`referrerFeeBps` are likewise not accepted: they set a referral fee
 * deducted from the bridged output and paid to an arbitrary address, and Vex
 * never derives a fee from model params. `routeBridge` rejects them by name
 * before parsing. See the policy in `@tools/khalani/request.js`.
 *
 * Units: `amount` is in SMALLEST units (wei/lamports), matching the khalani
 * bridge manifest — translation preserves the value, it does not convert.
 */
// `routeId` / `depositMethod` are deliberately ABSENT (8c security fix). They are
// EXECUTE-ONLY khalani.bridge knobs with NO counterpart in the bridge quote, so
// they can never be bound to a quote — the bridge auto-selects the best route.
// `.strict()` REJECTS them (and any other unknown key) at the alias boundary so
// the agent cannot smuggle them through the menu; the execute gate independently
// fail-closes them on the direct execute_tool path.
const BridgeArgs = z
  .object({
    fromChain: z.string().min(1, { message: "fromChain is required" }),
    fromToken: z.string().min(1, { message: "fromToken is required" }),
    toChain: z.string().min(1, { message: "toChain is required" }),
    toToken: z.string().min(1, { message: "toToken is required" }),
    amount: z.string().min(1, { message: "amount is required (smallest units)" }),
    tradeType: z.string().min(1).optional(),
    fromAddress: z.string().min(1).optional(),
    recipient: z.string().min(1).optional(),
    filler: z.string().min(1).optional(),
    // Relay-only slippage (bps string). Ignored on the Khalani path.
    slippageBps: z.string().min(1).optional(),
  })
  .strict();

type BridgeArgs = z.infer<typeof BridgeArgs>;

/**
 * Resolve the `bridge` alias to `khalani.bridge` OR `relay.bridge` + translated
 * params, per the bridge VENUE ROUTER (Relay whenever either side is Robinhood
 * Chain, which Khalani doesn't cover; Khalani primary otherwise). Throws
 * `MutatingAliasRouteError` on invalid args. The dedicated dispatcher branch
 * routes the result through `executeProtocolTool`, which runs the bridge prequote
 * gate (kind 'bridge', venue-bound) → approval gate → capture.
 */
function routeBridge(args: Record<string, unknown>): ResolvedAliasTarget {
  // Fee params and the refund destination are rejected BY NAME before anything
  // else, so an attempted overcharge or refund redirection reads as an explicit
  // refusal rather than a generic unknown-key error. `.strict()` below would
  // also reject them, but not legibly — and a silent drop would hide the
  // attempt entirely.
  const forbiddenParam = findCallerSuppliedForbiddenParam(args);
  if (forbiddenParam !== null) {
    throw new MutatingAliasRouteError(
      `bridge: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  const parsed = BridgeArgs.safeParse(args);
  if (!parsed.success) {
    throw new MutatingAliasRouteError(
      `bridge: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: BridgeArgs = parsed.data;

  if (resolveBridgeVenue(a.fromChain, a.toChain) === "relay") {
    // Relay params — no referrer/fee/filler/fromAddress surface (Khalani-only).
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
    return { toolId: "relay.bridge", params };
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
  // routeId / depositMethod are NOT forwarded — they are absent from BridgeArgs
  // (.strict() rejects them). See the BridgeArgs schema note (8c security fix).
  return { toolId: "khalani.bridge", params };
}

// ── bridge_execute_relay — HIDDEN Relay-only bridge EXECUTE (route-bound reveal) ──

/**
 * `bridge_execute_relay` alias args — the Relay subset of the bridge contract
 * (no referrer/fee/filler/fromAddress surface; those are Khalani-only). Mirrors
 * the Relay branch of the generic `bridge` router so quote↔execute currencies
 * and chains collide on the venue-bound prequote identity.
 */
const BridgeExecuteRelayArgs = z
  .object({
    fromChain: z.string().min(1, { message: "fromChain is required" }),
    fromToken: z.string().min(1, { message: "fromToken is required" }),
    toChain: z.string().min(1, { message: "toChain is required" }),
    toToken: z.string().min(1, { message: "toToken is required" }),
    amount: z.string().min(1, { message: "amount is required (smallest units)" }),
    tradeType: z.string().min(1).optional(),
    recipient: z.string().min(1).optional(),
    // No `refundTo` — the refund destination is derived from the selected
    // source wallet on both venues (refund-destination policy in
    // `@tools/khalani/request.js`).
    slippageBps: z.string().min(1).optional(),
  })
  .strict();

type BridgeExecuteRelayArgs = z.infer<typeof BridgeExecuteRelayArgs>;

/**
 * Resolve the hidden `bridge_execute_relay` alias to `relay.bridge` + translated
 * params (bridge factory W5; plan R7/R8). ALWAYS targets Relay (the generic
 * `bridge` router stays Khalani-routed except its local-chain exception). The
 * ROUTE-BOUND reveal gate is checked here for an early, clean rejection (throws
 * `MutatingAliasRouteError` on deny); `executeProtocolTool`'s own gate on
 * `relay.bridge` is the un-bypassable backstop. Local (Robinhood) routes pass
 * via the always-allowed carve-out. `sessionId === undefined` (the
 * classification-only call site) makes the non-local branch throw, which
 * correctly falls back to the registry's static `mutating` flag there.
 */
function routeBridgeExecuteRelay(
  args: Record<string, unknown>,
  sessionId: string | undefined,
): ResolvedAliasTarget {
  if (evaluateRelayRevealGate(args, sessionId).decision === "deny") {
    throw new MutatingAliasRouteError(
      "bridge_execute_relay is not available for this route yet — it unlocks after an eligible "
        + "Khalani no-route failure for this exact route, or the Khalani deposit transaction reverting "
        + "on-chain for this exact route (Robinhood routes are always available via bridge). Preview "
        + "with bridge_quote_relay first.",
    );
  }

  // Same by-name refusal as the generic `bridge` router: `.strict()` below
  // would reject these too, but as an opaque unknown-key error that reads like
  // a typo rather than like a blocked redirection attempt.
  const forbiddenParam = findCallerSuppliedForbiddenParam(args);
  if (forbiddenParam !== null) {
    throw new MutatingAliasRouteError(
      `bridge_execute_relay: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  const parsed = BridgeExecuteRelayArgs.safeParse(args);
  if (!parsed.success) {
    throw new MutatingAliasRouteError(
      `bridge_execute_relay: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: BridgeExecuteRelayArgs = parsed.data;

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
  return { toolId: "relay.bridge", params };
}

// ── Registry ──────────────────────────────────────────────────────────────

/**
 * Registry of MUTATING protocol-alias routers, keyed by the alias tool name.
 * The dispatcher's dedicated branch uses these keys to recognise a mutating
 * alias and to resolve its TARGET toolId + params EARLY (so pressure-deny and
 * mission auto-retry-unsafe classification can use the target manifest).
 *
 * `registry-completeness.test.ts` reads these keys to (a) exclude the aliases
 * from the `INTERNAL_TOOL_LOADERS` symmetry check (they dispatch via the
 * dedicated branch, NOT a loader) and (b) assert each key is a registered
 * `kind: "internal"` ToolDef, so the exclusion can never hide an orphan.
 */
export const MUTATING_PROTOCOL_ALIAS_ROUTERS: Readonly<Record<string, MutatingAliasRouter>> = {
  swap_execute: routeSwap,
  swap_execute_uniswap: routeSwapExecuteUniswap,
  bridge: routeBridge,
  bridge_execute_relay: routeBridgeExecuteRelay,
};

/** True iff `name` is a registered mutating protocol-alias (dedicated dispatch). */
export function isMutatingProtocolAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MUTATING_PROTOCOL_ALIAS_ROUTERS, name);
}
