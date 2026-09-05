/**
 * Request adaptation for the Relay bridge handlers: turning the untrusted
 * caller params into the ONE resolved `RelayLegs` both handlers share, and
 * turning that into the provider request, the durable route key, the step
 * summary, and the health-failure sentence.
 *
 * Extracted verbatim from `../bridge.ts` as part of a façade-preserving
 * structural split (SPEC wave 0R.2). `../bridge.ts` remains the public entry
 * point.
 */

import { resolveRelayChainId, toRelayCurrency } from "@tools/relay/chains.js";
import type { RelayRouteHealth } from "@tools/relay/health.js";
import {
  evaluateEvmBridgeFeeEligibility,
  splitBridgeAmountForFee,
  type BridgeFeeSplit,
} from "@tools/bridge-fee/index.js";
import type { RelayChain, RelayQuoteRequest, RelayQuoteResponse, RelayTradeType } from "@tools/relay/types.js";
import type { BridgeRouteEndpoints } from "@vex-agent/db/repos/agent-activity.js";
import { resolveRelaySlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";
import { str } from "../../../handler-helpers.js";
import { BRIDGE_FAMILY, BRIDGE_TOOL_ID } from "./constants.js";

export interface RelayLegs {
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  /**
   * The amount Relay is quoted for and deposits: the caller's `amountRaw` MINUS
   * the Vex fee (`@tools/bridge-fee`), so `amountOut` is what the user
   * actually receives. Equal to `requestedAmount` when no fee is taken.
   */
  amount: string;
  /** The caller's `amountRaw` verbatim - the TOTAL debited across all legs. */
  requestedAmount: string;
  feeSplit: BridgeFeeSplit;
  /** Non-null when no fee is taken; the plain-language reason, disclosed to the agent. */
  feeSkipReason: string | null;
  tradeType: RelayTradeType;
  /**
   * The EFFECTIVE slippage tolerance, always a number and always sent (W4a):
   * the caller's value, or `VEX_DEFAULT_SLIPPAGE_BPS` when it was omitted.
   * Relay auto-computes a tolerance when none is sent, and the provider must
   * not own Vex's price protection. Resolved ONCE in `resolveLegs` so the quote
   * and the execute cannot disagree, and so the value that reaches the provider
   * is the same one the prequote identity bound.
   */
  slippageBps: number;
}

/** Distinct tx chainIds per step - the structural shape the prequote recorder re-validates. */
export function stepSummaries(quote: RelayQuoteResponse): Array<{ id: string; kind: string; chainIds: number[] }> {
  return quote.steps.map((step) => {
    const chainIds = new Set<number>();
    for (const item of step.items) {
      if (item.data) chainIds.add(item.data.chainId);
    }
    return { id: step.id, kind: step.kind, chainIds: [...chainIds] };
  });
}

/**
 * Both callers route this function's throws through `summarizeProtocolError`.
 * The text is locally authored, but `resolveRelayChainId`/`toRelayCurrency`
 * echo the MODEL-SUPPLIED `fromChain`/`toChain`/token values verbatim
 * (`Relay does not support chain "<input>".`), so a model-injected URL or
 * key-shaped string would otherwise reach tool output unredacted - untrusted
 * input at an output sink.
 */
export async function resolveLegs(
  params: Record<string, unknown>,
  chains: readonly RelayChain[],
): Promise<RelayLegs> {
  const fromChain = str(params, "fromChain"), toChain = str(params, "toChain");
  const fromToken = str(params, "fromToken"), toToken = str(params, "toToken");
  const amount = str(params, "amountRaw");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    throw new Error("Missing required: fromChain, fromToken, toChain, toToken, amountRaw");
  }
  // Widened trade type (W2/R10): pass EXPECTED_OUTPUT through when the user asks
  // for it (Relay's recommended plain-bridge mode); default stays EXACT_INPUT so
  // `amountRaw` reads as the source amount and the prequote identity (same
  // default) still collides.
  const tradeTypeRaw = str(params, "tradeType");
  const tradeType: RelayTradeType =
    tradeTypeRaw === "EXACT_OUTPUT" ? "EXACT_OUTPUT"
    : tradeTypeRaw === "EXPECTED_OUTPUT" ? "EXPECTED_OUTPUT"
    : "EXACT_INPUT";
  const originChainId = resolveRelayChainId(fromChain, chains);
  const originCurrency = toRelayCurrency(fromToken);

  // Vex integrator fee (`@tools/bridge-fee`) - resolved HERE so the quote
  // handler and the execute handler can never disagree about what Relay was
  // asked for. Relay is quoted for the POST-fee amount; the fee leaves later,
  // as Vex's own transfer, only if the deposit actually lands.
  const feeSplit = splitBridgeAmountForFee(amount);
  let feeSkipReason: string | null = feeSplit.charged
    ? null
    : "25 bps of the requested amount floors to 0 in smallest units";
  if (feeSplit.charged) {
    const eligibility = await evaluateEvmBridgeFeeEligibility(originChainId, originCurrency);
    if (!eligibility.charge) feeSkipReason = eligibility.reason;
  }

  return {
    originChainId,
    destinationChainId: resolveRelayChainId(toChain, chains),
    originCurrency,
    destinationCurrency: toRelayCurrency(toToken),
    amount: (feeSkipReason === null ? feeSplit.bridgedRaw : feeSplit.totalRaw).toString(),
    requestedAmount: feeSplit.totalRaw.toString(),
    feeSplit,
    feeSkipReason,
    tradeType,
    slippageBps: resolveSlippageBps(params),
  };
}

/**
 * Resolve the (untrusted) `slippageBps` param before it can reach Relay.
 *
 * Delegates to the ONE shared resolver the prequote identity
 * (`prequote/identity/relay-bridge.ts`) also calls, so Vex's ceiling applies on
 * both lanes and the value the gate bound is the value the provider receives.
 * Omitted → `VEX_DEFAULT_SLIPPAGE_BPS`, sent EXPLICITLY (W4a). Invalid or
 * over-ceiling → throw, which both callers already surface as a clean
 * `fail(...)` before any quote or signing.
 */
function resolveSlippageBps(params: Record<string, unknown>): number {
  const resolved = resolveRelaySlippageBps(
    `Parameter "slippageBps" for ${BRIDGE_TOOL_ID}`,
    params.slippageBps,
  );
  if (!resolved.ok) throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, resolved.reason);
  return resolved.bps;
}

/**
 * The outbound Relay quote request.
 *
 * `user` is the session's selected EVM wallet, and it is BOTH the source and -
 * because Relay v1 is EVM-only - the destination and the refund address. None
 * of the three is read from params: a destination a model can choose is a
 * destination an injection can choose (bridge-destination policy in
 * `@tools/khalani/request.js`), and both handlers reject a supplied `recipient`
 * by name before this builder is reached.
 */
export function buildRequest(legs: RelayLegs, user: string): RelayQuoteRequest {
  // DERIVED, never read from params - the destination is the selected wallet.
  const recipient = user;
  // DERIVED, never read from params - the same refund-destination policy the
  // Khalani path applies (`@tools/khalani/request.js`). `refundTo` decides where
  // funds land when a bridge FAILS and is absent from the approval preview's
  // allowlist, so a model-chosen value would redirect a refund with no human
  // ever seeing it. `user` is the resolved source wallet: the money goes back
  // where it came from, which needs no authorization. Callers that supply the
  // key are rejected by name upstream.
  const refundTo = user;
  // The VALIDATED value from `resolveLegs`, never the raw param - this is the
  // last hop before the provider, and it must carry exactly what the prequote
  // identity bound. ALWAYS sent (W4a): omitting it lets Relay auto-compute the
  // tolerance, which would hand our price protection to the provider.
  const slippage = String(legs.slippageBps);
  return {
    user,
    recipient,
    refundTo,
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    originCurrency: legs.originCurrency,
    destinationCurrency: legs.destinationCurrency,
    amount: legs.amount,
    tradeType: legs.tradeType,
    slippageTolerance: slippage,
  };
}

/**
 * The route endpoints, built from the SAME (chainId, family, toRelayCurrency)
 * tuples W5's `resolveRelayRevealRoute` uses (key-consistency contract) - so the
 * stored `normalized_route` round-trips with the reveal key and W4's
 * `clearRelayRouteReveal` hits. Diverging would only fail closed (the reveal
 * never applies), never over-grant.
 */
export function buildRoute(legs: RelayLegs): BridgeRouteEndpoints {
  return {
    fromChainId: legs.originChainId,
    fromChainFamily: BRIDGE_FAMILY,
    fromToken: legs.originCurrency,
    toChainId: legs.destinationChainId,
    toChainFamily: BRIDGE_FAMILY,
    toToken: legs.destinationCurrency,
  };
}

export function healthFailureReason(health: Extract<RelayRouteHealth, { serviceable: false }>): string {
  const side = health.failedSide === "origin" ? "origin" : "destination";
  const reasons: Record<string, string> = {
    chain_not_found: `the ${side} chain (${health.chainId}) is not in Relay's live chain registry`,
    vm_type_not_evm: `the ${side} chain (${health.chainId}) is not an EVM chain (out of scope this phase)`,
    deposit_not_enabled: `deposits are not currently enabled on the ${side} chain (${health.chainId})`,
    chain_disabled: `the ${side} chain (${health.chainId}) is currently disabled on Relay`,
  };
  return `Relay cannot service this route: ${reasons[health.reason] ?? `the ${side} chain is unavailable`}.`;
}
