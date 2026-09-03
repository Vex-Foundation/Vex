/**
 * `solana.swap.quote` - the read-only, wallet-scoped fee-bearing route probe.
 *
 * Extracted verbatim from `../core.ts` as part of a façade-preserving
 * structural split (W5 design §6/R4 - the fee-bearing `/build` atomic flip).
 * The quote builds via `prepareFeeBearingJupiterSwap`, the ONE place
 * `platformFeeBps`/`feeAccount` are set - always the hardcoded 25bps + the
 * derived treasury ATA, never model-controllable. It is wallet-scoped (unlike
 * the old `/order` path): a fee-bearing `/build` needs a real `taker`.
 */

import { requireJupiterResolvedTokenWithSafety } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js";
import {
  prepareFeeBearingJupiterSwap,
  buildJupiterFeePreview,
  type JupiterFeeSwapKnobs,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";
import { getSolanaConnection } from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";

import type { ProtocolHandler } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";
import { projectJupiterSwapRoute } from "../../swap-route-projector.js";
import { formatRawAmount } from "../../../amount-display.js";
import { negativePriceImpactNote } from "../../../price-impact-note.js";
import { humanAmountToAtomic } from "./swap-amount.js";
import { jupiterSlippageViolation, resolveJupiterSwapKnobs, swapFailureMessage } from "./swap-policy.js";
import { walletAddress } from "./wallet-scope.js";

export const swapQuoteHandler: ProtocolHandler = async (p, ctx) => {
  const inputRaw = str(p, "tokenIn"), outputRaw = str(p, "tokenOut");
  const amountInRaw = str(p, "amountIn");
  if (!inputRaw || !outputRaw || !amountInRaw) return fail("Missing required: tokenIn, tokenOut, amountIn");

  const slippageViolation = jupiterSlippageViolation("solana.swap.quote", p);
  if (slippageViolation) return fail(slippageViolation);

  let taker: string;
  try {
    taker = walletAddress(p, ctx);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let knobs: JupiterFeeSwapKnobs;
  try {
    knobs = resolveJupiterSwapKnobs(p);
  } catch (err) {
    return fail(`solana__swap_quote failed: ${swapFailureMessage(err)}`);
  }

  const [{ token: inputToken, safety: inputSafety }, { token: outputToken, safety: outputSafety }] = await Promise.all([
    requireJupiterResolvedTokenWithSafety(inputRaw),
    requireJupiterResolvedTokenWithSafety(outputRaw),
  ]);
  const converted = humanAmountToAtomic("amountIn", amountInRaw, inputToken.decimals, inputToken.symbol);
  if (!converted.ok) return fail(`solana__swap_quote failed: ${converted.reason}`);
  const amountRaw = converted.amountRaw;

  let prepared;
  try {
    prepared = await prepareFeeBearingJupiterSwap({
      connection: getSolanaConnection(),
      inputMint: inputToken.address,
      outputMint: outputToken.address,
      amountRaw,
      taker,
      knobs,
      inputDecimals: inputToken.decimals,
    });
  } catch (err) {
    return fail(`solana__swap_quote failed: ${swapFailureMessage(err)}`);
  }

  const safety = inputSafety || outputSafety
    ? { ...(inputSafety ? { inputToken: inputSafety } : {}), ...(outputSafety ? { outputToken: outputSafety } : {}) }
    : undefined;

  const { priceImpactFraction, routePlan } = projectJupiterSwapRoute(prepared.raw);

  // Output-polish parity with `kyberswap.swap.quote` (2026-07-30): a compact
  // HUMAN summary FIRST, machine fields after - as one JSON key ordering, not
  // a free-text prefix, so `output` stays parseable.
  //
  // The reason this exists: a live session showed a weaker model copying a raw
  // base-unit figure out of a quote and into its user-facing reply. Every
  // amount below is therefore spelled in token units, using the decimals
  // already resolved on this path. `inputAmountRaw`/`outputAmountRaw`/
  // `otherAmountThreshold` keep the provider's raw strings untouched - machines
  // read those; this string is the human/agent layer. It degrades to the raw
  // value rather than failing a quote over a display detail.
  //
  // NO USD figure is quoted: Jupiter's `/build` response carries none (its
  // `inUsdValue`/`outUsdValue` are `/order`-only fields), and inventing one
  // would be a claim the evidence does not support.
  const humanIn = formatRawAmount(prepared.raw.inAmount, inputToken.decimals) ?? prepared.raw.inAmount;
  const humanOut = formatRawAmount(prepared.raw.outAmount, outputToken.decimals) ?? prepared.raw.outAmount;
  // A decimal FRACTION, rendered as a percent - see `../../swap-route-projector.ts`
  // for why the provider's `priceImpactPct` name is a unit trap. Omitted, never
  // shown as 0, when the provider gave nothing readable: unknown is not zero.
  // Jupiter is COST-POSITIVE like KyberSwap (sign pinned by the live capture in
  // `../../swap-route-projector.ts`), so a negative impact carries the SAME
  // meaning and the same shared explanatory note.
  const priceImpactNumber = priceImpactFraction !== null ? Number(priceImpactFraction) : null;
  const priceImpactPercent =
    priceImpactNumber !== null && Number.isFinite(priceImpactNumber) ? priceImpactNumber * 100 : null;
  const summary =
    `Quote: ${humanIn} ${inputToken.symbol} → ~${humanOut} ${outputToken.symbol} on Solana.`
    + (priceImpactPercent !== null
      ? ` Price impact ${priceImpactPercent.toFixed(2)}%.${negativePriceImpactNote(priceImpactNumber)}`
      : "");

  return ok({
    summary,
    inputToken,
    outputToken,
    ...(safety ? { safety } : {}),
    inputAmountRaw: prepared.raw.inAmount,
    outputAmountRaw: prepared.raw.outAmount,
    otherAmountThreshold: prepared.raw.otherAmountThreshold,
    slippageBps: knobs.slippageBps,
    // Decimal FRACTION, not a percent - see `../../swap-route-projector.ts`.
    priceImpactFraction,
    routePlan,
    feePreview: buildJupiterFeePreview(prepared),
  });
};
