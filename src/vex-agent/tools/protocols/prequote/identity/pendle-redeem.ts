/**
 * Pendle PT redeem identity builder (Wave 5, LOCKED G2#3).
 *
 * Pendle redeem gets its OWN identity path — it does NOT reuse the Khalani/Relay
 * bridge builder. The Pendle QUOTE recorder (`pendle.pt.quote`, when Convert
 * returns action `redeem-py`) and the redeem EXECUTE gate (`pendle.pt.redeem`)
 * both build an IDENTICAL redeem identity from the same PT/amount/receiver, with
 * `provider: "pendle"` bound in, so their match-hashes collide. The YT is
 * resolved from the PT through the SAME market lookup on both sides, so neither
 * side reimplements the mapping.
 *
 * Material = { provider, wallet, chainId, ptAddress, ytAddress, amount, receiver,
 * slippageBps }. Any throw (missing field, unsupported chain, unresolved YT,
 * wallet-scope) propagates: the recorder treats it as a skip, the gate as a
 * fail-closed BLOCK.
 */

import { getAddress } from "viem";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";
import { resolveExitYtForPt } from "../../pendle/matured-market-lookup.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { RedeemMatchInput } from "./hash.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";

function pStr(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Build the canonical Pendle redeem identity from (untrusted) params + context.
 * The PT is read from `ptAddress` (recorder) or `tokenIn` (execute gate); the
 * amount from `amount` or `amountIn`; the chain from `chain` via the SAME
 * network-free registry both sides use, so record and gate agree on the id. The
 * receiver is ALWAYS the selected EVM wallet — no `recipient` param exists on any
 * Pendle manifest (Codex cleanup), and the calldata intent binding asserts
 * receiver == wallet before signing. YT is resolved from the PT via the
 * chain-scoped active-market lookup.
 */
export async function buildPendleRedeemIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<RedeemMatchInput> {
  const ptRaw = pStr(params, "ptAddress") || pStr(params, "tokenIn");
  const amount = pStr(params, "amount") || pStr(params, "amountIn");
  if (!ptRaw || !amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Pendle redeem identity missing PT/amount.");
  }

  const chainId = resolvePendleChainId(pStr(params, "chain"));
  if (chainId === undefined) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, "Pendle redeem identity on an unsupported chain.");
  }

  let ptAddress: string;
  try {
    ptAddress = getAddress(ptRaw);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, "Pendle redeem PT is not a valid address.");
  }

  // EXIT PATH (R5b): a redeem identity must be buildable for a MATURED PT —
  // otherwise the quote records nothing and the execute gate blocks the very
  // position the tool exists for. Both sides call THIS builder, so record and
  // gate keep colliding by construction; only WHICH markets can produce an
  // identity changed, never the identity material.
  const yt = await resolveExitYtForPt(chainId, ptAddress);
  if (!yt) {
    throw new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "No Pendle market for this PT.");
  }

  const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");

  return {
    kind: "redeem",
    sessionId,
    provider: "pendle",
    chainId,
    walletAddress: wallet,
    ptAddress,
    ytAddress: yt,
    amount,
    receiver: wallet,
    slippageBps: canonSlippageBpsWithDefault(params, VEX_DEFAULT_SLIPPAGE_BPS),
  };
}
