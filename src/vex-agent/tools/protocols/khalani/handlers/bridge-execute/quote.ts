/**
 * `khalani.bridge` quote stage (steps 3–5 of the staged-execute contract,
 * split out in 0R.4, refactor-only): prepare the provider request, split the
 * Vex integrator fee BEFORE the quote, select the route, and enforce the
 * quote's freshness. Nothing here signs or records anything beyond the
 * pre-sign failure rows `failPreSign` owns.
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import { resolveRouteBestIndex } from "@tools/khalani/helpers.js";
import { prepareQuoteRequest, type PreparedQuoteRequest } from "@tools/khalani/request.js";
import { classifyKhalaniQuoteResponse } from "@tools/khalani/quote-result.js";
import type { QuoteRoute } from "@tools/khalani/types.js";
import {
  evaluateEvmBridgeFeeEligibility,
  splitBridgeAmountForFee,
  type BridgeFeeSplit,
} from "@tools/bridge-fee/index.js";
import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import { VexError } from "../../../../../../errors.js";
import type { ToolResult } from "../../../../types.js";
import { khalaniRouteExpiryUnixSeconds } from "../../projectors.js";
import { khalaniFailureMessage } from "../bridge-support.js";
import type { FailPreSign } from "./types.js";

export interface KhalaniQuoteInput {
  readonly fromChain: string;
  readonly toChain: string;
  readonly fromToken: string;
  readonly toToken: string;
  readonly amount: string;
  readonly tradeType: string | undefined;
  readonly filler: string | undefined;
  readonly fromAddress: string;
  readonly recipient: string;
  readonly fromChainId: number;
  readonly fromFamily: BridgeChainFamily;
  readonly routeIdParam: string;
}

export interface KhalaniQuotedRoute {
  readonly outcome: "quoted";
  readonly prepared: PreparedQuoteRequest;
  readonly feeSplit: BridgeFeeSplit;
  readonly chargeFee: boolean;
  readonly feeSkipReason: string | null;
  /** The amount the venue was actually quoted for (bridged, i.e. fee already split off). */
  readonly quotedAmountRaw: string;
  readonly quoteId: string;
  readonly selectedRoute: QuoteRoute;
}

export type KhalaniQuoteOutcome =
  | { readonly outcome: "failed"; readonly result: ToolResult }
  | KhalaniQuotedRoute;

export async function quoteKhalaniBridgeRoute(
  input: KhalaniQuoteInput,
  failPreSign: FailPreSign,
): Promise<KhalaniQuoteOutcome> {
  const { fromChain, toChain, fromToken, toToken, amount, fromChainId, fromFamily, routeIdParam } = input;

  // 3. Prepare the quote request (normalizes addresses, parses hex amounts).
  let prepared: PreparedQuoteRequest;
  try {
    prepared = await prepareQuoteRequest({
      fromChain, fromToken, toChain, toToken, amount,
      tradeType: input.tradeType,
      fromAddress: input.fromAddress, recipient: input.recipient,
      // No `refundTo`: `prepareQuoteRequest` derives it from `fromAddress`
      // (refund-destination policy in `@tools/khalani/request.js`).
      filler: input.filler,
    });
  } catch (err) {
    return { outcome: "failed", result: await failPreSign("bridge_failed", khalaniFailureMessage(err)) };
  }

  // 3b. Vex integrator fee (`@tools/bridge-fee`) — split BEFORE the quote so
  // the venue prices the amount it will actually receive and the `amountOut`
  // the agent is shown is what the user actually gets. `params.amountRaw` stays
  // the TOTAL debited (Kyber/Jupiter `currency_in` parity); the fee leaves as
  // Vex's own transfer AFTER the deposit confirms.
  let feeSplit: BridgeFeeSplit;
  try {
    feeSplit = splitBridgeAmountForFee(prepared.request.amount);
  } catch (err) {
    return { outcome: "failed", result: await failPreSign("bridge_failed", khalaniFailureMessage(err)) };
  }
  // A token Vex declines to skim (fee-on-transfer / honeypot) must be settled
  // HERE: skipping the fee changes the amount the venue is quoted for, so it
  // cannot be discovered at broadcast time.
  let feeSkipReason: string | null = feeSplit.charged
    ? null
    : "25 bps of the requested amount floors to 0 in smallest units";
  if (feeSplit.charged && fromFamily === "eip155") {
    const eligibility = await evaluateEvmBridgeFeeEligibility(fromChainId, fromToken);
    if (!eligibility.charge) feeSkipReason = eligibility.reason;
  }
  const chargeFee = feeSkipReason === null;
  const quotedAmountRaw = (chargeFee ? feeSplit.bridgedRaw : feeSplit.totalRaw).toString();

  // 4. Quote (plain). Empty routes[] is Khalani's canonical no-route signal.
  let selectedRoute: QuoteRoute;
  let quoteId: string;
  try {
    const quoteResponse = await getKhalaniClient().getQuotes(
      { ...prepared.request, amount: quotedAmountRaw },
      routeIdParam ? { routes: [routeIdParam] } : undefined,
    );
    const outcome = classifyKhalaniQuoteResponse(quoteResponse);
    if (outcome.outcome === "no_route") {
      return {
        outcome: "failed",
        result: await failPreSign("route_not_found", "Khalani returned no route for this pair", { kind: "empty_routes" }),
      };
    }
    quoteId = outcome.quoteId;
    if (routeIdParam) {
      const found = outcome.routes.find((r) => r.routeId === routeIdParam);
      if (!found) {
        return { outcome: "failed", result: await failPreSign("route_not_found", `Route ${routeIdParam} not found in quote`) };
      }
      selectedRoute = found;
    } else {
      selectedRoute = outcome.routes[resolveRouteBestIndex(outcome.routes)]!;
    }
  } catch (err) {
    const externalName = err instanceof VexError ? err.externalName : undefined;
    return {
      outcome: "failed",
      result: await failPreSign("bridge_failed", khalaniFailureMessage(err), { kind: "exception", externalName }),
    };
  }

  // 5. Freshness. The rule (quoteExpiresAt, else validBefore, non-positive =
  // none) has ONE owner — `khalaniRouteExpiryUnixSeconds` — shared with the
  // quote/dryRun previews, so what the agent is SHOWN is what is ENFORCED.
  const expiresAt = khalaniRouteExpiryUnixSeconds(selectedRoute);
  if (expiresAt !== null && Date.now() >= expiresAt * 1000) {
    return {
      outcome: "failed",
      result: await failPreSign("deadline_expired", "Quote has expired — re-request a fresh quote"),
    };
  }

  return { outcome: "quoted", prepared, feeSplit, chargeFee, feeSkipReason, quotedAmountRaw, quoteId, selectedRoute };
}
