/**
 * `trench.trade_quote` handler — READ-ONLY curve price quote.
 *
 * Reads the DETERMINISTIC, FEE-INCLUSIVE `quote()` and `fakepool_stats()` on the
 * Diamond and discloses the exact expected output, the 1% ETH-leg fee, the price
 * impact against the curve reserves, and progress toward graduation. Signs
 * nothing. The output is swap-shaped (`chainId`, `tokenIn.address`,
 * `tokenOut.address`, `safety`) so the runtime records a `swap` prequote
 * (provider "trench") whose match-hash binds tokenIn/tokenOut/amount/chain — the
 * gate the paired `trench.trade_execute` is checked against.
 */

import { parseUnits, formatUnits, formatEther, type Address } from "viem";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getLocalPublicClient } from "@tools/evm-chains/evm-client.js";
import { readCurveQuote, readCurveStats, readTokenDecimals, curveProgressPct, computePriceImpactPct } from "@tools/trench-express/evm/curve-reader.js";
import type { ProtocolExecutionContext } from "../../types.js";
import {
  buildTrenchFeeDisclosure,
  buildTrenchFeeSkippedDisclosure,
  splitTrenchEthForFee,
  type TrenchFeeDisclosure,
  type VexFeeBpsSplit,
} from "@tools/trench-express/fee/index.js";
import type { TrenchTradeSide } from "@tools/trench-express/evm/curve-reader.js";
import { ok, fail } from "../../handler-helpers.js";
import { resolveTradeInputs } from "./trade/shared.js";
import { trenchFailureDetail } from "./failure.js";

const NO_FEE_AT_THIS_SIZE =
  "25 bps of the ETH leg floors to zero at this size, so no fee transfer is made.";

/**
 * The quote's Vex-fee disclosure. Identical in shape and (on a buy) in value to
 * what `trench.trade_execute` discloses, so an agent that quotes and then
 * executes never sees the number change under it.
 *
 * On a SELL the figure is necessarily an ESTIMATE — the base is the ETH the sell
 * will produce, and the execute leg re-derives it from the DECODED proceeds. The
 * `basis` field says so explicitly rather than leaving it implied.
 */
function buildQuoteFeeDisclosure(
  side: TrenchTradeSide,
  amountInRaw: bigint,
  expectedOutRaw: bigint,
  buyFeeSplit: VexFeeBpsSplit | null,
): TrenchFeeDisclosure {
  if (side === "buy") {
    const split = buyFeeSplit!;
    return split.charged
      ? buildTrenchFeeDisclosure({ basis: "buy_eth_in", baseWei: amountInRaw, feeWei: split.feeRaw, netWei: split.netRaw })
      : buildTrenchFeeSkippedDisclosure({ basis: "buy_eth_in", baseWei: amountInRaw, reason: NO_FEE_AT_THIS_SIZE });
  }
  const split = splitTrenchEthForFee(expectedOutRaw);
  return split.charged
    ? buildTrenchFeeDisclosure({ basis: "sell_eth_out", baseWei: expectedOutRaw, feeWei: split.feeRaw })
    : buildTrenchFeeSkippedDisclosure({ basis: "sell_eth_out", baseWei: expectedOutRaw, reason: NO_FEE_AT_THIS_SIZE });
}

const ETH_DECIMALS = 18;
/** 1% fee on the ETH leg, both directions (proven live). */
const FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;

export async function trenchTradeQuoteHandler(
  params: Record<string, unknown>,
  _context: ProtocolExecutionContext,
) {
  const resolved = resolveTradeInputs(params);
  if (!resolved.ok) return fail(resolved.reason);
  const { chainId, side, token, nativeAddress, amountInHuman } = resolved.value;

  const chainConfig = getLocalChain(chainId);
  if (!chainConfig) return fail(`Robinhood Chain (${chainId}) is not in the local chain registry.`);

  try {
    const publicClient = getLocalPublicClient(chainConfig);
    const tokenDecimals = await readTokenDecimals(publicClient, token);
    const inputDecimals = side === "buy" ? ETH_DECIMALS : tokenDecimals;
    const outputDecimals = side === "buy" ? tokenDecimals : ETH_DECIMALS;
    const amountInRaw = parseUnits(amountInHuman, inputDecimals);

    // Vex's 25 bps fee, computed EXACTLY as `trench.trade_execute` computes it,
    // so quote and execute disclose the same number. On a BUY it comes off the
    // input and the curve is quoted for the remainder, which is why the
    // `expectedOut` below is already post-fee and is what actually arrives.
    const buyFeeSplit = side === "buy" ? splitTrenchEthForFee(amountInRaw) : null;
    const curveInRaw = buyFeeSplit?.charged === true ? buyFeeSplit.netRaw : amountInRaw;

    const [expectedOutRaw, stats] = await Promise.all([
      readCurveQuote(publicClient, { token, side, amountInRaw: curveInRaw }),
      readCurveStats(publicClient, token),
    ]);

    // On a SELL the base is the ETH RECEIVED (the owner-approved deviation from
    // `currency_in`), and at quote time the only figure available is the
    // estimate — the execute leg re-derives it from the DECODED proceeds.
    const vexFee = buildQuoteFeeDisclosure(side, amountInRaw, expectedOutRaw, buyFeeSplit);

    // 1% fee on the ETH leg. On a BUY the ETH leg is the input; on a SELL it is
    // the output (fee taken out of the ETH the seller receives).
    const ethLegRaw = side === "buy" ? curveInRaw : expectedOutRaw;
    const feeWei = (ethLegRaw * FEE_BPS) / BPS_DENOMINATOR;
    const progressPct = curveProgressPct(stats.ethReserveWei);

    // Price impact of THIS trade vs the curve spot price (both legs of our own
    // fresh quote): buy → (amountIn ETH, expected tokens); sell → (expected ETH,
    // amountIn tokens). Positive on a buy, negative on a sell.
    const priceImpactPct = computePriceImpactPct({
      ethLegWei: side === "buy" ? curveInRaw : expectedOutRaw,
      tokenLegRaw: side === "buy" ? expectedOutRaw : amountInRaw,
      stats,
      tokenDecimals,
    });

    const tokenInAddress: Address = side === "buy" ? nativeAddress : token;
    const tokenOutAddress: Address = side === "buy" ? token : nativeAddress;

    const impactText = priceImpactPct !== null ? ` Price impact ${priceImpactPct.toFixed(2)}%.` : "";
    const summary =
      `Quote (${side}): ${amountInHuman} ${side === "buy" ? "ETH" : "token"} → ${formatUnits(expectedOutRaw, outputDecimals)} ${side === "buy" ? "token" : "ETH"} on Robinhood Chain. ` +
      `Deterministic curve quote (fee-inclusive). Trench's own 1% ETH-leg curve fee ~${formatEther(feeWei)} ETH.${impactText} ` +
      `Curve reserve ${formatEther(stats.ethReserveWei)} ETH (~${progressPct}% to graduation). ` +
      (vexFee.charged
        ? `Vex fee ${vexFee.feeAmountEth} ETH (${vexFee.bps} bps of ${vexFee.chargedOn}), charged as a separate transfer AFTER the trade confirms.`
        : "No Vex fee applies at this size.");

    return ok({
      summary,
      chain: "robinhood",
      chainId,
      side,
      // Swap-shaped identity fields the prequote recorder reads (extractEvm):
      tokenIn: { address: tokenInAddress },
      tokenOut: { address: tokenOutAddress },
      // No honeypot oracle exists for RBC curve tokens — the ETH leg is native,
      // the token leg is unchecked → the prequote verdict is `unknown`
      // (allowed-with-approval-warning), never a false `pass`.
      safety: {
        tokenIn: side === "buy" ? { native: true } : { checkFailed: true, reason: "unavailable" },
        tokenOut: side === "buy" ? { checkFailed: true, reason: "unavailable" } : { native: true },
      },
      expectedOutRaw: expectedOutRaw.toString(),
      expectedOutHuman: formatUnits(expectedOutRaw, outputDecimals),
      outputDecimals,
      feeWei: feeWei.toString(),
      feeEth: formatEther(feeWei),
      feeBps: Number(FEE_BPS),
      vexFee,
      priceImpactPct,
      curve: {
        ethReserveWei: stats.ethReserveWei.toString(),
        ethReserveEth: formatEther(stats.ethReserveWei),
        tokenReserveRaw: stats.tokenReserveRaw.toString(),
        fakeEthWei: stats.fakeEthWei.toString(),
        progressPct,
      },
    });
  } catch (err) {
    return fail(`trench.trade_quote failed (${trenchFailureDetail("trench.trade_quote", err)})`);
  }
}
