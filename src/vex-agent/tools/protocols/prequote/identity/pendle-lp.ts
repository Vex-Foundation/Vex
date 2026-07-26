/**
 * Pendle LP (single-token add / remove) identity builders (P5).
 *
 * Both the `pendle.lp.quote` recorder and the `pendle.lp.add` / `pendle.lp.remove`
 * EXECUTE gates build IDENTICAL identities from the same params (`chain`,
 * `market`, `tokenIn`/`tokenOut`, `amountIn`, `slippageBps`) with
 * `provider: "pendle"` bound in, so their match-hashes collide. The market is the
 * LP anchor and is bound DIRECTLY (validated against the chain's active markets via
 * `resolveMarketByAddress`) — never resolved from a PT — so neither side
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

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { LpAddMatchInput, LpRemoveMatchInput } from "./hash.js";

/**
 * Default slippage (bps) when the caller omits it — MUST match the handler's
 * default (`handlers/shared.ts` DEFAULT_SLIPPAGE_BPS) so a quote-without-slippage
 * authorizes an execute-without-slippage. Both sides go through THESE builders, so
 * the default is applied identically by construction. A PRESENT but invalid
 * value is refused by `canonSlippageBpsWithDefault` rather than replaced by
 * this default — a silent fallback would fold the default into the digest and
 * let an out-of-contract slippage hash like an omitted one.
 */
const DEFAULT_SLIPPAGE_BPS = 50;

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

/** Resolve the shared LP leg: chainId + the validated market (address + underlying) + wallet. */
async function resolveLpLeg(params: Record<string, unknown>, context: ProtocolExecutionContext) {
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
  const market = await resolveMarketByAddress(chainId, marketAddress);
  if (!market || !market.address) {
    throw new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "No active Pendle market at this address.");
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
 * wallet — the calldata intent binding asserts receiver == wallet before signing.
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
  const leg = await resolveLpLeg(params, context);
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
    slippageBps: canonSlippageBpsWithDefault(params, DEFAULT_SLIPPAGE_BPS),
  };
}

/**
 * Build the canonical Pendle LP REMOVE identity (LP → token). The output token is
 * `tokenOut` when provided, else the market's underlyingAsset — resolved
 * identically on both sides so a quote-without-tokenOut authorizes an
 * execute-without-tokenOut. A divergent `tokenOut` produces a different digest →
 * gate BLOCK.
 */
export async function buildPendleLpRemoveIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<LpRemoveMatchInput> {
  const leg = await resolveLpLeg(params, context);
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
    slippageBps: canonSlippageBpsWithDefault(params, DEFAULT_SLIPPAGE_BPS),
  };
}
