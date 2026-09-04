/**
 * Pendle LP (single-token add / remove) identity builders (P5).
 *
 * Both the `pendle.lp.quote` recorder and the `pendle.lp.add` / `pendle.lp.remove`
 * EXECUTE gates build IDENTICAL identities from the same params (`chain`,
 * `market`, `tokenIn`/`tokenOut`, `amountIn`, `slippageBps`) with
 * `provider: "pendle"` bound in, so their match-hashes collide. The market is the
 * LP anchor and is bound DIRECTLY (validated against the chain's active markets via
 * `resolveMarketByAddress`) - never resolved from a PT - so neither side
 * reimplements a mapping. Add and remove are DISTINCT kinds (`lp_add` /
 * `lp_remove`), so direction is structurally unmixable: an add quote can never
 * authorize a remove execute (and vice-versa).
 *
 * Any throw (missing field, unsupported chain, unresolved market) propagates: the
 * recorder treats it as a skip, the gate as a fail-closed BLOCK.
 */

import { getAddress } from "viem";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";
import { resolveMarketByAddress } from "../../pendle/market-lookup.js";
import { resolveExitMarketByAddress } from "../../pendle/matured-market-lookup.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { LpAddMatchInput, LpRemoveMatchInput } from "./hash.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";

function pStr(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Resolve + checksum an address param, or throw a bounded token error. */
function requireAddr(raw: string, label: string): string {
  try {
    return getAddress(raw);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, `Pendle ${label} is not a valid address.`);
  }
}

/**
 * Resolve the shared LP leg: chainId + the validated market (address +
 * underlying) + wallet.
 *
 * `maturity` is REQUIRED rather than defaulted, because the two directions sit
 * on opposite sides of the R5b matrix and a default would silently pick one:
 * `"active_only"` for an ADD (adding liquidity after expiry is impossible) and
 * `"allow_matured"` for a REMOVE (Pendle documents removal as callable
 * regardless of expiry, and an identity that cannot be built for a matured
 * market would block the exit at the gate).
 */
async function resolveLpLeg(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  maturity: "active_only" | "allow_matured",
) {
  const marketRaw = pStr(params, "market");
  const amount = pStr(params, "amountIn");
  if (!marketRaw || !amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Pendle LP identity missing market/amount.");
  }
  const chainId = resolvePendleChainId(pStr(params, "chain"));
  if (chainId === undefined) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, "Pendle LP identity on an unsupported chain.");
  }
  const marketAddress = requireAddr(marketRaw, "LP market");
  const market = maturity === "allow_matured"
    ? (await resolveExitMarketByAddress(chainId, marketAddress))?.market ?? null
    : await resolveMarketByAddress(chainId, marketAddress);
  if (!market || !market.address) {
    throw new VexError(
      ErrorCodes.PENDLE_MARKET_NOT_FOUND,
      maturity === "allow_matured"
        ? "No Pendle market at this address."
        : "No active Pendle market at this address.",
    );
  }
  const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  return {
    chainId,
    market,
    marketAddress: getAddress(market.address),
    wallet,
    amount,
  };
}

/**
 * Build the canonical Pendle LP ADD identity (token → LP). Reads `tokenIn` (the
 * payment token) plus the shared LP leg. The receiver is ALWAYS the selected EVM
 * wallet - the calldata intent binding asserts receiver == wallet before signing.
 */
export async function buildPendleLpAddIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<LpAddMatchInput> {
  const tokenInRaw = pStr(params, "tokenIn");
  if (!tokenInRaw) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Pendle LP add identity missing tokenIn.");
  }
  const tokenIn = requireAddr(tokenInRaw, "LP add tokenIn");
  const leg = await resolveLpLeg(params, context, "active_only");
  return {
    kind: "lp_add",
    sessionId,
    provider: "pendle",
    chainId: leg.chainId,
    walletAddress: leg.wallet,
    receiver: leg.wallet,
    market: leg.marketAddress,
    tokenIn,
    amount: leg.amount,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  };
}

/**
 * Build the canonical Pendle LP REMOVE identity (LP → token). The output token is
 * `tokenOut` when provided, else the market's underlyingAsset - resolved
 * identically on both sides so a quote-without-tokenOut authorizes an
 * execute-without-tokenOut. A divergent `tokenOut` produces a different digest →
 * gate BLOCK.
 */
export async function buildPendleLpRemoveIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<LpRemoveMatchInput> {
  const leg = await resolveLpLeg(params, context, "allow_matured");
  const tokenOutRaw = pStr(params, "tokenOut");
  let tokenOut: string;
  if (tokenOutRaw) {
    tokenOut = requireAddr(tokenOutRaw, "LP remove tokenOut");
  } else if (leg.market.underlyingAsset) {
    tokenOut = getAddress(leg.market.underlyingAsset);
  } else {
    throw new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "Pendle market has no underlying for the remove output.");
  }
  return {
    kind: "lp_remove",
    sessionId,
    provider: "pendle",
    chainId: leg.chainId,
    walletAddress: leg.wallet,
    receiver: leg.wallet,
    market: leg.marketAddress,
    tokenOut,
    amount: leg.amount,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  };
}
