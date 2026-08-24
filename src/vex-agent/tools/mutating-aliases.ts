/**
 * Mutating protocol-alias routers (Stage 8b; Agent Scan plan §4.2/§11.2
 * rewired the swap pair).
 *
 * A MUTATING action-named alias (`SwapExecute`, `SwapExecuteUniswap`,
 * `BridgeExecute`) resolves to a TARGET protocol toolId + translated params, then is
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
 *   - classifies the swap family (shared with the read-only `SwapQuote` alias
 *     via `classifySwapFamily` so quote and execute can never disagree),
 *   - translates to the target's EXACT param names,
 *   - THROWS `MutatingAliasRouteError` on an un-routable request (unknown
 *     family, chain not usable on this venue, invalid args). The dispatcher
 *     turns the throw into a bounded failure
 *     ToolResult — it never dispatches a guessed target.
 *
 * `side` / `recipient` are REMOVED from the unified contract (plan §11.2) — no
 * lot-direction/PnL tracking survives Agent Scan, and wallet-delta receipt
 * decoding is the truth invariant for the output leg.
 *
 * The two swap executes take their `chain` from the SAME schema as the quotes
 * (`./internal/chain-param.js`): a slug, a digit string, or a JSON number, all
 * normalized to one trimmed string. Quote and execute must accept the same
 * forms — an execute that refuses what its own quote accepted is a dead end the
 * model cannot reason its way out of. The bridge routers are deliberately
 * excluded (their chain names belong to the Khalani/Relay namespaces and feed
 * the bridge prequote match-hash).
 *
 * Units: `amountIn` is the HUMAN decimal of `tokenIn` (e.g. "1.5"), matching
 * the kyber/uniswap/jupiter `amountIn` string — translation preserves the
 * value, it does not convert units.
 */

import { z } from "zod";

import { ChainParam } from "./internal/chain-param.js";
import { classifySwapFamily, isEvmSwapTokenInput } from "./internal/swap-family.js";
import { isNumericChainIdInput } from "@tools/kyberswap/chains.js";
import { resolveBridgeVenue } from "@tools/relay/bridge-venue.js";
import { findCallerSuppliedForbiddenParam } from "@tools/khalani/request.js";
import { khalaniSlippageRejection } from "./protocols/khalani/slippage-unsupported.js";
import { resolveUniswapDeployment } from "@tools/uniswap/chains.js";

/** A resolved target for a mutating protocol-alias. */
export interface ResolvedAliasTarget {
  readonly toolId: string;
  readonly params: Record<string, unknown>;
}

/**
 * Thrown by a router when the alias cannot be routed to a concrete target
 * (unknown family, chain not usable on this venue, invalid args). Carries a
 * bounded, agent-facing message — never raw
 * provider/DB text. The dispatcher returns it as a failed ToolResult; the
 * predicate `dispatchTargetIsMutating` swallows it and falls back to the
 * registry mutating flag (the throw is a validation signal, not a side-effect
 * classification signal).
 */
export class MutatingAliasRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutatingAliasRouteError";
  }
}

/**
 * Router signature: validated-or-raw args + the calling session id → resolved
 * target, or throw. `sessionId` is `undefined` for the classification-only
 * call site (`dispatcher/mutating-targets.ts`). No router requires session scope
 * any more (owner decision D4 retired the venue reveals), so the parameter is
 * retained only for the signature's stability across routers.
 */
export type MutatingAliasRouter = (
  args: Record<string, unknown>,
  sessionId: string | undefined,
) => ResolvedAliasTarget | Promise<ResolvedAliasTarget>;

// ── SwapExecute — EVM (KyberSwap ONLY) / Solana (Jupiter execute) router ──

/**
 * `SwapExecute` alias args. `side` / `recipient` are REMOVED (plan §11.2 — no
 * lot-direction tracking survives, and the Jupiter execute manifest never had
 * a recipient param either). `amountIn` is a HUMAN decimal string for both
 * families.
 */
// `.strict()` (FIX-SPINE round 1, finding 14/C4) — the removed legacy
// `side`/`recipient`/`amount` fields are REJECTED with a clear message, never
// silently stripped. Silently dropping `recipient` in particular would be a
// transaction-safety-significant silent behavior change.
const SwapArgs = z.object({
  // The SAME schema the quote half uses (`internal/chain-param.ts`): a slug, a
  // digit string, or a JSON number. Anything narrower here would refuse the
  // execute of a quote this alias pair already accepted.
  chain: ChainParam,
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapArgs = z.infer<typeof SwapArgs>;

/**
 * Resolve the `SwapExecute` alias to a concrete swap EXECUTE toolId +
 * translated params. EVM → `kyberswap.swap.execute` ONLY (plan §11.2 — the
 * silent Uniswap fallback is removed); Solana → `solana.swap.execute`
 * (unchanged). Throws `MutatingAliasRouteError` on invalid args or an unknown
 * family; when the chain has NO KyberSwap aggregator support at all it throws a
 * message naming `SwapExecuteUniswap` as the venue that does cover it.
 */
function routeSwap(args: Record<string, unknown>): ResolvedAliasTarget {
  const parsed = SwapArgs.safeParse(args);
  if (!parsed.success) {
    // Prefix each issue with its field path so a missing required field names
    // the offending key (Zod's default "expected string, received undefined"
    // message omits it).
    throw new MutatingAliasRouteError(
      `SwapExecute: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: SwapArgs = parsed.data;

  const family = classifySwapFamily(a.chain);
  if (family.kind === "unknown") {
    // A chain ID is refused AS an id — same branch and same wording as the
    // quote half (`internal/action-aliases.ts`). It came from TokenFind, so
    // "cannot determine swap family" would read as a lookup mistake rather than
    // the truth: no venue in the tree serves that chain. This runs BEFORE the
    // venue branch below on purpose — pointing at the Uniswap venue would claim
    // it covers a chain nothing registers.
    if (isNumericChainIdInput(a.chain)) {
      throw new MutatingAliasRouteError(
        `SwapExecute: chain id ${a.chain} is not a chain Vex can swap on. ` +
          `Pass a supported EVM chain — either its slug or the chain id TokenFind ` +
          `returns (ethereum/1, base/8453, arbitrum/42161, …) — or "solana".`,
      );
    }
    throw new MutatingAliasRouteError(
      `SwapExecute: cannot determine swap family for chain "${a.chain}". ` +
        `Use a supported EVM chain (e.g. ethereum, base, arbitrum) or "solana".`,
    );
  }

  if (family.kind === "solana") {
    // W5a: the Jupiter execute manifest now uses the SAME keys as the alias
    // (tokenIn/tokenOut/amountIn, human decimal STRING) — pass them through
    // rather than round-tripping the amount through a float.
    const params: Record<string, unknown> = {
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amountIn: a.amountIn,
      ...(a.slippageBps !== undefined ? { slippageBps: a.slippageBps } : {}),
    };
    return { toolId: "solana.swap.execute", params };
  }

  // EVM tokens MUST be a contract address or native — the execute handler
  // resolves strictly (resolveTokenMetadataStrict), so a bare symbol would only
  // fail deeper inside with a less-clear error. Reject it EARLY with the same
  // doctrine message the quote alias uses (symmetry: a symbol is never DEX-
  // resolved on the EVM path; use TokenFind first).
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    throw new MutatingAliasRouteError(
      "SwapExecute: EVM tokens must be a contract address — resolve the symbol with " +
        "TokenFind first, or pass native ETH/native.",
    );
  }

  // `family.venue === "uniswap"` means the venue classifier found NO KyberSwap
  // aggregator support for this chain at all. Name the alternative venue rather
  // than only the refusal: it is always callable, so this is actionable now.
  if (family.venue === "uniswap") {
    throw new MutatingAliasRouteError(
      `SwapExecute: KyberSwap does not support chain "${a.chain}". ` +
        `Use SwapExecuteUniswap for this chain — quote it with SwapQuoteUniswap first.`,
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

// ── SwapExecuteUniswap — HIDDEN EVM-only Uniswap fallback execute ────────

const SwapExecuteUniswapArgs = z.object({
  // Same shared schema as `SwapQuoteUniswap` — see `SwapArgs` above.
  chain: ChainParam,
  tokenIn: z.string().min(1, { message: "tokenIn is required" }),
  tokenOut: z.string().min(1, { message: "tokenOut is required" }),
  amountIn: z.string().min(1, { message: "amountIn is required (human decimal string)" }),
  slippageBps: z.number().int().nonnegative().optional(),
}).strict();

type SwapExecuteUniswapArgs = z.infer<typeof SwapExecuteUniswapArgs>;

/**
 * Resolve the `SwapExecuteUniswap` alias. Resolves DIRECTLY against the Uniswap
 * deployment registry, NOT `classifySwapFamily` — that would prioritize
 * KyberSwap on a chain it ALSO covers, and the whole point of naming the venue
 * in the tool is to reach Uniswap even there.
 */
function routeSwapExecuteUniswap(
  args: Record<string, unknown>,
  sessionId: string | undefined,
): ResolvedAliasTarget {
  const parsed = SwapExecuteUniswapArgs.safeParse(args);
  if (!parsed.success) {
    throw new MutatingAliasRouteError(
      `SwapExecuteUniswap: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: SwapExecuteUniswapArgs = parsed.data;

  const deployment = resolveUniswapDeployment(a.chain);
  if (!deployment) {
    throw new MutatingAliasRouteError(`SwapExecuteUniswap: "${a.chain}" has no verified Uniswap deployment.`);
  }
  if (!isEvmSwapTokenInput(a.tokenIn) || !isEvmSwapTokenInput(a.tokenOut)) {
    throw new MutatingAliasRouteError(
      "SwapExecuteUniswap: EVM tokens must be a contract address — resolve the symbol with "
        + "TokenFind first, or pass native ETH/native.",
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

// ── BridgeExecute — Khalani cross-chain bridge EXECUTE router ─────────────────────

/**
 * `BridgeExecute` alias args. Mirrors the read-only `BridgeQuote` shape (Stage 8a) so
 * the agent presents ONE bridge surface: preview with `BridgeQuote`, execute
 * with `BridgeExecute`. Translation is a pass-through to `khalani.bridge`'s EXACT param
 * keys (verified against the khalani manifest:
 * fromChain/fromToken/toChain/toToken/amountRaw + the optional overrides). `dryRun`
 * is intentionally NOT accepted — the alias is the real broadcast; a dry run is
 * reached by calling the Khalani bridge tool directly with `dryRun: true`.
 * The EXECUTE-ONLY `routeId`/`depositMethod` knobs are ALSO not accepted (8c
 * security fix): the quote can never bind them, so the bridge auto-selects the
 * best route and the execute gate fail-closes them on the direct path.
 *
 * `referrer`/`referrerFeeBps` are likewise not accepted: they set a referral fee
 * deducted from the bridged output and paid to an arbitrary address, and Vex
 * never derives a fee from model params. `routeBridge` rejects them by name
 * before parsing. See the policy in `@tools/khalani/request.js`.
 *
 * Units: `amountRaw` is in RAW base units (wei/lamports), matching the khalani
 * bridge manifest — translation preserves the value, it does not convert.
 */
// `routeId` / `depositMethod` are deliberately ABSENT (8c security fix). They are
// EXECUTE-ONLY khalani.bridge knobs with NO counterpart in the bridge quote, so
// they can never be bound to a quote — the bridge auto-selects the best route.
// `.strict()` REJECTS them (and any other unknown key) at the alias boundary so
// the agent cannot smuggle them through the menu; the execute gate independently
// fail-closes them on the direct protocol-call path.
const BridgeArgs = z
  .object({
    fromChain: z.string().min(1, { message: "fromChain is required" }),
    fromToken: z.string().min(1, { message: "fromToken is required" }),
    toChain: z.string().min(1, { message: "toChain is required" }),
    toToken: z.string().min(1, { message: "toToken is required" }),
    amountRaw: z.string().min(1, { message: "amountRaw is required (raw base units)" }),
    tradeType: z.string().min(1).optional(),
    fromAddress: z.string().min(1).optional(),
    recipient: z.string().min(1).optional(),
    filler: z.string().min(1).optional(),
    // Relay-only price protection, in basis points (1 bps = 0.01%). REJECTED by
    // name on the Khalani branch — Khalani exposes no slippage tolerance.
    slippageBps: z.number().int().nonnegative().optional(),
  })
  .strict();

type BridgeArgs = z.infer<typeof BridgeArgs>;

/**
 * Resolve the `BridgeExecute` alias to `khalani.bridge` OR `relay.bridge` + translated
 * params, per the bridge VENUE ROUTER (Khalani when its LIVE chain registry
 * serves both sides, else Relay - the chain-aware default fallback). Throws
 * `MutatingAliasRouteError` on invalid args or when no venue can be named
 * honestly. The dedicated dispatcher branch routes the result through
 * `executeProtocolTool`, which runs the bridge prequote gate (kind 'bridge',
 * venue-bound) → approval gate → capture.
 *
 * ASYNC because the venue now depends on the live Khalani chain registry
 * (24h-cached). It is the only async router; the classification-only call site
 * (`dispatcher/mutating-targets.ts`) cannot await and falls back to the alias's
 * conservative registry flag, which is the same answer either target would give.
 */
async function routeBridge(args: Record<string, unknown>): Promise<ResolvedAliasTarget> {
  // Fee params and the refund destination are rejected BY NAME before anything
  // else, so an attempted overcharge or refund redirection reads as an explicit
  // refusal rather than a generic unknown-key error. `.strict()` below would
  // also reject them, but not legibly — and a silent drop would hide the
  // attempt entirely.
  const forbiddenParam = findCallerSuppliedForbiddenParam(args);
  if (forbiddenParam !== null) {
    throw new MutatingAliasRouteError(
      `BridgeExecute: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  // `slippageBps` is REJECTED BY NAME whenever this call routes to Khalani
  // (SPEC §2.4 item 21). It used to be dropped in silence, which told the agent
  // it had bought price protection Khalani never offered.
  const khalaniSlippage = await khalaniSlippageRejection("BridgeExecute", args);
  if (khalaniSlippage !== null) throw new MutatingAliasRouteError(khalaniSlippage);

  const parsed = BridgeArgs.safeParse(args);
  if (!parsed.success) {
    throw new MutatingAliasRouteError(
      `BridgeExecute: ${parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")}`,
    );
  }
  const a: BridgeArgs = parsed.data;

  const venue = await resolveBridgeVenue(a.fromChain, a.toChain);
  if (venue.venue === null) throw new MutatingAliasRouteError(`BridgeExecute: ${venue.refusal}`);
  if (venue.venue === "relay") {
    // Relay params — no referrer/fee/filler/fromAddress surface (Khalani-only).
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
    return { toolId: "relay.bridge", params };
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
  // routeId / depositMethod are NOT forwarded — they are absent from BridgeArgs
  // (.strict() rejects them). See the BridgeArgs schema note (8c security fix).
  return { toolId: "khalani.bridge", params };
}

// ── BridgeExecuteRelay — Relay-only bridge EXECUTE ────────────────────────

/**
 * `BridgeExecuteRelay` alias args — the Relay subset of the bridge contract
 * (no referrer/fee/filler/fromAddress surface; those are Khalani-only). Mirrors
 * the Relay branch of the generic `BridgeExecute` router so quote↔execute currencies
 * and chains collide on the venue-bound prequote identity.
 */
const BridgeExecuteRelayArgs = z
  .object({
    fromChain: z.string().min(1, { message: "fromChain is required" }),
    fromToken: z.string().min(1, { message: "fromToken is required" }),
    toChain: z.string().min(1, { message: "toChain is required" }),
    toToken: z.string().min(1, { message: "toToken is required" }),
    amountRaw: z.string().min(1, { message: "amountRaw is required (raw base units)" }),
    tradeType: z.string().min(1).optional(),
    recipient: z.string().min(1).optional(),
    // No `refundTo` — the refund destination is derived from the selected
    // source wallet on both venues (refund-destination policy in
    // `@tools/khalani/request.js`).
    slippageBps: z.number().int().nonnegative().optional(),
  })
  .strict();

type BridgeExecuteRelayArgs = z.infer<typeof BridgeExecuteRelayArgs>;

/**
 * Resolve the `BridgeExecuteRelay` alias to `relay.bridge` + translated params.
 * ALWAYS targets Relay (the generic `BridgeExecute` router stays Khalani-routed
 * except its local-chain exception). Authorization is the prequote gate plus the
 * approval gate inside `executeProtocolTool`, exactly as for every other
 * fund-moving alias.
 */
function routeBridgeExecuteRelay(
  args: Record<string, unknown>,
  sessionId: string | undefined,
): ResolvedAliasTarget {

  // Same by-name refusal as the generic `BridgeExecute` router: `.strict()` below
  // would reject these too, but as an opaque unknown-key error that reads like
  // a typo rather than like a blocked redirection attempt.
  const forbiddenParam = findCallerSuppliedForbiddenParam(args);
  if (forbiddenParam !== null) {
    throw new MutatingAliasRouteError(
      `BridgeExecuteRelay: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    );
  }

  const parsed = BridgeExecuteRelayArgs.safeParse(args);
  if (!parsed.success) {
    throw new MutatingAliasRouteError(
      `BridgeExecuteRelay: ${parsed.error.issues
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
    amountRaw: a.amountRaw,
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
  SwapExecute: routeSwap,
  SwapExecuteUniswap: routeSwapExecuteUniswap,
  BridgeExecute: routeBridge,
  BridgeExecuteRelay: routeBridgeExecuteRelay,
};

/** True iff `name` is a registered mutating protocol-alias (dedicated dispatch). */
export function isMutatingProtocolAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MUTATING_PROTOCOL_ALIAS_ROUTERS, name);
}
