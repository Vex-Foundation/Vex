/**
 * `solana.swap.quote` — the read-only, wallet-scoped fee-bearing route probe.
 *
 * Extracted verbatim from `../core.ts` as part of a façade-preserving
 * structural split (W5 design §6/R4 — the fee-bearing `/build` atomic flip).
 * The quote builds via `prepareFeeBearingJupiterSwap`, the ONE place
 * `platformFeeBps`/`feeAccount` are set — always the hardcoded 25bps + the
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
import { resolveSolanaSwapInputAsset } from "@tools/solana-ecosystem/shared/solana-asset-identity.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { PublicKey } from "@solana/web3.js";

import type { ProtocolHandler } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../../constants/solana-chain.js";
import { classifyMeasuredImpact, isExecutable, type QuoteEligibility } from "../../../quote-authority/eligibility.js";
import { formatShortfall } from "../../../quote-authority/spendability.js";
import {
  judgeJupiterSpendability,
  observeJupiterSwapSpendability,
} from "../../swap-spendability.js";
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

  // WHICH BALANCE the input side spends. `SOL` and the explicit wSOL mint
  // resolve to the same address, so the syntax - not the resolved mint - is
  // what says whether lamports or an SPL account is being spent, and the one
  // ambiguous spelling is refused BY NAME rather than guessed (owner decision
  // 2026-08-31).
  const inputAsset = resolveSolanaSwapInputAsset({
    query: inputRaw,
    resolvedMint: inputToken.address,
    wrapAndUnwrapSol: knobs.wrapAndUnwrapSol,
  });
  if (!inputAsset.ok) return fail(`solana__swap_quote failed: ${inputAsset.message}`);

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

  // QUOTE-TIME ELIGIBILITY. The route is judged first and the wallet second, so
  // an unfundable quote never masks an unusable route. Jupiter's `/build`
  // carries no USD legs (its `inUsdValue`/`outUsdValue` are `/order`-only), so
  // the route verdict here is the venue-measured one and the SPENDABILITY half
  // is what this lane adds.
  const routeEligibility = jupiterRouteEligibility(priceImpactFraction);
  let observation: Awaited<ReturnType<typeof observeJupiterSwapSpendability>> | null = null;
  try {
    observation = await observeJupiterSwapSpendability({
      connection: getSolanaConnection(),
      owner: taker,
      signer: new PublicKey(taker),
      message: prepared.unsignedTx.message,
      inputAsset: inputAsset.asset,
      // Vex's 25 bps is already INSIDE `inAmount` - the swap takes it out of
      // the input side, so adding `feeAmountRaw` on top would charge it twice.
      principalRaw: prepared.raw.inAmount,
      inputSymbol: inputToken.symbol,
      inputDecimals: inputToken.decimals,
    });
  } catch {
    // A quote whose spendability could not even be attempted is NOT executable.
    // It is not an error either: the route is still worth returning, and the
    // recorded row supersedes any older executable one, so nothing stale
    // survives this. Fail closed, never crash the quote.
    observation = null;
  }
  const judged = observation === null
    ? {
      eligibility: {
        kind: "balance_unavailable",
        asset: { chainId: SOLANA_SYNTHETIC_CHAIN_ID, address: inputToken.address, symbol: inputToken.symbol },
        cause: "quote_spendability_read_failed",
      } as const,
      preview: undefined,
    }
    : judgeJupiterSpendability(observation, routeEligibility);

  // Output-polish parity with `kyberswap.swap.quote` (2026-07-30): a compact
  // HUMAN summary FIRST, machine fields after — as one JSON key ordering, not
  // a free-text prefix, so `output` stays parseable.
  //
  // The reason this exists: a live session showed a weaker model copying a raw
  // base-unit figure out of a quote and into its user-facing reply. Every
  // amount below is therefore spelled in token units, using the decimals
  // already resolved on this path. `inputAmountRaw`/`outputAmountRaw`/
  // `otherAmountThreshold` keep the provider's raw strings untouched — machines
  // read those; this string is the human/agent layer. It degrades to the raw
  // value rather than failing a quote over a display detail.
  //
  // NO USD figure is quoted: Jupiter's `/build` response carries none (its
  // `inUsdValue`/`outUsdValue` are `/order`-only fields), and inventing one
  // would be a claim the evidence does not support.
  const humanIn = formatRawAmount(prepared.raw.inAmount, inputToken.decimals) ?? prepared.raw.inAmount;
  const humanOut = formatRawAmount(prepared.raw.outAmount, outputToken.decimals) ?? prepared.raw.outAmount;
  // A decimal FRACTION, rendered as a percent — see `../../swap-route-projector.ts`
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

  const eligibility = judged.eligibility;
  const spendabilityNote = ineligibilityNote(eligibility);

  return {
    ...ok({
      summary: summary + spendabilityNote,
      inputToken,
      outputToken,
      ...(safety ? { safety } : {}),
      inputAmountRaw: prepared.raw.inAmount,
      outputAmountRaw: prepared.raw.outAmount,
      otherAmountThreshold: prepared.raw.otherAmountThreshold,
      slippageBps: knobs.slippageBps,
      // Decimal FRACTION, not a percent, see `../../swap-route-projector.ts`.
      priceImpactFraction,
      routePlan,
      feePreview: buildJupiterFeePreview(prepared),
      // The agent sees WHY, in the same object as the route (contract C2.1): a
      // quote it cannot fund still returns its route facts, and stops being an
      // authorization. The recorded row supersedes every older executable one for
      // this identity, so a stale funded quote cannot be executed afterwards.
      eligibility: isExecutable(eligibility)
        ? { kind: eligibility.kind, executable: true }
        : { kind: eligibility.kind, executable: false },
      // The native cost this swap will actually charge, itemized. `messageFee`
      // is the node's own price for the EXACT transaction and already contains
      // the priority fee, so the `feePreview.priorityFeeLamportsEstimate`
      // disclosure beside it must never be added to it.
      nativeDebit: observation?.debit == null
        ? null
        : {
          totalLamports: observation.debit.totalLamports,
          messageFeeLamports: observation.debit.messageFeeLamports,
          walletPaidLamports: observation.debit.attributedLamports,
          followUpReserveLamports: observation.debit.followUpReserveLamports,
        },
      // Frozen atoms are HELD and unspendable. Reporting them is what stops an
      // agent reading `insufficient_balance` as "the tokens are gone".
      ...(observation?.splSource
        ? {
          sourceSpendability: {
            spendableAmountRaw: observation.splSource.spendableAmountRaw,
            frozenAmountRaw: observation.splSource.frozenAmountRaw,
            tokenAccounts: observation.splSource.accountCount,
          },
        }
        : {}),
    }),
    // PRIVATE channel to the prequote recorder - never model-visible.
    quoteAuthority: {
      eligibilityKind: eligibility.kind,
      // Jupiter records no claimable route snapshot: its execute re-builds
      // through `/build` and revalidates the fee policy instead. The common
      // gate is what gives an ineligible row its teeth here.
      routeSnapshot: null,
      ...(judged.preview ? { spendability: judged.preview } : {}),
    },
  };
};

/**
 * The ROUTE half of the verdict.
 *
 * Jupiter states an impact fraction and no USD legs, so the measured-impact
 * classifier is the right owner - but this lane deliberately keeps its own
 * ceiling behaviour unchanged: an impact-based refusal for Jupiter would be a
 * new money policy, and this work package adds spendability only. A missing or
 * unreadable impact is therefore not scored, never silently read as zero risk
 * by anything downstream: the agent still receives `priceImpactFraction` itself.
 */
function jupiterRouteEligibility(priceImpactFraction: string | null): QuoteEligibility {
  const fraction = priceImpactFraction === null ? Number.NaN : Number(priceImpactFraction);
  const measured = Number.isFinite(fraction) ? classifyMeasuredImpact(fraction) : null;
  return measured !== null && isExecutable(measured)
    ? measured
    : { kind: "executable", priceImpactFraction: 0, adverse: false };
}

/** One sentence for the agent when the wallet, not the route, is the problem. */
function ineligibilityNote(eligibility: QuoteEligibility): string {
  switch (eligibility.kind) {
    case "insufficient_balance":
      return ` NOT EXECUTABLE: the wallet holds ${formatShortfall(eligibility.current)} spendable of the`
        + ` ${formatShortfall(eligibility.required)} this swap needs (short ${formatShortfall(eligibility.missing)}).`
        + " Frozen token accounts are not spendable. This quote authorizes nothing.";
    case "gas_reserve_insufficient":
      return ` NOT EXECUTABLE: this swap's full native cost is ${formatShortfall(eligibility.required)} lamports`
        + " (network and priority fee, tip, account rent and a measured follow-up reserve included) and the wallet holds"
        + ` ${formatShortfall(eligibility.current)} (short ${formatShortfall(eligibility.missing)}). This quote authorizes nothing.`;
    case "balance_unavailable":
      return ` NOT EXECUTABLE: the wallet's balance for this swap could not be read (${eligibility.cause}),`
        + " so Vex refuses to treat it as funded. This quote authorizes nothing.";
    default:
      return "";
  }
}
