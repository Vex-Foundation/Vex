/**
 * Pendle SY wrap / unwrap identity builder (R5d card D3).
 *
 * `pendle.sy.mint` (token → SY) and `pendle.sy.redeem` (SY → token) use the
 * DRY-RUN-IN-TOOL prequote pattern: ONE toolId both records the prequote (on a
 * `dryRun: true` call) and is gated by it (on the execute call). Both sides call
 * THIS builder with the SAME params, so their match-hashes collide by
 * construction — the same contract every quote-then-execute Pendle pair already
 * holds, with the recorder moved inside the tool.
 *
 * WHY THIS REUSES THE `swap` IDENTITY SHAPE rather than introducing an SY kind.
 * An SY wrap is a one-in-one-out token conversion: chain + wallet + tokenIn +
 * tokenOut + amount + slippage is the COMPLETE execute-variance surface, which
 * is exactly `SwapMatchInput`. A dedicated kind would need a new
 * `swap_prequotes.kind` CHECK value — a migration — to express nothing the swap
 * material does not already bind. There is no market, no PT and no YT to bind:
 * an SY has no maturity and belongs to no market.
 *
 * VENUE BINDING (`provider: "pendle-sy"`, not "pendle"). The swap material binds
 * `provider` last, so this label is what makes an SY prequote structurally unable
 * to authorize a `pendle.pt.buy` / `pendle.yt.buy` execute (recorded under
 * "pendle") or vice-versa, even for identical token legs and amount. The two
 * DIRECTIONS separate themselves: mint's tokenIn is redeem's tokenOut, so their
 * digests differ without needing a direction tag.
 *
 * Any throw (missing field, unsupported chain, malformed address, out-of-contract
 * slippage) propagates: the recorder treats it as a skip, the gate as a
 * fail-closed BLOCK.
 */

import { getAddress } from "viem";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolvePendleChainId } from "@tools/pendle/chains.js";

import { VexError, ErrorCodes } from "../../../../../errors.js";
import { canonSlippageBpsWithDefault } from "../slippage.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { SwapMatchInput } from "./hash.js";

/**
 * The venue label bound into every SY prequote digest. Deliberately NOT
 * "pendle": see the module doc.
 */
export const PENDLE_SY_PREQUOTE_PROVIDER = "pendle-sy";

/**
 * Default slippage (bps) when the caller omits it — MUST match the handler's
 * default (`pendle/handlers/shared.ts` DEFAULT_SLIPPAGE_BPS) so a
 * dry-run-without-slippage authorizes an execute-without-slippage. Both sides go
 * through THIS builder, so the default is applied identically by construction. A
 * PRESENT but invalid value is refused by `canonSlippageBpsWithDefault` rather
 * than replaced by this default — a silent fallback would fold the default into
 * the digest and let an out-of-contract slippage hash like an omitted one.
 */
const DEFAULT_SLIPPAGE_BPS = 50;

/** Which way the wrapper runs. Decides only which leg is in and which is out. */
export type PendleSyDirection = "mint" | "redeem";

/**
 * The manifest key carrying the plain-token leg for a direction (SPEC §1.2).
 *
 * A mint pays a token IN and receives SY; a redeem burns SY and receives the
 * token OUT. Both lanes — the handler and this identity builder — read the key
 * through this ONE function, so the recorder and the gate can never read
 * different keys and silently diverge the digest.
 */
export function pendleSyTokenParamKey(direction: PendleSyDirection): "tokenIn" | "tokenOut" {
  return direction === "mint" ? "tokenIn" : "tokenOut";
}

function pStr(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Resolve + checksum an address param, or throw a bounded token error. */
function requireAddr(raw: string, label: string): string {
  try {
    return getAddress(raw);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_TOKEN_NOT_FOUND, `Pendle SY ${label} is not a valid address.`);
  }
}

/**
 * Build the canonical Pendle SY identity from (untrusted) params + context.
 *
 * The receiver is ALWAYS the selected EVM wallet — no `recipient` param exists on
 * any Pendle manifest, and the calldata intent binding asserts receiver == wallet
 * before signing, so `recipient` is pinned to the wallet and `approveExact` to
 * the executor's constant `false`.
 */
export function buildPendleSyIdentity(
  sessionId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
  direction: PendleSyDirection,
): SwapMatchInput {
  const tokenKey = pendleSyTokenParamKey(direction);
  const syRaw = pStr(params, "sy");
  const tokenRaw = pStr(params, tokenKey);
  const amount = pStr(params, "amountIn");
  if (!syRaw || !tokenRaw || !amount) {
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      `Pendle SY identity missing sy/${tokenKey}/amountIn.`,
    );
  }

  const chainId = resolvePendleChainId(pStr(params, "chain"));
  if (chainId === undefined) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, "Pendle SY identity on an unsupported chain.");
  }

  const sy = requireAddr(syRaw, "SY");
  const token = requireAddr(tokenRaw, tokenKey);
  if (sy.toLowerCase() === token.toLowerCase()) {
    throw new VexError(
      ErrorCodes.PENDLE_TOKEN_NOT_FOUND,
      "Pendle SY identity has the same address on both legs.",
    );
  }

  const wallet = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");

  return {
    kind: "swap",
    sessionId,
    family: "eip155",
    provider: PENDLE_SY_PREQUOTE_PROVIDER,
    chainId,
    walletAddress: wallet,
    tokenIn: direction === "mint" ? token : sy,
    tokenOut: direction === "mint" ? sy : token,
    amount,
    recipient: wallet,
    approveExact: false,
    slippageBps: canonSlippageBpsWithDefault(params, DEFAULT_SLIPPAGE_BPS),
  };
}
