/**
 * API-independent Pendle redeem fallback (LOCKED C#4).
 *
 * When the Convert API is unavailable for a MATURED position, the wallet must
 * still be able to exit. This builds the Router `redeemPyToSy(receiver, YT,
 * netPyIn, minSyOut)` calldata directly (from IPActionMiscV3) — no hosted API
 * involved. The tx always targets the pinned Router; the caller approves the PT
 * (exact `netPyIn`) to the Router and broadcasts.
 *
 * `minSyOut` is conservative: a matured PT redeems ~1:1, so we floor it at
 * `netPyIn * (1 - slippage)` scaled by nothing (SY shares 1:1 with PT units at
 * maturity for these markets). A zero floor is refused — a redemption must never
 * accept an unbounded-loss `minSyOut`.
 */

import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { PENDLE_ROUTER, PENDLE_ROUTER_REDEEM_ABI } from "@tools/pendle/constants.js";
import { classifyPendleExpiry } from "./market-maturity.js";

/**
 * The fallback's PRECONDITION: the position must already be matured (P1-14).
 *
 * `redeemPyToSy` burns PT alone, which the protocol permits only AFTER expiry —
 * before it, the call needs the YT too and MUST revert on-chain. The redeem
 * handler reaches this branch whenever Convert returns anything other than a
 * `redeem-py` action, INCLUDING a perfectly good `"swap"` and any transport
 * failure, so without this check a pre-expiry redeem approves the PT and
 * broadcasts a transaction that cannot succeed. `market.expiry` was already in
 * hand at the call site and simply never consulted.
 *
 * An UNKNOWN maturity is refused, not assumed: a missing or unparseable expiry
 * is not evidence that a PT has matured. Same doctrine the R5b resolver applies
 * to inactive rows.
 *
 * `now` is injected so the boundary is testable without a clock stub.
 */
export function assertPtMaturedForFallback(expiry: string | null, now: Date = new Date()): void {
  const classified = classifyPendleExpiry(expiry, now);
  if (classified.state === "unreadable") {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      classified.reason === "missing"
        ? "Pendle refused to sign: this market publishes no expiry, so maturity cannot be proven."
        : "Pendle refused to sign: this market's expiry could not be read, so maturity cannot be proven.",
      "The direct redeem path only works on a matured PT. Re-check the market with pendle.market.get before retrying.",
    );
  }
  if (classified.state === "not_matured") {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      `Pendle refused to sign: this PT has not matured yet (expires ${expiry}), and the direct redeem would revert on-chain.`,
      "Nothing was signed or spent. To exit before maturity sell the PT with pendle.pt.sell, or redeem the full PT+YT pair with pendle.py.redeem.",
    );
  }
}

export interface RedeemPyToSyPlan {
  to: Address;
  data: Hex;
  receiver: Address;
  yt: Address;
  netPyIn: bigint;
  minSyOut: bigint;
}

/**
 * Build the `redeemPyToSy` calldata + a conservative `minSyOut`. Pure — no
 * network. Throws on a malformed address or a non-positive amount so a bad exit
 * plan can never be broadcast.
 */
export function buildRedeemPyToSyPlan(input: {
  receiver: string;
  yt: string;
  netPyIn: bigint;
  /** Slippage tolerance 0-1 for the minSyOut floor (default 0.5%). */
  slippage?: number;
}): RedeemPyToSyPlan {
  if (input.netPyIn <= 0n) {
    throw new VexError(ErrorCodes.INVALID_AMOUNT, "Redeem amount must be positive.");
  }
  let receiver: Address;
  let yt: Address;
  try {
    receiver = getAddress(input.receiver);
    yt = getAddress(input.yt);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_UNSAFE_TX, "Redeem fallback address is malformed.");
  }

  const slippage = input.slippage !== undefined && input.slippage >= 0 && input.slippage < 1 ? input.slippage : 0.005;
  // Matured PT ↔ SY is ~1:1; floor conservatively and refuse a zero floor.
  const bps = BigInt(Math.round((1 - slippage) * 10_000));
  const minSyOut = (input.netPyIn * bps) / 10_000n;
  if (minSyOut <= 0n) {
    throw new VexError(ErrorCodes.PENDLE_UNSAFE_TX, "Redeem fallback minSyOut floored to zero.");
  }

  const data = encodeFunctionData({
    abi: PENDLE_ROUTER_REDEEM_ABI,
    functionName: "redeemPyToSy",
    args: [receiver, yt, input.netPyIn, minSyOut],
  });

  return { to: PENDLE_ROUTER, data, receiver, yt, netPyIn: input.netPyIn, minSyOut };
}
