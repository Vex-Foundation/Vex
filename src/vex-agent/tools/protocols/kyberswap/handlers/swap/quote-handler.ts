/**
 * `kyberswap.swap.quote` - the read-only route probe. It signs nothing and
 * records nothing; its two jobs are seeding the prequote the execute is matched
 * against, and surfacing token danger the agent would otherwise not see.
 */

import { getKyberAggregatorClient } from "@tools/kyberswap/aggregator/client.js";
import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { resolveTokenMetadataStrict, requireFeature, type ResolvedKyberTokenMetadata } from "@tools/kyberswap/helpers.js";
import { annotateNativeSymbol } from "@tools/evm-chains/native-currency.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { parseUnits } from "viem";
import { formatRawAmount } from "../../../amount-display.js";
import { formatRouteSummary } from "../../helpers.js";
import type { ProtocolHandler } from "../../../types.js";
import { str, ok, fail } from "../../../handler-helpers.js";
import { kyberFailureMessage } from "./error-output.js";
import { negativePriceImpactNote } from "../../../price-impact-note.js";
import { canonicalWrapPairRefusal } from "../../../wrap-pair-refusal.js";
import { venueFallbackNoteOnFailure } from "./fallback-messaging.js";
import { resolveKyberSlippageBps } from "./slippage.js";
import { resolveQuoteSafetyLeg, type QuoteSafety, type QuoteSafetyLeg } from "./quote-safety.js";
import { VEX_INTEGRATOR_FEE_ROUTE_PARAMS, type KyberGetRouteResponse } from "./route-request.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";
import { PREQUOTE_MAX_AGE_MS } from "../../../prequote/registry.js";
import { evmQuoteSafetyVerdict } from "../../../prequote/safety/extract/kyberswap.js";
import {
  classifyQuoteEligibility,
  type QuoteEligibility,
} from "../../../quote-authority/eligibility.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
  type RouteSnapshot,
} from "../../../quote-authority/snapshot.js";

/**
 * The human spelling of a raw base-unit amount for the summary string only -
 * `routeSummary.amountOut` keeps the raw value. Falls back to the input when
 * it is not an integer string (a display fallback must never throw a quote).
 * The conversion is owned by `protocols/amount-display.ts`.
 */
function humanizeAmountOut(amountOutRaw: string, decimals: number): string {
  return formatRawAmount(amountOutRaw, decimals) ?? amountOutRaw;
}

/**
 * The agent-facing consequence of an eligibility verdict. Every sentence names
 * the REAL provider fact and a next step - a quote that cannot authorize an
 * execute must say so in the same breath as the route it just showed, or the
 * agent reads the numbers as an offer.
 */
function eligibilityNote(eligibility: QuoteEligibility, slug: string, wrapPairRefusal: string | null): string {
  switch (eligibility.kind) {
    case "executable":
      return eligibility.adverse
        ? ` This quote gives up ${(eligibility.priceImpactFraction * 100).toFixed(2)}% of the input's reference value; it is still executable.`
        : "";
    case "unpriceable_output":
      return " KyberSwap priced the input but returned no USD value for the output, so the size of this trade cannot be checked against a reference price."
        + " This quote does NOT authorize an execute. Price the output token with a market read first, or trade a pair the aggregator can price.";
    case "excessive_impact":
      return ` This route gives up ${(eligibility.priceImpactFraction * 100).toFixed(2)}% of the input's reference value, at or above the ${(eligibility.ceilingFraction * 100).toFixed(0)}% ceiling.`
        + " This quote does NOT authorize an execute. Trade a smaller size or use a deeper pair.";
    case "oversize_snapshot":
      return ` The route KyberSwap returned is ${eligibility.measuredBytes} bytes, above the ${eligibility.limitBytes}-byte snapshot bound, so it cannot be stored verbatim for a later execute.`
        + " This quote does NOT authorize an execute. Trade a smaller size or restrict the route to fewer sources.";
    case "provider_usd_invalid":
      return ` KyberSwap returned no usable USD value for the ${eligibility.leg === "both" ? "input or the output" : eligibility.leg} of this trade on ${slug}.`
        + (wrapPairRefusal !== null
          ? ` ${wrapPairRefusal}`
          : " This quote does NOT authorize an execute. Request a fresh quote, or price this pair with a market read first.");
  }
}

export const quoteHandler: ProtocolHandler = async (p, context) => {
  const chain = str(p, "chain"), tokenInRaw = str(p, "tokenIn"), tokenOutRaw = str(p, "tokenOut"), amountInRaw = str(p, "amountIn");
  if (!chain || !tokenInRaw || !tokenOutRaw || !amountInRaw) return fail("Missing required: chain, tokenIn, tokenOut, amountIn");

  // Rejected HERE, not only at the execute: this quote seeds the prequote
  // the execute is matched against, and `slippageBps` is part of that
  // identity - so a tolerance the execute would refuse must never produce a
  // quote that appears to authorize it.
  const quoteSlippage = resolveKyberSlippageBps("kyberswap.swap.quote", p);
  if (!quoteSlippage.ok) return fail(quoteSlippage.reason);

  let slug: KyberChainSlug;
  let chainId: number;
  try {
    slug = resolveChainSlug(chain);
    requireFeature(slug, "aggregator");
    chainId = slugToChainId(slug);
  } catch (err) {
    const fallbackNote = venueFallbackNoteOnFailure(err, context.sessionId, false);
    return fail(`kyberswap__swap_quote failed: ${kyberFailureMessage("kyberswap__swap_quote", err)}.${fallbackNote}`);
  }

  let tokenIn: ResolvedKyberTokenMetadata;
  let tokenOut: ResolvedKyberTokenMetadata;
  try {
    // Strict: address-only (+ native sentinel/keyword) - symbols are NOT
    // resolved via Kyber's DEX search here. A symbol like "USDC" can match the
    // wrong contract (e.g. axlUSDC) and seed a prequote for the wrong token, so
    // the quote resolution is symmetric with execute (resolveTokenMetadataStrict)
    // and EVM symbols must be resolved with TokenFind first.
    tokenIn = await resolveTokenMetadataStrict(tokenInRaw, chainId);
    tokenOut = await resolveTokenMetadataStrict(tokenOutRaw, chainId);
  } catch (err) {
    return fail(`kyberswap__swap_quote failed: ${kyberFailureMessage("kyberswap__swap_quote", err)}`);
  }
  // Agent-facing labels only. A native leg's `symbol` is the chain-agnostic
  // `NATIVE` sentinel, which tells the agent nothing about what it is trading;
  // these annotate it with the chain's real ticker (`NATIVE (ETH)`), degrading
  // to the bare sentinel when the chain cannot be resolved. `tokenIn.symbol`
  // itself stays canonical - it is what gets persisted and matched on.
  const tokenInLabel = annotateNativeSymbol(tokenIn.symbol, chainId);
  const tokenOutLabel = annotateNativeSymbol(tokenOut.symbol, chainId);
  const amountIn = parseUnits(amountInRaw, tokenIn.decimals).toString();

  let response: KyberGetRouteResponse;
  let safetyIn: QuoteSafetyLeg;
  let safetyOut: QuoteSafetyLeg;
  try {
    [response, safetyIn, safetyOut] = await Promise.all([
      getKyberAggregatorClient().getRoute(slug, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS,
      }),
      resolveQuoteSafetyLeg(chainId, tokenIn),
      resolveQuoteSafetyLeg(chainId, tokenOut),
    ]);
  } catch (err) {
    const fallbackNote = venueFallbackNoteOnFailure(err, context.sessionId, true);
    return fail(`kyberswap__swap_quote failed: ${kyberFailureMessage("kyberswap__swap_quote", err)}.${fallbackNote}`);
  }
  const safety: QuoteSafety = { tokenIn: safetyIn, tokenOut: safetyOut };
  const summaryRaw = response.data.routeSummary;
  const route = formatRouteSummary(summaryRaw);

  // The snapshot is encoded BEFORE eligibility is classified, because a route
  // we cannot store verbatim cannot authorize an execute whatever its price
  // says - `encodeRouteSnapshotRaw` never throws, so an unstorable route still
  // answers the agent with the full route it fetched.
  const encoded = encodeRouteSnapshotRaw(summaryRaw);
  const eligibility = classifyQuoteEligibility({
    amountInUsd: summaryRaw.amountInUsd,
    amountOutUsd: summaryRaw.amountOutUsd,
    ...(encoded.ok
      ? {}
      : { snapshotOversize: { measuredBytes: encoded.measuredBytes, limitBytes: encoded.limitBytes } }),
  });

  // The floor the execute will hold the built calldata to, derived ONCE, here,
  // from the output this answer shows. The execute never recomputes it from a
  // fresher route - that rederivation is the 2026-08-27 incident.
  const approvedMinOutRaw = computeApprovedMinOut(summaryRaw.amountOut, quoteSlippage.bps).toString();
  const snapshot: RouteSnapshot | null = encoded.ok && eligibility.kind === "executable"
    ? {
        v: ROUTE_SNAPSHOT_VERSION,
        provider: "kyberswap",
        raw: encoded.raw,
        digest: encoded.digest,
        approvedAmountOutRaw: summaryRaw.amountOut,
        approvedMinOutRaw,
        approvedAmountOutHuman: humanizeAmountOut(summaryRaw.amountOut, tokenOut.decimals),
        approvedMinOutHuman: humanizeAmountOut(approvedMinOutRaw, tokenOut.decimals),
        tokenOutSymbol: tokenOutLabel,
        effectiveSlippageBps: quoteSlippage.bps,
        // Display/audit copy of the row's own TTL. `swap_prequotes.expires_at`
        // written by the recorder is the AUTHORITY the claim reads; these two
        // differ by the recorder's own latency and nothing decides on this one.
        expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
        eligibility,
      }
    : null;

  // The CANONICAL wrap pair, not merely "one leg is native" - that earlier
  // predicate was true of most trades this venue quotes, so an ordinary
  // unpriceable native trade was being told to go and wrap. Identity is the
  // verified wrapped-native contract for this chain.
  const wrapPairRefusal = canonicalWrapPairRefusal(
    chainId, tokenIn, tokenOut, "kyberswap__swap_quote",
  );
  const note = eligibilityNote(eligibility, slug, wrapPairRefusal);

  // Output-polish (plan §4.2): compact human summary FIRST, machine fields
  // after - as one JSON key ordering, not a free-text prefix, so `output`
  // stays parseable (every tool in this codebase returns JSON via `ok()`,
  // and downstream tests/consumers rely on `JSON.parse(result.output)`).
  //
  // The summary's amountOut is HUMAN units (2026-07-30): a live session showed
  // a weaker model copying the raw base-unit figure from this string into its
  // user-facing reply ("~1926791258702869954560 VEX"). The raw value stays
  // untouched in `routeSummary.amountOut` - machines read that; this string is
  // the human/agent layer. Falls back to raw if the provider ever returns a
  // non-integer string, rather than failing the quote over a display detail.
  const summary =
    `Quote: ${amountInRaw} ${tokenInLabel} → ~${humanizeAmountOut(route.amountOut, tokenOut.decimals)} ${tokenOutLabel} `
    + `(~$${route.amountOutUsd} est.) on ${slug}. Gas ~$${route.gasUsd} est.`
    // On an L2 the L1 data fee can rival or exceed execution gas - quoting
    // only `gasUsd` understated the real cost of the trade.
    + (route.l1FeeUsd !== null ? ` L1 data fee ~$${route.l1FeeUsd} est.` : "")
    + (route.priceImpact !== null ? ` Price impact ${(route.priceImpact * 100).toFixed(2)}%.` : "")
    // Display-only annotation: a negative impact means the quoted output is
    // priced above the reference input value, which reads as free money to an
    // agent that has not re-derived the formula. The number, the threshold
    // behavior and `routeSummary` are untouched.
    + negativePriceImpactNote(route.priceImpact)
    + note;

  // The REAL safety verdict, on the ineligible path too. It used to be hardcoded
  // `unknown` here, so a CONFIRMED honeypot on an unpriceable, oversize or
  // excessively-impactful quote was persisted as unaudited: the gate's fresh-fail
  // guardrail then had nothing to dominate with, and the same token could be
  // re-quoted into a `pass`. Eligibility decides whether a quote may AUTHORIZE an
  // execute; it says nothing about whether the token is a scam, and the two must
  // not be collapsed. Computed by the recorder's own leg function so this verdict
  // and the one an eligible quote records cannot drift apart.
  const safetyLegs = evmQuoteSafetyVerdict(safety);
  const identity = {
    chainId,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amount: amountInRaw,
    slippageBps: typeof p.slippageBps === "number" ? p.slippageBps : null,
    safetyVerdict: safetyLegs?.verdict ?? ("unknown" as const),
    // The eligibility rides ALONGSIDE the safety legs, never instead of them:
    // the disclosure channels the approval card reads (fee-on-transfer tax,
    // term lock) are sourced from this same stored block.
    safetyDetail: { ...(safetyLegs?.safetyDetail ?? {}), eligibility: { kind: eligibility.kind } },
  };

  // A provider-shape refusal is a FAILED quote: the model must not read a
  // priced offer out of an answer whose prices the provider did not state. It
  // still hands the recorder a superseding ineligible marker, so an older
  // priced quote for this identity stops being claimable at the same instant.
  if (eligibility.kind === "provider_usd_invalid") {
    return {
      success: false,
      output: `kyberswap__swap_quote refused this route.${note}`,
      quoteAuthority: {
        eligibilityKind: eligibility.kind,
        routeSnapshot: null,
        ineligibleIdentity: identity,
      },
    };
  }

  return {
    ...ok({
      summary,
      chain: slug, chainId,
      tokenIn: { address: tokenIn.address, symbol: tokenInLabel, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOutLabel, decimals: tokenOut.decimals },
      routeSummary: route,
      routerAddress: response.data.routerAddress,
      safety,
      // The agent sees WHY, in the same object as the route. The snapshot
      // itself never appears here: it rides the private `quoteAuthority`
      // channel to the recorder and nowhere else.
      eligibility: eligibility.kind === "executable"
        ? { kind: eligibility.kind, adverse: eligibility.adverse, executable: true }
        : { kind: eligibility.kind, executable: false },
      approvedMinOut: {
        amountRaw: approvedMinOutRaw,
        amountHuman: humanizeAmountOut(approvedMinOutRaw, tokenOut.decimals),
        slippageBps: quoteSlippage.bps,
      },
    }),
    quoteAuthority: {
      eligibilityKind: eligibility.kind,
      routeSnapshot: snapshot === null ? null : { ...snapshot },
      ...(snapshot === null ? { ineligibleIdentity: identity } : {}),
    },
  };
};
