/**
 * `bridge.ts` — the `khalani.bridge` staged-execute handler body, split out
 * (Card C5, move-only) once the parent file crossed the repo's 500-line
 * cap. See `bridge.ts`'s own module doc for the full staged-execute
 * contract (Phase-2 W3a; plan R2/R4/R5/R14-Q2/R15/C1/C2) this function
 * implements end to end (the 16 numbered steps below are unchanged from the
 * original single-file version).
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import {
  getCachedKhalaniChains,
  getChain,
  getChainFamily,
} from "@tools/khalani/chains.js";
import { resolveRouteBestIndex } from "@tools/khalani/helpers.js";
import { findCallerSuppliedForbiddenParam, prepareQuoteRequest } from "@tools/khalani/request.js";
import { resolveKhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import { classifyKhalaniQuoteResponse } from "@tools/khalani/quote-result.js";
import { pollKhalaniOrderToTerminal } from "@tools/khalani/order-status.js";
import {
  planKhalaniDepositLegs,
  signStageKhalaniLeg,
  type KhalaniStagedLeg,
} from "@tools/khalani/bridge-executor.js";
import {
  authorizeKhalaniPlanNativeValue,
  khalaniNativeValueRefusalReason,
  type KhalaniPlanNativeValue,
} from "@tools/khalani/deposit-native-value.js";
import {
  BRIDGE_FEE_RECEIVER_EVM,
  BRIDGE_FEE_RECEIVER_SOLANA,
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  evaluateEvmBridgeFeeEligibility,
  splitBridgeAmountForFee,
  type BridgeFeeDisclosure,
  type BridgeFeeSplit,
} from "@tools/bridge-fee/index.js";
import {
  DependentLegGasEstimateError,
  dependentLegEstimateGuidance,
  priorLegAnchorFrom,
  type ConfirmedPriorLeg,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";
import type { DepositMethod, DepositPlan, KhalaniChain, QuoteRoute } from "@tools/khalani/types.js";
import type { KhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import type { PreparedQuoteRequest } from "@tools/khalani/request.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { familyToInventory, walletAddressesEqual } from "@tools/wallet/inventory.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  createBridgeActivityIntent,
  createBridgePreBroadcastFailure,
  attachProviderOrderId,
  checkBridgeInFlight,
  markActivityBroadcast,
  markActivitySolanaBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
  type BridgeActivityLeg,
  type BridgeChainFamily,
  type BridgeExpectedFill,
  type BridgeRouteEndpoints,
} from "@vex-agent/db/repos/agent-activity.js";
import { type KhalaniFailureSignal } from "../failure-mapping.js";
import { khalaniRouteExpiryUnixSeconds, projectQuoteRoute } from "../projectors.js";
import { revealOnEligibleKhalaniFailure } from "./reveal.js";
import {
  estimateUsd,
  humanizeAmount,
  resolveKhalaniTokenInfo,
  KHALANI_TOKEN_PRICE_USD_SOURCE,
  type KhalaniTokenInfo,
} from "./bridge-usd.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { str } from "../../handler-helpers.js";
import logger from "@utils/logger.js";
import {
  abortRemaining,
  type AmountView,
  type BridgeVexFeeView,
  bridgeResult,
  fetchExistingOrderId,
  type VexFeeCollection,
  humanizeRouteType,
  inFlightResult,
  khalaniFailureMessage,
  type RecordedLeg,
  txExplorerUrl,
} from "./bridge-support.js";
import { interpretPoll } from "./bridge-poll.js";

const PROTOCOL = "khalani";
const NAMESPACE = "khalani";

/**
 * The native-cost block the dryRun preview carries. A preview that cannot show
 * the breakdown says so and says why — silence would read as "no native charge",
 * which is exactly the misreading that let an undisclosed 1e15 wei through.
 */
function nativeCostPreview(
  nativeCost: KhalaniPlanNativeValue | null,
  planUnavailable: boolean,
): Record<string, unknown> {
  if (nativeCost === null) {
    return {
      available: false,
      reason: planUnavailable
        ? "this deposit plan cannot be broadcast by Vex, so it has no signable legs to classify"
        : "the native-currency charges could not be verified on-chain this turn",
      note: "An execute would refuse rather than sign an unclassified native charge.",
    };
  }
  return {
    available: true,
    totalNativeOutflowWei: nativeCost.totalNativeOutflowWei,
    legs: nativeCost.disclosures,
    wouldRefuse: nativeCost.refusal !== null,
    refusal: nativeCost.refusal,
  };
}

export async function executeKhalaniBridge(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const toolId = "khalani.bridge";
  const fromChain = str(params, "fromChain");
  const toChain = str(params, "toChain");
  const fromToken = str(params, "fromToken");
  const toToken = str(params, "toToken");
  const amount = str(params, "amountRaw");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    return { success: false, output: "Missing required parameters: fromChain, toChain, fromToken, toToken, amountRaw" };
  }

  // Fee params AND the refund destination are never accepted from tool input
  // (see the two policy blocks in `@tools/khalani/request.js`). Rejected BY
  // NAME here — before any quote, recording, or signing — so an attempted
  // overcharge or refund redirection is loud on the direct `execute_tool` path
  // too, not silently stripped. The alias boundary rejects the same keys; this
  // is the second half of that pair.
  const forbiddenParam = findCallerSuppliedForbiddenParam(params);
  if (forbiddenParam !== null) {
    return {
      success: false,
      output: `${toolId} failed: ${forbiddenParam.param} is not an accepted parameter — ${forbiddenParam.reason} Remove it and retry.`,
    };
  }

  // A mutating protocol tool is prequote-gated, so a session is guaranteed
  // present; the recording contract needs it. Fail-closed if it is ever absent.
  const sessionId = context.sessionId;
  if (!sessionId) return { success: false, output: `${toolId} requires an active session.` };

  // 1. Pre-quote venue guard (R9) — decide the venue BEFORE any quote/build.
  let prequote: KhalaniPrequoteRoute;
  try {
    prequote = await resolveKhalaniPrequoteRoute(fromChain, toChain);
  } catch (err) {
    // Registry-fetch failure — transport, not a venue decision. Fail-closed.
    return { success: false, output: `${toolId} failed: ${khalaniFailureMessage(err)}` };
  }
  if (prequote.outcome === "static_relay") {
    return {
      success: false,
      output: `${toolId} failed: ${fromChain} → ${toChain} bridges via Relay, not Khalani — use the bridge tool (it routes local chains such as Robinhood to Relay automatically).`,
    };
  }
  if (prequote.outcome === "no_route") {
    // A nonlocal endpoint is not in Khalani's live registry — we cannot build a
    // coherent route record for an absent chain, so surface the Relay reveal +
    // fail WITHOUT a bridge row (the coherent-endpoints no-route records below).
    const revealSuffix = revealOnEligibleKhalaniFailure({ kind: "empty_routes" }, sessionId, params);
    return {
      success: false,
      output: `${toolId} failed: Khalani has no route (${prequote.missing.join(", ")} chain not in the live registry).${revealSuffix}`,
    };
  }

  // prequote.outcome === "khalani": both endpoints are Khalani-serviceable.
  const { fromChainId, toChainId } = prequote;
  const chains = await getCachedKhalaniChains();
  const fromFamily: BridgeChainFamily = getChainFamily(fromChainId, chains);
  const toFamily: BridgeChainFamily = getChainFamily(toChainId, chains);
  const fromChainName = getChain(fromChainId, chains).name;
  const toChainName = getChain(toChainId, chains).name;

  // 2. Source/recipient wallet scope (fail-closed, before quote + signing).
  const explicitFrom = str(params, "fromAddress") || undefined;
  let fromAddress: string;
  try {
    fromAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, fromFamily);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (
    context.walletResolution.source === "session" && explicitFrom
    && !walletAddressesEqual(familyToInventory(fromFamily), explicitFrom, fromAddress)
  ) {
    return { success: false, output: "The provided fromAddress does not match the session's selected wallet for the source chain." };
  }
  const explicitRecipient = str(params, "recipient") || undefined;
  let recipient: string;
  try {
    recipient = explicitRecipient ?? resolveSelectedAddress(context.walletResolution, context.walletPolicy, toFamily);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const route: BridgeRouteEndpoints = {
    fromChainId, fromChainSlug: fromChainName, fromChainFamily: fromFamily, fromToken,
    toChainId, toChainSlug: toChainName, toChainFamily: toFamily, toToken,
  };

  // Helper: a mutating attempt that fails BEFORE signing → hashless failed row.
  const failPreSign = async (
    failureCode: AgentActivityFailureCode,
    reason: string,
    revealSignal?: KhalaniFailureSignal,
  ): Promise<ToolResult> => {
    const { executionId } = await createBridgePreBroadcastFailure({
      toolId, namespace: NAMESPACE, protocol: PROTOCOL, intentParams: params,
      walletAddress: fromAddress, sessionId, route,
      tokenIn: { tokenAddress: fromToken }, tokenOut: { tokenAddress: toToken },
      failureCode, failureReason: reason,
    });
    const revealSuffix = revealSignal ? revealOnEligibleKhalaniFailure(revealSignal, sessionId, params) : "";
    return { success: false, output: `${toolId} failed: ${reason}.${revealSuffix}`, data: { _executionId: executionId } };
  };

  // 3. Prepare the quote request (normalizes addresses, parses hex amounts).
  let prepared: PreparedQuoteRequest;
  try {
    prepared = await prepareQuoteRequest({
      fromChain, fromToken, toChain, toToken, amount,
      tradeType: str(params, "tradeType") || undefined,
      fromAddress, recipient,
      // No `refundTo`: `prepareQuoteRequest` derives it from `fromAddress`
      // (refund-destination policy in `@tools/khalani/request.js`).
      filler: str(params, "filler") || undefined,
    });
  } catch (err) {
    return failPreSign("bridge_failed", khalaniFailureMessage(err));
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
    return failPreSign("bridge_failed", khalaniFailureMessage(err));
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
  const quoteRequest = {
    ...prepared.request,
    amount: (chargeFee ? feeSplit.bridgedRaw : feeSplit.totalRaw).toString(),
  };

  // 4. Quote (plain). Empty routes[] is Khalani's canonical no-route signal.
  const routeIdParam = str(params, "routeId");
  let selectedRoute: QuoteRoute;
  let quoteId: string;
  try {
    const quoteResponse = await getKhalaniClient().getQuotes(
      quoteRequest,
      routeIdParam ? { routes: [routeIdParam] } : undefined,
    );
    const outcome = classifyKhalaniQuoteResponse(quoteResponse);
    if (outcome.outcome === "no_route") {
      return failPreSign("route_not_found", "Khalani returned no route for this pair", { kind: "empty_routes" });
    }
    quoteId = outcome.quoteId;
    if (routeIdParam) {
      const found = outcome.routes.find((r) => r.routeId === routeIdParam);
      if (!found) return failPreSign("route_not_found", `Route ${routeIdParam} not found in quote`);
      selectedRoute = found;
    } else {
      selectedRoute = outcome.routes[resolveRouteBestIndex(outcome.routes)]!;
    }
  } catch (err) {
    const externalName = err instanceof VexError ? err.externalName : undefined;
    return failPreSign("bridge_failed", khalaniFailureMessage(err), { kind: "exception", externalName });
  }

  // 5. Freshness. The rule (quoteExpiresAt, else validBefore, non-positive =
  // none) has ONE owner — `khalaniRouteExpiryUnixSeconds` — shared with the
  // quote/dryRun previews, so what the agent is SHOWN is what is ENFORCED.
  const expiresAt = khalaniRouteExpiryUnixSeconds(selectedRoute);
  if (expiresAt !== null && Date.now() >= expiresAt * 1000) {
    return failPreSign("deadline_expired", "Quote has expired — re-request a fresh quote");
  }

  // 6. Build deposit plan (needed for BOTH dryRun and execute).
  const depositMethod = str(params, "depositMethod") as DepositMethod | "";
  let plan: DepositPlan;
  try {
    plan = await getKhalaniClient().buildDeposit({
      from: prepared.request.fromAddress,
      quoteId,
      routeId: selectedRoute.routeId,
      ...(depositMethod ? { depositMethod } : {}),
    });
  } catch (err) {
    const externalName = err instanceof VexError ? err.externalName : undefined;
    return failPreSign("bridge_failed", khalaniFailureMessage(err), { kind: "exception", externalName });
  }

  // 7. USD + token facts (Khalani serves no USD) — resolved BEFORE the dryRun
  // branch so the preview discloses the SAME fee the execute charges.
  const [fromInfo, toInfo]: [KhalaniTokenInfo | null, KhalaniTokenInfo | null] = await Promise.all([
    resolveKhalaniTokenInfo(fromToken, fromChainId),
    resolveKhalaniTokenInfo(toToken, toChainId),
  ]);
  const feeAmountHuman = humanizeAmount(feeSplit.feeRaw.toString(), fromInfo?.decimals);
  // ONE derivation, used by BOTH the agent-facing disclosure below and the
  // `bridge_fee` row's `usd_vex_fee_est` (migration 050), so the number Vex
  // discloses and the number Vex records can never drift apart. `undefined`
  // (never 0) when the source token has no price.
  const usdVexFee = chargeFee ? estimateUsd(feeAmountHuman, fromInfo?.priceUsd) : undefined;
  const vexFee: BridgeFeeDisclosure = chargeFee
    ? buildBridgeFeeDisclosure({
        tokenAddress: fromToken,
        tokenSymbol: fromInfo?.symbol,
        tokenDecimals: fromInfo?.decimals,
        feeRaw: feeSplit.feeRaw,
        bridgedRaw: feeSplit.bridgedRaw,
        totalRaw: feeSplit.totalRaw,
        receiver: fromFamily === "solana" ? BRIDGE_FEE_RECEIVER_SOLANA : BRIDGE_FEE_RECEIVER_EVM,
        feeUsdEstimate: usdVexFee,
      })
    : buildBridgeFeeSkippedDisclosure({
        reason: feeSkipReason ?? "no fee applies to this bridge",
        totalRaw: feeSplit.totalRaw,
      });

  // 7b. Materialize AND classify the deposit plan BEFORE the preview and before
  // ANY recording or signing.
  //
  // This ordering is the point of the card, not a detail. Khalani's deposit
  // plan used to be built after the approval gate had already run, so the
  // provider's `tx.value` reached the signer having never been disclosed: a
  // deBridge deposit carrying 1e15 wei (~$1.86) that appears in NEITHER
  // `amountIn` NOR `amountOut` NOR `estimatedGas` was signed as-is. Classifying
  // here means the exposure is in the preview the agent reads, in the record
  // the intent persists, and in the fingerprint the signer re-checks.
  //
  // Planning is fault-TOLERATED here and fault-FATAL at step 8: a PERMIT2 plan
  // legitimately throws, and `dryRun` is the documented way to inspect a permit
  // payload, so a preview must still render. Nothing can be signed from a plan
  // that did not build.
  const sourceChain = getChain(fromChainId, chains);
  let plannedLegs: KhalaniStagedLeg[] | null = null;
  let planError: unknown = null;
  try {
    plannedLegs = planKhalaniDepositLegs(
      plan,
      sourceChain,
      chargeFee ? { tokenAddress: fromToken, feeRaw: feeSplit.feeRaw } : null,
    );
  } catch (err) {
    planError = err;
  }

  let nativeCost: KhalaniPlanNativeValue | null = null;
  let nativeCostError: unknown = null;
  if (plannedLegs !== null) {
    try {
      nativeCost = await authorizeKhalaniPlanNativeValue(plannedLegs, sourceChain, chains, {
        fromToken,
        // What the venue was actually quoted for and will deposit — the number
        // VEX derived, never the provider's echo of it.
        bridgedAmountRaw: quoteRequest.amount,
      });
    } catch (err) {
      nativeCostError = err;
    }
  }

  // 7c. dryRun — read-only preview (no recording, no signing). Carries the same
  // deadline the real execute enforces (step 5), so a preview never hides the
  // window the agent has to act in, and now the same native-cost breakdown the
  // execute enforces, so it never hides what the deposit would actually spend.
  if (params.dryRun === true) {
    const projected = projectQuoteRoute(selectedRoute, Date.now());
    return {
      success: true,
      output: JSON.stringify({
        dryRun: true, quoteId,
        route: { ...projected, type: humanizeRouteType(selectedRoute.type) },
        fromChain: fromChainName, toChain: toChainName,
        vexFee,
        nativeCost: nativeCostPreview(nativeCost, plannedLegs === null),
      }, null, 2),
    };
  }

  // 8. Fail closed on the plan and on its native-cost classification. An
  // unclassified native charge is an AUTHORIZATION failure, not an economics
  // one, so it needs no threshold: it uses the existing `allowance_or_balance`
  // code with a truthful structured reason and signs nothing.
  if (plannedLegs === null) {
    return failPreSign("bridge_failed", khalaniFailureMessage(planError));
  }
  if (nativeCost === null) {
    return failPreSign(
      "allowance_or_balance",
      "the deposit plan's native-currency charges could not be verified "
        + `(${khalaniFailureMessage(nativeCostError)}), so nothing was signed`,
    );
  }
  if (nativeCost.refusal !== null) {
    return failPreSign("allowance_or_balance", khalaniNativeValueRefusalReason(nativeCost.refusal));
  }
  // The AUTHORIZED legs — each carries the fingerprint `signStageKhalaniLeg`
  // re-validates immediately before it serializes anything.
  const stagedLegs: KhalaniStagedLeg[] = nativeCost.legs;

  // 9. Amount resolution at record time.
  const amountInRaw = selectedRoute.quote.amountIn;
  const amountOutRaw = selectedRoute.quote.amountOut;
  const fromHuman = humanizeAmount(amountInRaw, fromInfo?.decimals);
  const toHuman = humanizeAmount(amountOutRaw, toInfo?.decimals);
  const usdIn = estimateUsd(fromHuman, fromInfo?.priceUsd);
  const usdOut = estimateUsd(toHuman, toInfo?.priceUsd);
  // `usdVexFee` (above) is Vex's own 25 bps, recorded for the first time
  // (migration 050). It is stamped on the `bridge_fee` LEG below, not on the
  // logical row: the fee transfer is the final leg, taken only after the
  // deposit succeeded, so that row's own status is what says whether Vex was
  // actually paid. Summing logical rows would count fees Vex merely planned.
  const usdSource = usdIn || usdOut || usdVexFee ? KHALANI_TOKEN_PRICE_USD_SOURCE : undefined;

  const sourceLegInput: AgentActivityLegInput = {
    tokenAddress: fromToken, tokenSymbol: fromInfo?.symbol, tokenDecimals: fromInfo?.decimals,
    amountHuman: fromHuman, amountRaw: amountInRaw,
  };
  // The fee leg's OWN money, not the bridged amount — the row must show the
  // real token and the real amount that left the wallet.
  const feeLegInput: AgentActivityLegInput = {
    tokenAddress: fromToken, tokenSymbol: fromInfo?.symbol, tokenDecimals: fromInfo?.decimals,
    amountHuman: feeAmountHuman, amountRaw: feeSplit.feeRaw.toString(),
  };
  const destLegInput: AgentActivityLegInput = {
    tokenAddress: toToken, tokenSymbol: toInfo?.symbol, tokenDecimals: toInfo?.decimals,
    amountHuman: toHuman, amountRaw: amountOutRaw,
  };
  const amountInView: AmountView = { token: fromToken, symbol: fromInfo?.symbol, amountHuman: fromHuman, amountRaw: amountInRaw, usdEst: usdIn };
  const amountOutView: AmountView = { token: toToken, symbol: toInfo?.symbol, amountHuman: toHuman, amountRaw: amountOutRaw, usdEst: usdOut };

  // 10. Friendly in-flight pre-check (the DB index is the authoritative gate).
  const preCheck = await checkBridgeInFlight({ walletAddress: fromAddress, sessionId, route });
  if (preCheck.inFlight) return inFlightResult(toolId, preCheck.existing);

  // 11. Atomically create the intent + planned legs + logical expected-fill row.
  // The Vex fee leg is recorded under its own `bridge_fee` event_role
  // (migration 050; it was `allowance` before that — see
  // `BRIDGE_FEE_ACTIVITY_EVENT_ROLE`). Its token, amount, USD estimate and hash
  // are the real ones, so the money is neither hidden nor mislabeled.
  const activityLegs: BridgeActivityLeg[] = stagedLegs.map((leg, i) => ({
    eventIndex: i, eventRole: leg.role, chainId: fromChainId, chainSlug: fromChainName, chainFamily: fromFamily,
    tokenIn: leg.purpose === "vex_fee" ? feeLegInput : sourceLegInput,
    ...(leg.purpose === "vex_fee" ? { usdVexFeeEst: usdVexFee, usdSource } : {}),
  }));
  const expectedFill: BridgeExpectedFill = {
    eventIndex: stagedLegs.length, chainId: toChainId, chainSlug: toChainName, chainFamily: toFamily,
    tokenIn: sourceLegInput, tokenOut: destLegInput,
    // No venue-fee or destination-prepay USD is recorded: Khalani's quote
    // exposes neither as a trustworthy USD figure, and inventing one would
    // recreate exactly the mixed-meaning column migration 050 removes. The Vex
    // fee lives on the `bridge_fee` leg, not here.
    usdInEst: usdIn, usdOutEst: usdOut, usdFeeEst: undefined, usdSource,
  };
  const intent = await createBridgeActivityIntent({
    toolId, namespace: NAMESPACE, protocol: PROTOCOL, intentParams: params,
    walletAddress: fromAddress, sessionId, route,
    // Pre-sign correlation, now including the typed native-cost breakdown and
    // the per-leg FINGERPRINT the signer re-validates. Persisting it here — in
    // the same transaction that creates the rows, before any key is decrypted
    // — is what makes the exposure part of the authorized record rather than a
    // number that first appears inside the signer.
    quoteRef: {
      quoteId, routeId: selectedRoute.routeId, routeType: selectedRoute.type,
      nativeCost: {
        totalNativeOutflowWei: nativeCost.totalNativeOutflowWei,
        legs: nativeCost.disclosures,
      },
    },
    legs: activityLegs, expectedFill,
  });
  if (intent.outcome === "in_flight_conflict") return inFlightResult(toolId, intent.existing);
  const { executionId } = intent;

  // 12. Resolve the source-family signing wallet (decrypts) — only now.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, fromFamily);
  } catch (err) {
    await abortRemaining(executionId, 0, "signer resolution failed");
    return walletScopeErrorToResult(err);
  }

  const recordedLegs: RecordedLeg[] = [];

  const pendingBase = {
    executionId, fromChainName, toChainName,
    routeType: selectedRoute.type, etaSeconds: selectedRoute.quote.expectedDurationSeconds,
    amountIn: amountInView, amountOut: amountOutView,
    // Disclosed on the EXECUTE result too, not only in dryRun: an autonomous
    // agent that never previews would otherwise learn nothing about what the
    // deposit spent in native currency beyond the bridged principal.
    nativeCost: {
      totalNativeOutflowWei: nativeCost.totalNativeOutflowWei,
      legs: nativeCost.disclosures,
    },
    // Default: the fee leg never ran. Every return BEFORE 13b is a bridge that
    // did not complete, and such a bridge is never charged.
    vexFee: {
      disclosure: vexFee,
      collection: "not_attempted",
      collectionNote: "No Vex fee was taken: the bridge did not reach the point where the fee is collected.",
    } satisfies BridgeVexFeeView,
  };

  // The staging CAS hooks, shared by the bridge loop below and the Vex fee leg
  // (13b): both must persist the hash BEFORE the payload reaches the network,
  // and both must refuse to broadcast an untracked transaction on a CAS miss.
  const stageHooksFor = (rowId: number) => ({
    onHashStaged: async (h: Parameters<Parameters<typeof signStageKhalaniLeg>[4]["onHashStaged"]>[0]) => {
      // Nonce-less staging is Solana-only: the dedicated CAS's
      // `chain_family='solana'` predicate makes a nonce-less EVM leg a
      // CAS miss (abort below), never a wrongly-shaped stage. A `null`
      // nonce always carries the blockhash evidence (W5 §2/R2b) — see
      // `KhalaniStageHandles`'s discriminated-union doc.
      const res = h.nonce === null
        ? await markActivitySolanaBroadcast(rowId, {
            txHash: h.txHash, fromAddress: h.fromAddress,
            recentBlockhash: h.recentBlockhash, lastValidBlockHeight: h.lastValidBlockHeight,
          })
        : await markActivityBroadcast(rowId, { txHash: h.txHash, fromAddress: h.fromAddress, nonce: h.nonce });
      if (!res.applied) {
        throw new Error(`agent_activity: staging CAS miss for event ${rowId} — refusing to broadcast untracked`);
      }
    },
    onAccepted: async () => {
      const r = await markBroadcastAccepted(rowId);
      if (!r.applied) logger.warn("khalani.bridge.broadcast_accept_miss", { id: rowId });
    },
  });

  // The Vex fee leg is planned LAST (index `stagedLegs.length - 1` when
  // charged) and is driven OUTSIDE the bridge loop — its outcome must never
  // fail, abort, or delay the bridge (see 13b).
  const feeLegIndex = stagedLegs.findIndex((leg) => leg.purpose === "vex_fee");
  const bridgeLegCount = feeLegIndex === -1 ? stagedLegs.length : feeLegIndex;
  /** Finalize a never-attempted fee row without touching the logical fill row. */
  const skipFeeLeg = async (reason: string): Promise<void> => {
    if (feeLegIndex === -1) return;
    await abortRemaining(executionId, feeLegIndex, reason, feeLegIndex + 1);
  };

  /**
   * Sign, stage, broadcast and record the Vex fee transfer. Called ONLY after
   * the deposit is confirmed AND registered with the provider. Every path
   * returns a report — none throws, none aborts the logical row, none marks
   * the bridge failed: the bridge already happened, so a fee that does not
   * land is missed Vex revenue and nothing more.
   */
  const runVexFeeLeg = async (): Promise<VexFeeCollection> => {
    if (feeLegIndex === -1) {
      return { collection: "not_charged", collectionNote: "No Vex fee applies to this bridge." };
    }
    const feeLeg = stagedLegs[feeLegIndex]!;
    const feeRow = intent.legs[feeLegIndex];
    if (!feeRow) {
      logger.warn("khalani.bridge.fee_leg_row_missing", { executionId, index: feeLegIndex });
      return {
        collection: "not_attempted",
        collectionNote: "The bridge went through. The Vex fee had no recorded row, so no fee was taken.",
      };
    }
    try {
      const outcome = await signStageKhalaniLeg(feeLeg, sourceChain, chains, signer, stageHooksFor(feeRow.id));
      const explorerUrl = txExplorerUrl(fromChainId, chains, outcome.txHash);
      if (outcome.kind === "reverted") {
        await failActivityEvent(feeRow.id, {
          failureCode: "mined_revert",
          failureReason: `Vex fee transfer ${outcome.txHash} reverted on-chain; the bridge itself was unaffected.`,
        });
        recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: outcome.txHash, explorerUrl, status: "reverted" });
        return {
          collection: "reverted",
          collectionNote: "The bridge went through. The Vex fee transfer reverted, so no fee was collected — your bridge is unaffected.",
        };
      }
      if (outcome.kind === "ambiguous") {
        // Left PENDING with its staged hash for the receipt sweep. NEVER
        // retried here: a blind retry of an unconfirmed transfer could charge
        // the user twice.
        logger.info("khalani.bridge.fee_leg_ambiguous", { id: feeRow.id, stage: outcome.stage });
        recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: outcome.txHash, explorerUrl, status: "broadcast_unconfirmed" });
        return {
          collection: "unconfirmed",
          collectionNote: "The bridge went through. The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never re-sent.",
        };
      }
      let legStatus = "confirmed";
      try {
        const confirmResult = await confirmActivityEvent(feeRow.id, {});
        if (!confirmResult.applied) {
          const alreadyMatches =
            confirmResult.row.status === "confirmed" && confirmResult.row.txHash === outcome.txHash;
          if (!alreadyMatches) {
            legStatus = "confirmed_unrecorded";
            logger.warn("khalani.bridge.fee_leg_confirm_cas_miss", { id: feeRow.id, rowStatus: confirmResult.row.status });
          }
        }
      } catch (err) {
        legStatus = "confirmed_unrecorded";
        logger.warn("khalani.bridge.fee_leg_confirm_failed", { id: feeRow.id, error: khalaniFailureMessage(err) });
      }
      recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: outcome.txHash, explorerUrl, status: legStatus });
      return {
        collection: legStatus,
        collectionNote: "The bridge went through and the Vex fee was transferred to the treasury.",
      };
    } catch (err) {
      const safe = khalaniFailureMessage(err);
      logger.warn("khalani.bridge.fee_leg_failed", { executionId, error: safe });
      await skipFeeLeg("vex fee leg refused before signing");
      recordedLegs.push({ role: "vex_fee", chain: fromChainName, txHash: null, status: "not_attempted" });
      return {
        collection: "not_attempted",
        collectionNote: "The bridge went through. The Vex fee transfer was refused before signing, so no fee was collected — your bridge is unaffected.",
      };
    }
  };

  // 13. Staged broadcast loop — one Vex-signed BRIDGE leg at a time.
  let depositTxHash: string | undefined;
  let currentIndex = 0;
  // Read-after-write anchor for the NEXT leg: the allowance this loop just
  // confirmed is exactly the state the deposit leg's pre-sign estimate depends
  // on, and the estimating node does not always have it yet (live 2026-07-24,
  // allowance `0x2445ce73…` confirmed, deposit refused with "ERC20: transfer
  // amount exceeds allowance", immediate retry succeeded — see
  // `dependent-leg-gas-estimate.ts`). `null` for Solana legs: no EVM anchor.
  let priorLeg: ConfirmedPriorLeg | undefined;
  try {
    for (let i = 0; i < bridgeLegCount; i++) {
      currentIndex = i;
      const stagedLeg = stagedLegs[i]!;
      const legRow = intent.legs[i]!;
      const outcome = await signStageKhalaniLeg(
        stagedLeg, sourceChain, chains, signer, stageHooksFor(legRow.id), priorLeg,
      );

      if (outcome.kind === "ambiguous") {
        logger.info("khalani.bridge.leg_ambiguous", { id: legRow.id, role: stagedLeg.role, stage: outcome.stage });
        recordedLegs.push({ role: stagedLeg.role, chain: fromChainName, txHash: outcome.txHash, explorerUrl: txExplorerUrl(fromChainId, chains, outcome.txHash), status: "broadcast_unconfirmed" });
        // Do NOT submit to Khalani — the deposit hash is staged.
        if (stagedLeg.isDeposit) {
          // Blocker 1: an ambiguous DEPOSIT hash MAY have landed on-chain. The
          // logical `bridge_fill_expected` row + the in-flight guard MUST stay
          // pending so W4's null-order-id recovery reconciles the deposit hash
          // against the provider — terminalizing it here would release the guard
          // mid-flight and permit a duplicate bridge. Abort ONLY the never-signed
          // sibling legs strictly BELOW the expected-fill event index (normally
          // none, since the deposit is the last broadcast leg); the exclusive
          // bound (= stagedLegs.length, the expected-fill index) leaves the
          // logical row untouched.
          await abortRemaining(executionId, i + 1, `earlier ${stagedLeg.role} ambiguous`, stagedLegs.length);
        } else {
          // An upstream allowance ended ambiguously and NO deposit was broadcast,
          // so nothing is in flight; abort the whole remaining plan (including the
          // logical row) to release the guard — W4 cannot recover a row that has
          // no staged deposit hash.
          await abortRemaining(executionId, i + 1, `earlier ${stagedLeg.role} ambiguous`);
        }
        return bridgeResult({
          ...pendingBase, success: false, status: "pending",
          message: `The ${stagedLeg.role} transaction (${outcome.txHash}) could not be confirmed yet — it may still settle on-chain. Do not re-bridge; this attempt is recorded and tracked automatically.`,
          legs: recordedLegs, depositTxHash: stagedLeg.isDeposit ? outcome.txHash : undefined,
        });
      }
      if (outcome.kind === "reverted") {
        await failActivityEvent(legRow.id, { failureCode: "mined_revert", failureReason: `${stagedLeg.role} transaction ${outcome.txHash} reverted on-chain.` });
        recordedLegs.push({ role: stagedLeg.role, chain: fromChainName, txHash: outcome.txHash, explorerUrl: txExplorerUrl(fromChainId, chains, outcome.txHash), status: "reverted" });
        await abortRemaining(executionId, i + 1, `earlier ${stagedLeg.role} reverted`);
        // REVISION 1 R1: reveal ONLY for the bridge_deposit leg (never allowance).
        const revealSuffix = stagedLeg.role === "bridge_deposit"
          ? revealOnEligibleKhalaniFailure({ kind: "deposit_mined_revert" }, sessionId, params)
          : "";
        return bridgeResult({
          ...pendingBase, success: false, status: "reverted",
          message: `The ${stagedLeg.role} transaction (${outcome.txHash}) reverted on-chain. No further steps were attempted and no bridge was initiated.${revealSuffix}`,
          legs: recordedLegs,
        });
      }

      // Confirmed on-chain — record the leg from its own receipt, but RESPECT
      // the CAS result (m5, mirrors Phase-1 C41): a miss that is not a benign
      // already-confirmed-with-the-SAME-hash race means Vex's own record of the
      // (real) on-chain settlement did not persist, so the leg is reported
      // `confirmed_unrecorded`, never an ordinary confirmed.
      let legStatus = "confirmed";
      priorLeg = priorLegAnchorFrom(outcome.settledAtBlock);
      try {
        const confirmResult = await confirmActivityEvent(legRow.id, {});
        if (!confirmResult.applied) {
          const alreadyMatches =
            confirmResult.row.status === "confirmed" && confirmResult.row.txHash === outcome.txHash;
          if (!alreadyMatches) {
            legStatus = "confirmed_unrecorded";
            logger.warn("khalani.bridge.leg_confirm_cas_miss", { id: legRow.id, role: stagedLeg.role, rowStatus: confirmResult.row.status });
          }
        }
      } catch (err) {
        legStatus = "confirmed_unrecorded";
        logger.warn("khalani.bridge.leg_confirm_failed", { id: legRow.id, role: stagedLeg.role, error: khalaniFailureMessage(err) });
      }
      recordedLegs.push({ role: stagedLeg.role, chain: fromChainName, txHash: outcome.txHash, explorerUrl: txExplorerUrl(fromChainId, chains, outcome.txHash), status: legStatus });
      if (stagedLeg.isDeposit) depositTxHash = outcome.txHash;
    }
  } catch (err) {
    // Post-intent failure (e.g. a CAS-miss throw) — NEVER create a second
    // execution. Abort the remaining never-signed rows; return the SAME id.
    const safeMessage = khalaniFailureMessage(err);
    await abortRemaining(executionId, currentIndex, safeMessage);
    logger.warn("khalani.bridge.post_intent_failure", { executionId, index: currentIndex, error: safeMessage });
    // A leg refused because its estimate never succeeded after an allowance
    // this same bridge confirmed is NOT an interruption of unknown scope:
    // nothing was signed for it, every remaining row (including the logical
    // fill row, so the in-flight guard is released) is finalized "not
    // attempted", and no deposit reached the network. "Do not re-bridge" is
    // the wrong instruction here — it is what made a transient RPC lag a
    // permanent, funded failure for an autonomous agent (live 2026-07-24).
    if (err instanceof DependentLegGasEstimateError) {
      const refusedRole = stagedLegs[currentIndex]?.role ?? "bridge_deposit";
      return bridgeResult({
        ...pendingBase, success: false, status: "not_attempted",
        message: `The ${refusedRole} leg could not be gas-estimated, so it was refused before signing and no bridge was initiated. ${dependentLegEstimateGuidance(err)} The node reported: ${safeMessage}`,
        legs: recordedLegs,
      });
    }
    // The signer's native-value backstop. Step 8 should already have refused
    // this plan, so reaching here means the exposure changed AFTER the intent
    // was recorded — but it is still a refusal that signed nothing, and it must
    // not be reported as an interruption of unknown scope. Telling an
    // autonomous agent "do not re-bridge" when no transaction exists is exactly
    // what turns a safe refusal into a stuck, funded-looking failure.
    if (err instanceof VexError && err.code === ErrorCodes.NATIVE_VALUE_UNAUTHORIZED) {
      const refusedRole = stagedLegs[currentIndex]?.role ?? "bridge_deposit";
      return bridgeResult({
        ...pendingBase, success: false, status: "not_attempted",
        message: `The ${refusedRole} leg sends native currency Vex could not account for, so it was refused before signing and no bridge was initiated. ${safeMessage} Re-quote to get a fresh deposit plan.`,
        legs: recordedLegs,
      });
    }
    // The signer's gas-ceiling backstop (W6/6a), same shape and same reasoning
    // as the native-value branch above: a PRE-SIGN refusal that signed nothing
    // must never be reported as an interruption of unknown scope. Carried here
    // rather than left to the generic tail because `safeMessage` is capped at
    // 200 characters — the cap holds the numbers, this sentence holds the
    // action.
    if (err instanceof VexError && err.code === ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE) {
      const refusedRole = stagedLegs[currentIndex]?.role ?? "bridge_deposit";
      return bridgeResult({
        ...pendingBase, success: false, status: "not_attempted",
        message: `The ${refusedRole} leg asked for far more gas than Vex measured for that exact call, so it was refused before signing and no bridge was initiated. ${safeMessage} Re-quote for a fresh deposit plan; a gas estimate does not move with congestion, so waiting will not change this. If a fresh quote asks for the same limit, bridge over a different route instead of retrying this one.`,
        legs: recordedLegs,
      });
    }
    return bridgeResult({
      ...pendingBase, success: false, status: "pending",
      message: `An internal error interrupted the bridge after it was recorded — ${safeMessage}. Check the record (execution ${executionId}) before any further action; do not re-bridge.`,
      legs: recordedLegs, depositTxHash,
    });
  }

  if (!depositTxHash) {
    // Unreachable — planKhalaniDepositLegs guarantees exactly one deposit leg.
    await abortRemaining(executionId, currentIndex, "no deposit hash after staged legs");
    return bridgeResult({ ...pendingBase, success: false, status: "pending", message: "The bridge deposit did not produce a hash; the attempt is recorded — do not re-bridge.", legs: recordedLegs });
  }

  // 14. Submit the confirmed deposit hash to Khalani → order id.
  let orderId: string;
  try {
    const submitted = await getKhalaniClient().submitDeposit({ quoteId, routeId: selectedRoute.routeId, txHash: depositTxHash });
    orderId = submitted.orderId;
  } catch (err) {
    const externalName = err instanceof VexError ? err.externalName : undefined;
    if (externalName === "DuplicateRecordException") {
      // Already submitted — fetch the existing order (no new action).
      const existing = await fetchExistingOrderId(fromAddress, depositTxHash);
      if (existing) {
        orderId = existing;
      } else {
        logger.warn("khalani.bridge.duplicate_no_existing", { executionId });
        await skipFeeLeg("provider order could not be reconciled; fee not attempted");
        return bridgeResult({ ...pendingBase, success: false, status: "pending", message: `The deposit (${depositTxHash}) was already submitted; its order could not be re-fetched in this turn but is recorded and tracked automatically. Do not re-bridge.`, legs: recordedLegs, depositTxHash });
      }
    } else {
      // Deposit is confirmed + recorded; W4 recovers the null-order-id row.
      logger.warn("khalani.bridge.submit_failed", { executionId, error: khalaniFailureMessage(err) });
      await skipFeeLeg("provider order submission pending; fee not attempted");
      return bridgeResult({ ...pendingBase, success: false, status: "pending", message: `The deposit confirmed on-chain (${depositTxHash}) but the provider order submission is pending — it is recorded and tracked automatically. Do not re-bridge.`, legs: recordedLegs, depositTxHash });
    }
  }

  // 15. Attach the provider order id to the logical row (CAS, all outcomes).
  const attach = await attachProviderOrderId({ executionId, providerOrderId: orderId });
  // m4: the in-turn poll must use the PERSISTED order id, NEVER a newly-returned
  // conflicting one. On `conflict_different_id` the logical row already carries a
  // different id (that persisted id is the one to trust); on `not_pending` the row
  // may carry the id a prior attach/W4 recorded. Default to the id we just
  // submitted only when the fresh attach succeeded.
  let pollOrderId = orderId;
  if (attach.outcome === "conflict_different_id") {
    logger.warn("khalani.bridge.order_id_conflict", { executionId });
    const persisted = attach.row?.providerOrderId ?? null;
    if (!persisted) {
      // Defensive: a genuine conflict always carries a persisted id, but never
      // poll the conflicting id — skip the poll with a truthful pending output.
      await skipFeeLeg("provider order id could not be reconciled; fee not attempted");
      return bridgeResult({
        ...pendingBase, success: false, status: "pending", depositTxHash,
        message: `The deposit confirmed on-chain (${depositTxHash}) but the provider order id could not be reconciled this turn — it is recorded and tracked automatically. Do not re-bridge.`,
        legs: recordedLegs,
      });
    }
    pollOrderId = persisted;
  } else if (attach.outcome === "not_pending") {
    logger.info("khalani.bridge.attach_not_pending", { executionId });
    pollOrderId = attach.row?.providerOrderId ?? orderId;
  }

  // 13b. Vex fee leg — LAST, and only now: the deposit is confirmed on-chain
  // and registered with the provider, so collecting the fee can neither delay
  // nor alter the bridge's own fill tracking (they are separate lifecycles
  // sharing one plan). Its outcome NEVER changes the bridge's: a failed or
  // unconfirmed fee transfer is missed Vex revenue on a bridge that DID
  // happen, never a user-facing failure and never a claim that funds are at
  // risk. An ambiguous broadcast is left unresolved for the receipt sweep
  // exactly like any other staged transaction — a blind retry could charge the
  // user twice.
  const feeOutcome = await runVexFeeLeg();

  // 16. In-turn order poll — truthful, never fabricated (R6/B4/Q2).
  const poll = await pollKhalaniOrderToTerminal(pollOrderId, context.abortSignal);
  return interpretPoll({
    poll, orderId: pollOrderId, depositTxHash, recordedLegs, toChainName,
    pendingBase: { ...pendingBase, vexFee: { disclosure: vexFee, ...feeOutcome } },
  });
}
