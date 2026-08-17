/**
 * The ONE place a Morpho Blue MARKET operation is turned into bytes.
 *
 * Four operations, two entirely different build shapes, and the dispatch between
 * them is a money-safety fact rather than a convenience:
 *
 *   supply_collateral, repay     Bundler3 multicall built by the SDK and
 *                                verified leg-by-leg. Both PULL a token, so both
 *                                carry an exact-amount approval.
 *   borrow, withdraw_collateral  DIRECT Morpho Blue calls. Routing either
 *                                through Bundler3 would require a standing
 *                                GeneralAdapter1 authorization on Morpho, which
 *                                the owner's option-1 ruling forbids. They pull
 *                                nothing and carry no approval at all.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE EXECUTION SPINE ────────────────────────
 *
 * It was extracted from `../../../vex-agent/tools/protocols/morpho/handlers/
 * signed-broadcast/market-run.ts` when `morpho.market.quote` arrived, because
 * the preview and the execute must build the SAME BYTES the same way. A quote
 * that priced a transaction the execute would not produce is worse than no
 * quote: the agent is required to quote before it spends, so a second builder
 * would make the gate certify something that never runs (rules/04 forbids two
 * independent readers of one money fact).
 *
 * Every shape is decoded and proven against Vex's own intent before it can be
 * returned, including the one Vex encoded itself. A builder that also gets to
 * say whether its output is correct is not a check.
 */

import { getAddress } from "viem";
import type { Address, Hex } from "viem";

import { VexError, ErrorCodes } from "../../../errors.js";
import type { MorphoActionClient } from "./client.js";
import { buildMorphoDirectBorrow } from "./borrow-engine.js";
import { verifyMorphoBlueCall, type MorphoBlueCallReport } from "./blue-call-decoder.js";
import { buildMorphoMarketOperation } from "./build-market.js";
import type { MorphoMarketBundleReport } from "./market-bundle-decoder.js";
import type { MorphoBlueMarketState } from "./market-state.js";
import type { MorphoBorrowIntent } from "./borrow-types.js";

/** A built market operation, proven, with the two amounts that are not the same number. */
export interface MorphoMarketTransaction {
  readonly txParams: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  /** What THIS build would pull from the wallet, or `null` when it pulls nothing. */
  readonly pullAmountRaw: bigint | null;
  /**
   * What the wallet must APPROVE, or `null` when nothing is pulled. Larger than
   * `pullAmountRaw` only for a repayment denominated in SHARES, whose cost
   * accrues; see the ruling in `./build-market.ts`.
   */
  readonly approvalAmountRaw: bigint | null;
  readonly pullToken: Address | null;
  /** The decoder's account of the bytes, in whichever shape this operation takes. */
  readonly decoded:
    | { readonly shape: "direct-blue-call"; readonly report: MorphoBlueCallReport }
    | { readonly shape: "bundler3-multicall"; readonly report: MorphoMarketBundleReport };
}

/**
 * Build ONE market operation, decode it back, and prove it against the intent.
 *
 * @throws {VexError} `MORPHO_BUNDLE_REJECTED` when the bytes do not match the
 * intent, or `MORPHO_APPROVAL_POLICY_VIOLATION` when the build's requirements
 * are not the single exact-amount approval the owner's policy allows. Nothing is
 * signed or sent on any path through this function.
 */
export async function buildMorphoMarketTransaction(
  client: MorphoActionClient,
  market: MorphoBlueMarketState,
  intent: MorphoBorrowIntent,
  slippageBps: number,
): Promise<MorphoMarketTransaction> {
  if (intent.operation === "borrow") {
    // Vex encodes this one itself, so Vex decodes it back and proves it.
    const built = buildMorphoDirectBorrow(intent, market.marketParams);
    const report = verifyMorphoBlueCall(built, intent, market.marketParams);
    return {
      txParams: { to: built.to, data: built.data, value: built.value },
      pullAmountRaw: null,
      approvalAmountRaw: null,
      pullToken: null,
      decoded: { shape: "direct-blue-call", report },
    };
  }

  if (intent.operation === "withdraw_collateral") {
    // ALSO a direct Blue call, but built by the SDK rather than by
    // `buildMorphoDirectBorrow`, which encodes the `borrow` selector and only
    // that one. The fork capture confirms the shape: a plain call to Morpho
    // Blue, selector 0x8720316d, never touching Bundler3.
    const handle = client.morpho.blue(market.marketParams, market.identity.chainId);
    const tx = handle.withdrawCollateral({
      userAddress: intent.userAddress,
      amount: intent.amountRaw ?? 0n,
      positionData: await handle.getPositionData(intent.userAddress),
    }).buildTx();
    if (tx === null || tx === undefined) {
      throw new VexError(
        ErrorCodes.MORPHO_BUNDLE_REJECTED,
        "Refusing this collateral withdrawal: Morpho's SDK returned no transaction to send.",
        "Nothing was signed or sent. Re-read the market and try again; if it keeps returning nothing, report it "
        + "rather than retrying.",
      );
    }
    const built = { to: getAddress(tx.to), data: tx.data as Hex, value: tx.value ?? 0n };
    const report = verifyMorphoBlueCall(built, intent, market.marketParams);
    return {
      txParams: built,
      pullAmountRaw: null,
      approvalAmountRaw: null,
      pullToken: null,
      decoded: { shape: "direct-blue-call", report },
    };
  }

  const handle = client.morpho.blue(market.marketParams, market.identity.chainId);
  const built = await buildMorphoMarketOperation(client, {
    intent,
    // The SDK's OWN MarketParams instance, so the market id is derived from the
    // object the chain was read into rather than from a look-alike.
    marketParams: market.marketParams,
    positionData: await handle.getPositionData(intent.userAddress),
    slippageBps,
  });
  return {
    txParams: {
      to: getAddress(built.tx.to),
      data: built.tx.data as Hex,
      value: built.tx.value ?? 0n,
    },
    pullAmountRaw: built.transferBoundRaw,
    approvalAmountRaw: built.approvalAmountRaw,
    pullToken: intent.operation === "repay"
      ? market.identity.loanToken
      : market.identity.collateralToken,
    decoded: { shape: "bundler3-multicall", report: built.bundle },
  };
}
