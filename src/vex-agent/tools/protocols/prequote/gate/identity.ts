/**
 * Execute-side identity extraction: turn validated EXECUTE params into the SAME
 * match-hash the recorder computed from the quote. Every un-gateable identity
 * throws (`GateIdentityError` / `VexError`) so the caller fails closed.
 */

import { isAddress } from "viem";

import type { ChainFamily } from "@tools/khalani/types.js";
import { isNativeTokenInput } from "@tools/kyberswap/helpers.js";
import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { requireJupiterResolvedToken } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolveUniswapChainId } from "@tools/uniswap/chains.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";
import { resolveLocalChainId } from "@tools/evm-chains/registry.js";
import { virtualsCurveDeployment } from "@tools/virtuals/curve/index.js";
import {
  canonicalizeJupiterFeeTail,
  resolveJupiterFeeSwapKnobs,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import type { PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { ExecuteGateRegistration } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import type { BridgeMatchInput } from "../identity/hash.js";
import { assertBridgeParamsBindable, buildBridgeIdentity } from "../identity/bridge.js";
import { buildRelayBridgeIdentity } from "../identity/relay-bridge.js";
import { buildPendleRedeemIdentity } from "../identity/pendle-redeem.js";
import { buildPendleMintIdentity, buildPendleRedeemPyIdentity } from "../identity/pendle-py.js";
import { buildPendleLpAddIdentity, buildPendleLpRemoveIdentity } from "../identity/pendle-lp.js";
import {
  buildMorphoLendDepositIdentity,
  buildMorphoLendWithdrawIdentity,
} from "../identity/morpho-lend.js";
import { buildMorphoBorrowIdentityFor } from "../identity/morpho-borrow.js";
import type { MorphoBorrowDirection } from "../identity/morpho-borrow.js";
import { GateIdentityError } from "../gate-errors.js";
import { canonSlippageBps, readParamSlippageBps } from "../slippage.js";

/**
 * The Morpho Blue market execute kinds, and the quote direction each pairs with.
 * A lookup rather than a fourth if/else limb: the four differ only in which
 * direction they name, and a missing entry must read as "not a borrow execute"
 * rather than as a default direction.
 */
const BORROW_DIRECTION_BY_KIND: Partial<Record<ExecuteGateRegistration["kind"], MorphoBorrowDirection>> = {
  lend_supply_collateral: "supplyCollateral",
  lend_withdraw_collateral: "withdrawCollateral",
  lend_borrow: "borrow",
  lend_repay: "repay",
};

/**
 * Swap execute trade identity for the match-hash. `chainId` is the numeric chain
 * id (null for Solana). `recipient`/`approveExact` are the Stage-9 money/safety
 * leg: the EVM builder reads them from the execute params (mirroring
 * `executeKyberSwap`'s `str(p,"recipient") || signer.address` and
 * `p.approveExact === true`); the Solana builder pins self/false (Jupiter has no
 * such params). `slippageBps` is bound separately in `computeGateMatch` (read
 * uniformly from the execute params for both families, matching the recorder).
 *
 * Etap 4: `approveExact` was REMOVED from the kyberswap swap/zap manifests
 * (approvals are now always exact - see `ensureKyberAllowance`), so the
 * dispatcher rejects it as an unknown param before this gate ever runs. The
 * field is kept in the identity (constant `false` in practice) to keep old
 * match-hashes stable and to document the doctrine; do NOT rely on it as a live
 * execute knob for kyberswap.
 */
interface GateIdentity {
  readonly family: PrequoteFamily;
  readonly chainId: number | null;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amount: string;
  /** Output recipient (execute param if non-empty, else the selected wallet). */
  readonly recipient: string;
  /** Allowance behavior - true iff the execute set `approveExact`. */
  readonly approveExact: boolean;
}

/**
 * Canonicalize one EVM execute-leg token to the identity the quote recorded:
 *   - native input ("ETH"/"native"/sentinel) → `NATIVE_TOKEN_ADDRESS` (the hash
 *     lowercases it; the quote recorded the same sentinel),
 *   - a hex address → used verbatim (the hash lowercases it),
 *   - a bare symbol → un-gateable at execute → BLOCK (Kyber execute is strict
 *     address-only anyway; the gate never network-resolves an EVM symbol).
 */
function evmLegIdentity(param: string): string {
  if (isNativeTokenInput(param)) return NATIVE_TOKEN_ADDRESS;
  if (isAddress(param)) return param;
  throw new GateIdentityError("unresolved_token");
}

/**
 * Build the EVM trade identity from validated execute params. Throws on a bare
 * symbol. `selectedWallet` is the resolved signer (output-to-self default).
 *
 * Stage 9: `recipient` mirrors `executeKyberSwap` - `str(p,"recipient")` if a
 * non-empty string, else the selected wallet (self). `approveExact` mirrors
 * `p.approveExact === true`; since Etap 4 removed it from the kyberswap manifests
 * the dispatcher rejects it upstream, so `params.approveExact` is undefined here
 * and this resolves to constant `false` for kyberswap (recorder pins `false`
 * too → they still collide). `recipient` still flows into the swap hash, so an
 * execute that redirects the output produces a different digest than the quote
 * (which defaulted self) → the gate blocks.
 */
function buildEvmIdentity(
  params: Record<string, unknown>,
  selectedWallet: string,
  provider: string,
): GateIdentity {
  const chainParam = typeof params.chain === "string" ? params.chain : "";
  // ── VIRTUALS BONDING CURVE ──
  //
  // Its params are `token` + `side`, not `tokenIn`/`tokenOut`: a curve has ONE
  // pair and the side decides which way round it is traded. The identity is
  // derived here exactly as the recorder's extractor derives it from the quote's
  // own answer, so a buy quote can never authorize a sell execute and the two
  // hash differently by construction.
  if (provider === "virtuals") return buildVirtualsIdentity(params, selectedWallet, chainParam);
  const tokenInParam = typeof params.tokenIn === "string" ? params.tokenIn : "";
  const tokenOutParam = typeof params.tokenOut === "string" ? params.tokenOut : "";
  const amount = typeof params.amountIn === "string" ? params.amountIn : "";
  // De-kyber-coupled chain resolution (LOCKED #4): uniswap-on-4663 (and any
  // uniswap chain) resolves via the uniswap registry (local + slug map, network-
  // free); kyber resolves byte-identically via its slug map. Both throw on an
  // unsupported chain → caught upstream → gate_error block (fail-closed).
  let chainId: number;
  if (provider === "uniswap") {
    const resolved = resolveUniswapChainId(chainParam);
    if (resolved === undefined) {
      throw new VexError(ErrorCodes.KYBER_UNSUPPORTED_CHAIN, `Uniswap unsupported chain: ${chainParam}`);
    }
    chainId = resolved;
  } else if (provider === "pendle") {
    // Pendle resolves via its own network-free 11-chain registry so the identity
    // is not coupled to another venue's chain map. Throws on an unsupported chain
    // → caught upstream → gate_error block (fail-closed).
    const resolved = resolvePendleChainId(chainParam);
    if (resolved === undefined) {
      throw new VexError(ErrorCodes.PENDLE_API_ERROR, `Pendle unsupported chain: ${chainParam}`);
    }
    chainId = resolved;
  } else if (provider === "trench") {
    // Trench Express is a LOCAL chain (Robinhood 4663), not a Kyber-supported
    // chain - resolve via the local registry (network-free). An omitted chain
    // defaults to robinhood, matching the recorder which reads chainId from the
    // quote output (always 4663). Throws → caught upstream → fail-closed block.
    const resolved = resolveLocalChainId(chainParam || "robinhood");
    if (resolved === undefined) {
      throw new VexError(ErrorCodes.TRENCH_INVALID_REQUEST, `Trench unsupported chain: ${chainParam}`);
    }
    chainId = resolved;
  } else {
    chainId = slugToChainId(resolveChainSlug(chainParam));
  }
  const recipientParam = typeof params.recipient === "string" ? params.recipient.trim() : "";
  return {
    family: "eip155",
    chainId,
    tokenIn: evmLegIdentity(tokenInParam),
    tokenOut: evmLegIdentity(tokenOutParam),
    amount,
    recipient: recipientParam !== "" ? recipientParam : selectedWallet,
    approveExact: params.approveExact === true,
  };
}

/**
 * The Virtuals curve identity: the fixed pair, oriented by `side`.
 *
 * A chain with no curve, an unparseable token, or a missing side is UN-GATEABLE
 * and throws, which the caller turns into a fail-closed block. It never falls
 * back to a default chain or a default side: both would let a caller choose its
 * own identity path, which is the one thing an identity builder may not allow.
 */
function buildVirtualsIdentity(
  params: Record<string, unknown>,
  selectedWallet: string,
  chainParam: string,
): GateIdentity {
  const deployment = virtualsCurveDeployment(chainParam.trim().toLowerCase());
  if (deployment === undefined) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      `Virtuals curve unsupported chain: ${chainParam}`,
    );
  }
  const token = typeof params.token === "string" ? params.token : "";
  if (!isAddress(token)) throw new GateIdentityError("unresolved_token");
  const side = params.side;
  if (side !== "buy" && side !== "sell") throw new GateIdentityError("unresolved_token");
  return {
    family: "eip155",
    chainId: deployment.chainId,
    tokenIn: side === "buy" ? deployment.virtual : token,
    tokenOut: side === "buy" ? token : deployment.virtual,
    amount: typeof params.amountIn === "string" ? params.amountIn : "",
    // A curve trade has no recipient parameter at all: BondingV5 credits
    // `msg.sender`, so the output can only ever reach the signing wallet.
    recipient: selectedWallet,
    approveExact: false,
  };
}

/**
 * Build the Solana trade identity. `tokenIn`/`tokenOut` are symbol-OR-mint
 * at execute; resolve BOTH to their mint with the SAME resolver
 * `solana.swap.execute` (`handlers/core.ts`) uses (`requireJupiterResolvedToken`,
 * which returns `.address` = mint) so the gate mint matches the recorded mint.
 * A resolve failure throws → caught upstream → gate_error block.
 *
 * Stage 9: Jupiter execute has no recipient/approveExact param - pin `recipient`
 * to the selected wallet (self) and `approveExact` to false, matching the
 * recorder's Solana constants. (If Jupiter ever gained such params, treat them
 * like EVM - read from the execute params here.)
 */
async function buildSolanaIdentity(
  params: Record<string, unknown>,
  selectedWallet: string,
): Promise<GateIdentity> {
  const inputParam = typeof params.tokenIn === "string" ? params.tokenIn : "";
  const outputParam = typeof params.tokenOut === "string" ? params.tokenOut : "";
  const [inToken, outToken] = await Promise.all([
    requireJupiterResolvedToken(inputParam),
    requireJupiterResolvedToken(outputParam),
  ]);
  return {
    family: "solana",
    chainId: null,
    tokenIn: inToken.address,
    tokenOut: outToken.address,
    // Same typeof guard as the EVM identity: a missing/wrong-typed `amountIn`
    // yields "" here, which cannot match the recorder's canonicalized value →
    // fail-closed BLOCK rather than a hash over "undefined".
    amount: typeof params.amountIn === "string" ? params.amountIn : "",
    recipient: selectedWallet,
    approveExact: false,
  };
}

/**
 * What a gated execute's identity computation yields: the hash the row is looked
 * up by, the family label for the logs, and - on the bridge lanes - the DERIVED
 * destination wallet that identity binds.
 *
 * The recipient is here because it is already computed and already bound into
 * the match hash, yet the approval card never showed it. It is
 * `resolveSelectedAddress(destinationFamily)`, never a parameter (`recipient` is
 * rejected by name at the alias), so surfacing it tells a person WHERE the funds
 * land without giving anything the model can state a way in.
 */
export interface GateMatch {
  readonly matchHash: string;
  readonly family: PrequoteFamily;
  readonly bridgeRecipient?: {
    readonly family: PrequoteFamily;
    readonly address: string;
  };
}

/** One shape for both bridge identity builders, so their exposure cannot drift. */
function bridgeMatch(identity: BridgeMatchInput): GateMatch {
  return {
    matchHash: computePrequoteMatchHash(identity),
    family: identity.sourceFamily,
    bridgeRecipient: { family: identity.destFamily, address: identity.recipient },
  };
}

/**
 * Compute the match-hash + the family label for a gated EXECUTE call. Swap
 * branches on EVM/Solana identity builders (sync EVM, async Solana resolve);
 * bridge uses the SHARED `buildBridgeIdentity` so its hash collides with the
 * recorder's. Throws a `GateIdentityError` / VexError on an un-gateable identity
 * (caught upstream → fail-closed block).
 */
export async function computeGateMatch(
  gated: ExecuteGateRegistration,
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<GateMatch> {
  if (gated.kind === "bridge") {
    // Relay has its OWN identity path (LOCKED #4) - no Khalani identity reuse and
    // no khalani-only unbindable params. Khalani fail-closes FIRST on execute-
    // only params the quote can never bind, before building the identity.
    if (gated.provider === "relay") {
      const identity = await buildRelayBridgeIdentity(sessionId, params, context);
      return bridgeMatch(identity);
    }
    assertBridgeParamsBindable(params);
    const identity = await buildBridgeIdentity(sessionId, params, context);
    return bridgeMatch(identity);
  }

  if (gated.kind === "redeem") {
    // Pendle PT redeem - its OWN identity path (G2#3). Resolves YT from the PT via
    // the SAME market lookup the recorder uses, so the digests collide. A resolve/
    // wallet-scope throw propagates → caught upstream → fail-closed block.
    const identity = await buildPendleRedeemIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "mint") {
    // Pendle PY mint - its OWN identity path (P4). Resolves the market (+ YT) from
    // the PT anchor via the SAME lookup the recorder uses, so the digests collide.
    const identity = await buildPendleMintIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "redeem_py") {
    // Pendle PRE-EXPIRY PY redeem - its OWN identity path (P4). Binds the output
    // token (default underlying) so a divergent output blocks.
    const identity = await buildPendleRedeemPyIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "lp_add") {
    // Pendle LP single-token add - its OWN identity path (P5). Binds the market
    // (validated against active markets) + input token + slippage, so a divergent
    // market/token/slippage blocks. The distinct kind makes an add unmixable from
    // a remove.
    const identity = await buildPendleLpAddIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "lp_remove") {
    // Pendle LP single-token remove - its OWN identity path (P5). Binds the output
    // token (default underlying) so a divergent output blocks.
    const identity = await buildPendleLpRemoveIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  if (gated.kind === "lend_deposit" || gated.kind === "lend_withdraw") {
    // TWO LANES UNDER ONE KIND. The VAULT lane (E3b-2) binds the vault address,
    // the raw asset amount and the approved slippage; the MARKET lane binds the
    // Blue market id instead, because supplying a loan asset into one market is
    // lending too and reuses the kind. The registration's `lane` is what says
    // which, and it must be read here rather than guessed from the params: a
    // gate that inferred the lane from which key happened to be present would
    // let a caller choose its own identity path.
    const identity = gated.lane === "market"
      ? buildMorphoBorrowIdentityFor(
        gated.kind === "lend_deposit" ? "supply" : "withdraw",
        sessionId,
        params,
        context,
      )
      : gated.kind === "lend_deposit"
        ? buildMorphoLendDepositIdentity(sessionId, params, context)
        : buildMorphoLendWithdrawIdentity(sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  const borrowDirection = BORROW_DIRECTION_BY_KIND[gated.kind];
  if (borrowDirection !== undefined) {
    // Morpho Blue market operations - their OWN identity path (E3c). Each binds
    // the market id, the chain, its own raw amount and the approved slippage,
    // and the kind itself carries the operation, so a collateral quote cannot
    // authorize a borrow execute on the same market for the same amount.
    const identity = buildMorphoBorrowIdentityFor(borrowDirection, sessionId, params, context);
    return { matchHash: computePrequoteMatchHash(identity), family: gated.family };
  }

  // Resolve the SELECTED address (never decrypts). A wallet-scope throw
  // propagates → caught upstream → gate_error block (never fabricate). It is
  // both the signer and the output-to-self recipient default.
  const walletAddress = resolveSelectedAddress(
    context.walletResolution,
    context.walletPolicy,
    gated.family as ChainFamily,
  );
  const identity =
    gated.family === "eip155"
      ? buildEvmIdentity(params, walletAddress, gated.provider)
      : await buildSolanaIdentity(params, walletAddress);
  // W5 (design §6 R4): Jupiter fee-bearing tail, read from the EXECUTE params
  // via the SAME canonicalization the recorder used on the quote params - a
  // fee/tip/DEX-filter/maxAccounts/wrap substitution between quote and
  // execute produces a different digest → BLOCK. "" for every other provider.
  const jupiterTail =
    gated.provider === "jupiter"
      ? canonicalizeJupiterFeeTail(resolveJupiterFeeSwapKnobs(params), identity.tokenIn)
      : undefined;
  const matchHash = computePrequoteMatchHash({
    kind: "swap",
    sessionId,
    family: gated.family,
    // Venue binding (LOCKED #4) - the execute provider must equal the quote's.
    provider: gated.provider,
    chainId: identity.chainId,
    walletAddress,
    tokenIn: identity.tokenIn,
    tokenOut: identity.tokenOut,
    amount: identity.amount,
    // Stage 9 money/safety leg - read from the EXECUTE params (recipient/
    // approveExact via the identity builder; slippageBps read uniformly here,
    // matching the recorder which reads the quote params).
    recipient: identity.recipient,
    approveExact: identity.approveExact,
    slippageBps: canonSlippageBps(readParamSlippageBps(params)),
    ...jupiterTail,
  });
  return { matchHash, family: gated.family };
}
