/**
 * Pendle PY (mint / pre-expiry redeem) identity builders (P4).
 *
 * Both the `pendle.py.quote` recorder and the `pendle.py.mint` /
 * `pendle.py.redeem` EXECUTE gates build IDENTICAL identities from the same
 * params (`chain`, `pt`, `tokenIn`/`tokenOut`, `amountIn`, `slippageBps`) with
 * `provider: "pendle"` bound in, so their match-hashes collide. The market (and
 * its YT + underlyingAsset) is resolved from the PT anchor through the SAME
 * chain-scoped market lookup on both sides, so neither side reimplements the
 * mapping. These are their OWN identity paths — they never reuse the swap,
 * bridge, or matured-redeem builder.
 *
 * Any throw (missing field, unsupported chain, unresolved market) propagates:
 * the recorder treats it as a skip, the gate as a fail-closed BLOCK.
 */

import { getAddress } from "viem";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";
import { resolveMarketByPt } from "../../pendle/market-lookup.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { MintMatchInput, RedeemPyMatchInput } from "./hash.js";

/**
 * Default slippage (bps) when the caller omits it — MUST match the handler's
 * default (`handlers/shared.ts` DEFAULT_SLIPPAGE_BPS) so a quote-without-slippage
 * authorizes an execute-without-slippage. Both sides go through THESE builders,
 * so the default is applied identically by construction.
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

/** Resolve the shared PY leg: chainId + the PT's market (address, YT, underlying) + wallet. */
async function resolvePyLeg(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const ptRaw = pStr(params, "pt");
  const amount = pStr(params, "amountIn");
  if (!ptRaw || !amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Pendle PY identity missing PT/amount.");
  }
  const chainId = resolvePendleChainId(pStr(params, "chain"));
  if (chainId === undefined) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, "Pendle PY identity on an unsupported chain.");
  }
  const ptAddress = requireAddr(ptRaw, "PY PT");
  const market = await resolveMarketByPt(chainId, ptAddress);
  if (!market || !market.address || !market.yt) {
    throw new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "No active Pendle market for this PT.");
  }
  const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  return {
    chainId,
    ptAddress,
    market,
    ytAddress: getAddress(market.yt),
    marketAddress: getAddress(market.address),
    wallet,
    amount,
  };
}

/**
 * Build the canonical Pendle MINT identity (token → PT+YT). Reads `tokenIn` (the
 * payment token) plus the shared PY leg. The receiver is ALWAYS the selected EVM
 * wallet — the calldata intent binding asserts receiver == wallet before signing.
 */
export async function buildPendleMintIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<MintMatchInput> {
  const tokenInRaw = pStr(params, "tokenIn");
  if (!tokenInRaw) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Pendle mint identity missing tokenIn.");
  }
  const tokenIn = requireAddr(tokenInRaw, "mint tokenIn");
  const leg = await resolvePyLeg(params, context);
  return {
    kind: "mint",
    sessionId,
    provider: "pendle",
    chainId: leg.chainId,
    walletAddress: leg.wallet,
    receiver: leg.wallet,
    tokenIn,
    amount: leg.amount,
    ptAddress: leg.ptAddress,
    ytAddress: leg.ytAddress,
    market: leg.marketAddress,
    slippageBps: canonSlippageBpsWithDefault(params, DEFAULT_SLIPPAGE_BPS),
  };
}

/**
 * Build the canonical Pendle PRE-EXPIRY REDEEM identity (PT+YT → token). The
 * output token is `tokenOut` when provided, else the market's underlyingAsset —
 * resolved identically on both sides so a quote-without-tokenOut authorizes an
 * execute-without-tokenOut. A divergent `outputToken` produces a different digest
 * → gate BLOCK.
 */
export async function buildPendleRedeemPyIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<RedeemPyMatchInput> {
  const leg = await resolvePyLeg(params, context);
  const tokenOutRaw = pStr(params, "tokenOut");
  let outputToken: string;
  if (tokenOutRaw) {
    outputToken = requireAddr(tokenOutRaw, "redeem tokenOut");
  } else if (leg.market.underlyingAsset) {
    outputToken = getAddress(leg.market.underlyingAsset);
  } else {
    throw new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "Pendle market has no underlying for the redeem output.");
  }
  return {
    kind: "redeem_py",
    sessionId,
    provider: "pendle",
    chainId: leg.chainId,
    walletAddress: leg.wallet,
    receiver: leg.wallet,
    ptAddress: leg.ptAddress,
    ytAddress: leg.ytAddress,
    amount: leg.amount,
    outputToken,
    slippageBps: canonSlippageBpsWithDefault(params, DEFAULT_SLIPPAGE_BPS),
  };
}
