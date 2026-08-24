/**
 * API-independent Pendle redeem fallback (LOCKED C#4).
 *
 * When the Convert API is unavailable for a MATURED position, the wallet must
 * still be able to exit. This builds the Router `redeemPyToSy(receiver, YT,
 * netPyIn, minSyOut)` calldata directly (from IPActionMiscV3) — no hosted API
 * involved. The tx always targets the pinned Router; the caller approves the PT
 * (exact `netPyIn`) to the Router and broadcasts.
 *
 * `minSyOut` is SHARE-BASED, not 1:1. SY is a share token: PT is denominated in
 * the accounting asset, and the Router pays `netPyIn * 1e18 /
 * SY.exchangeRate()`. Live-measured 2026-07-28 on the matured srUSDe market
 * (`agents_dm/agentscan-phase4/live-gate/free-lanes-2026-07-28.md`, LANE 2 /
 * L2-D1): `netPyIn 1896804154210053863` paid `netSyOut 1845564247148178107` at
 * rate `1027763816481086050` — 97.29 %, while the old 1:1 floor demanded
 * 99.49 % and the redemption reverted with `Slippage: INSUFFICIENT_SY_OUT`.
 *
 * So the tolerance is applied to the rate-converted expectation. It is NOT a
 * conversion allowance: it covers only exchange-rate accrual between the read
 * and the mine (the rate rises, output falls slightly). A zero floor is still
 * refused — a redemption must never accept an unbounded-loss `minSyOut` — and a
 * failed rate read is refused BY NAME rather than falling back to 1:1.
 */

import { encodeFunctionData, getAddress, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { PENDLE_ROUTER, PENDLE_ROUTER_REDEEM_ABI, PENDLE_SY_RATE_ABI } from "@tools/pendle/constants.js";
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
      "The direct redeem path only works on a matured PT. Re-check the market with pendle__market_get before retrying.",
    );
  }
  if (classified.state === "not_matured") {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      `Pendle refused to sign: this PT has not matured yet (expires ${expiry}), and the direct redeem would revert on-chain.`,
      "Nothing was signed or spent. To exit before maturity sell the PT with pendle__pt_sell, or redeem the full PT+YT pair with pendle__py_redeem.",
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
  /** 1e18-scaled SY exchange rate the floor was computed from. */
  syExchangeRate: bigint;
  /** `netPyIn * 1e18 / syExchangeRate` — the output before tolerance. */
  expectedSyOut: bigint;
}

const WAD = 10n ** 18n;

/**
 * Build the `redeemPyToSy` calldata + a share-based `minSyOut`. Performs ONE
 * free `eth_call` (`SY.exchangeRate()`); everything else is local. Throws on a
 * malformed address, a non-positive amount, or an unreadable/non-positive
 * exchange rate, so a bad exit plan can never be broadcast.
 */
export async function buildRedeemPyToSyPlan(input: {
  publicClient: PublicClient<Transport, Chain>;
  receiver: string;
  yt: string;
  /** The market's SY — the share token the redemption actually pays. */
  sy: string;
  netPyIn: bigint;
  /**
   * Slippage tolerance as a fraction in [0, 1) for the minSyOut floor.
   * REQUIRED, and REJECTED rather than replaced when out of range: this layer
   * holds no default of its own, because what an omitted tolerance means is
   * product policy with one home (`slippage-policy.ts`
   * `VEX_DEFAULT_SLIPPAGE_BPS`), already resolved by the calling handler. A
   * local fallback here silently redeemed at a tolerance the caller never
   * authorized.
   */
  slippage: number;
}): Promise<RedeemPyToSyPlan> {
  if (input.netPyIn <= 0n) {
    throw new VexError(ErrorCodes.INVALID_AMOUNT, "Redeem amount must be positive.");
  }
  let receiver: Address;
  let yt: Address;
  let sy: Address;
  try {
    receiver = getAddress(input.receiver);
    yt = getAddress(input.yt);
    sy = getAddress(input.sy);
  } catch {
    throw new VexError(ErrorCodes.PENDLE_UNSAFE_TX, "Redeem fallback address is malformed.");
  }

  // The floor's scale comes from the chain, never from an assumption. A read
  // failure refuses the redeem: a 1:1 fallback is exactly the defect that made
  // the live redemption revert.
  let syExchangeRate: bigint;
  try {
    syExchangeRate = (await input.publicClient.readContract({
      address: sy,
      abi: PENDLE_SY_RATE_ABI,
      functionName: "exchangeRate",
    })) as bigint;
  } catch (err) {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      `Pendle refused to sign: this market's SY exchange rate could not be read, so a safe minSyOut cannot be computed (${err instanceof Error ? err.message : String(err)}).`,
      "Nothing was signed or spent. Retry when the RPC is reachable.",
    );
  }
  if (syExchangeRate <= 0n) {
    throw new VexError(
      ErrorCodes.PENDLE_UNSAFE_TX,
      "Pendle refused to sign: this market's SY reported a non-positive exchange rate, so a safe minSyOut cannot be computed.",
      "Nothing was signed or spent.",
    );
  }

  const slippage = input.slippage;
  if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
    throw new VexError(
      ErrorCodes.INVALID_AMOUNT,
      `Redeem fallback slippage must be a fraction in [0, 1); received ${slippage}.`,
    );
  }
  // SY is share-based: the Router pays netPyIn * 1e18 / exchangeRate.
  const expectedSyOut = (input.netPyIn * WAD) / syExchangeRate;
  // Tolerance protects ONLY against rate accrual between this read and the mine.
  const bps = BigInt(Math.round((1 - slippage) * 10_000));
  const minSyOut = (expectedSyOut * bps) / 10_000n;
  if (minSyOut <= 0n) {
    throw new VexError(ErrorCodes.PENDLE_UNSAFE_TX, "Redeem fallback minSyOut floored to zero.");
  }

  const data = encodeFunctionData({
    abi: PENDLE_ROUTER_REDEEM_ABI,
    functionName: "redeemPyToSy",
    args: [receiver, yt, input.netPyIn, minSyOut],
  });

  return { to: PENDLE_ROUTER, data, receiver, yt, netPyIn: input.netPyIn, minSyOut, syExchangeRate, expectedSyOut };
}
