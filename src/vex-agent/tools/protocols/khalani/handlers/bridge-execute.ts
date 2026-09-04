/**
 * `bridge.ts` - the `khalani.bridge` staged-execute handler body, split out
 * (Card C5, move-only) once the parent file crossed the repo's 500-line
 * cap. See `bridge.ts`'s own module doc for the full staged-execute
 * contract (Phase-2 W3a; plan R2/R4/R5/R14-Q2/R15/C1/C2) this function
 * implements end to end (the 16 numbered steps below are unchanged from the
 * original single-file version).
 *
 * This file is the public entry point; the stages live in `./bridge-execute/`
 * (0R.4 facade split, refactor-only): venue/wallet preflight and the
 * pre-sign failure recorder stay here because they own the identity every
 * stage depends on; `quote.ts` (3–5), `fee-disclosure.ts` (7),
 * `deposit-plan.ts` (6/7b), `staging.ts` (CAS hooks), `legs.ts` (13),
 * `fee-leg.ts` (13b) and `submit.ts` (14/15) own the rest.
 */

import { getCachedKhalaniChains, getChain, getChainFamily } from "@tools/khalani/chains.js";
import { findCallerSuppliedForbiddenParam } from "@tools/khalani/request.js";
import { resolveKhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import { pollKhalaniOrderToTerminal } from "@tools/khalani/order-status.js";
import type { KhalaniStagedLeg } from "@tools/khalani/bridge-executor.js";
import { khalaniNativeValueRefusalReason } from "@tools/khalani/deposit-native-value.js";
import type { KhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { familyToInventory, walletAddressesEqual } from "@tools/wallet/inventory.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  createBridgeActivityIntent,
  createBridgePreBroadcastFailure,
  checkBridgeInFlight,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
  type BridgeActivityLeg,
  type BridgeChainFamily,
  type BridgeExpectedFill,
  type BridgeRouteEndpoints,
} from "@vex-agent/db/repos/agent-activity.js";
import { type KhalaniFailureSignal } from "../failure-mapping.js";
import { projectQuoteRoute } from "../projectors.js";
import { venueFallbackNoteOnKhalaniFailure } from "./fallback.js";
import { estimateUsd, humanizeAmount, KHALANI_TOKEN_PRICE_USD_SOURCE } from "./bridge-usd.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { str } from "../../handler-helpers.js";
import { bridgeRecipientRefusal } from "../../conventions.js";
import {
  abortRemaining,
  type AmountView,
  type BridgeVexFeeView,
  bridgeResult,
  humanizeRouteType,
  inFlightResult,
  khalaniFailureMessage,
  khalaniFailureOutput,
  type RecordedLeg,
} from "./bridge-support.js";
import { interpretPoll } from "./bridge-poll.js";
import { quoteKhalaniBridgeRoute } from "./bridge-execute/quote.js";
import { buildKhalaniDepositPlan } from "./bridge-execute/deposit-plan.js";
import {
  khalaniVexFeeStatementRefusal,
  nativeCostPreview,
  resolveKhalaniFeeDisclosure,
} from "./bridge-execute/fee-disclosure.js";
import { runKhalaniBridgeLegs } from "./bridge-execute/legs.js";
import { runKhalaniVexFeeLeg } from "./bridge-execute/fee-leg.js";
import { submitKhalaniDeposit } from "./bridge-execute/submit.js";
import type { KhalaniBridgePendingBase } from "./bridge-execute/types.js";
import {
  isBridgeTokenPreviewSigningReady,
  resolveKhalaniBridgeTokenPreviewFromResolved,
} from "@vex-agent/tools/protocols/bridge-token-identity.js";

const PROTOCOL = "khalani";
const NAMESPACE = "khalani";

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
  // NAME here - before any quote, recording, or signing - so an attempted
  // overcharge or refund redirection is loud on the direct `execute_tool` path
  // too, not silently stripped. The alias boundary rejects the same keys; this
  // is the second half of that pair.
  const forbiddenParam = findCallerSuppliedForbiddenParam(params);
  if (forbiddenParam !== null) {
    return {
      success: false,
      output: `${toolId} failed: ${forbiddenParam.param} is not an accepted parameter - ${forbiddenParam.reason} Remove it and retry.`,
    };
  }

  // A mutating protocol tool is prequote-gated, so a session is guaranteed
  // present; the recording contract needs it. Fail-closed if it is ever absent.
  const sessionId = context.sessionId;
  if (!sessionId) return { success: false, output: `${toolId} requires an active session.` };

  // 1. Pre-quote venue guard (R9) - decide the venue BEFORE any quote/build.
  let prequote: KhalaniPrequoteRoute;
  try {
    prequote = await resolveKhalaniPrequoteRoute(fromChain, toChain);
  } catch (err) {
    // Registry-fetch failure - transport, not a venue decision. Fail-closed.
    return { success: false, output: khalaniFailureOutput(toolId, err) };
  }
  if (prequote.outcome === "static_relay") {
    return {
      success: false,
      output: `${toolId} failed: ${fromChain} → ${toChain} bridges via Relay, not Khalani - use the bridge tool (it routes local chains such as Robinhood to Relay automatically).`,
    };
  }
  if (prequote.outcome === "no_route") {
    // A nonlocal endpoint is not in Khalani's live registry - we cannot build a
    // coherent route record for an absent chain, so surface the Relay fallback note +
    // fail WITHOUT a bridge row (the coherent-endpoints no-route records below).
    const fallbackNote = venueFallbackNoteOnKhalaniFailure({ kind: "empty_routes" }, sessionId, params);
    return {
      success: false,
      output: `${toolId} failed: Khalani has no route (${prequote.missing.join(", ")} chain not in the live registry).${fallbackNote}`,
    };
  }

  // prequote.outcome === "khalani": both endpoints are Khalani-serviceable.
  const { fromChainId, toChainId } = prequote;
  const chains = await getCachedKhalaniChains();
  const fromFamily: BridgeChainFamily = getChainFamily(fromChainId, chains);
  const toFamily: BridgeChainFamily = getChainFamily(toChainId, chains);
  const sourceChain = getChain(fromChainId, chains);
  const destinationChain = getChain(toChainId, chains);
  const fromChainName = sourceChain.name;
  const toChainName = destinationChain.name;

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
  // The DESTINATION is derived, never supplied. A cross-family bridge with no
  // wallet selected on the destination family fails closed here - before the
  // quote, before any recording and before any signing - rather than delivering
  // to an address nobody authorized. See the bridge-destination policy in
  // `@tools/khalani/request.js`.
  let recipient: string;
  try {
    recipient = resolveSelectedAddress(context.walletResolution, context.walletPolicy, toFamily);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  // A supplied `recipient` is REJECTED BY NAME, with the address this bridge
  // will actually deliver to. The manifest boundary (`runtime/params.ts`)
  // refuses the undeclared key before this handler on every registry-routed
  // call, which is what makes the refusal precede the prequote gate; this is
  // the second barrier, for any path that reaches the handler carrying the key
  // anyway. A silent drop would hide an attempted redirection.
  if (str(params, "recipient") !== "") {
    return { success: false, output: bridgeRecipientRefusal(toolId, recipient) };
  }

  const route: BridgeRouteEndpoints = {
    fromChainId, fromChainSlug: fromChainName, fromChainFamily: fromFamily, fromToken,
    toChainId, toChainSlug: toChainName, toChainFamily: toFamily, toToken,
  };

  // Helper: a mutating attempt that fails BEFORE signing → hashless failed row.
  const failPreSign = async (
    failureCode: AgentActivityFailureCode,
    reason: string,
    fallbackSignal?: KhalaniFailureSignal,
  ): Promise<ToolResult> => {
    const { executionId } = await createBridgePreBroadcastFailure({
      toolId, namespace: NAMESPACE, protocol: PROTOCOL, intentParams: params,
      walletAddress: fromAddress, sessionId, route,
      tokenIn: { tokenAddress: fromToken }, tokenOut: { tokenAddress: toToken },
      failureCode, failureReason: reason,
    });
    const fallbackNote = fallbackSignal ? venueFallbackNoteOnKhalaniFailure(fallbackSignal, sessionId, params) : "";
    return { success: false, output: `${toolId} failed: ${reason}.${fallbackNote}`, data: { _executionId: executionId } };
  };

  // 3–5. Fee split, quote, route selection, freshness.
  const quoted = await quoteKhalaniBridgeRoute({
    fromChain, toChain, fromToken, toToken, amount,
    tradeType: str(params, "tradeType") || undefined,
    filler: str(params, "filler") || undefined,
    fromAddress, recipient, fromChainId, fromFamily,
  }, failPreSign);
  if (quoted.outcome === "failed") return quoted.result;
  const { feeSplit, chargeFee, quoteId, selectedRoute } = quoted;

  // 6 + 7b. Deposit plan, its signable legs, and their native-cost classification.
  const planning = await buildKhalaniDepositPlan({
    fromAddress: quoted.prepared.request.fromAddress,
    quoteId, routeId: selectedRoute.routeId,
    sourceChain, chains, fromToken, chargeFee,
    feeRaw: feeSplit.feeRaw,
    bridgedAmountRaw: quoted.quotedAmountRaw,
  }, failPreSign);
  if (planning.outcome === "failed") return planning.result;
  const { plannedLegs, planError, nativeCost, nativeCostError } = planning;

  const tokenIdentity = context.bridgeTokenPreview
    ?? await resolveKhalaniBridgeTokenPreviewFromResolved({
      fromChain: sourceChain,
      toChain: destinationChain,
      fromToken,
      toToken,
      amountRaw: amount,
      chains,
      signal: context.abortSignal,
    });
  if (params.dryRun !== true && !isBridgeTokenPreviewSigningReady(tokenIdentity)) {
    return failPreSign(
      "allowance_or_balance",
      "direct EVM token symbol and decimals are unavailable, so Vex refused before signing",
    );
  }

  // 7. USD + token facts (Khalani serves no USD) - resolved BEFORE the dryRun
  // branch so the preview discloses the SAME fee the execute charges.
  const { fromInfo, toInfo, feeAmountHuman, usdVexFee, vexFee } = await resolveKhalaniFeeDisclosure({
    fromToken, toToken, fromChainId, toChainId, fromFamily, toFamily,
    feeSplit, chargeFee, feeSkipReason: quoted.feeSkipReason,
    signal: context.abortSignal,
    tokenIdentity,
  });

  // 7c. dryRun - read-only preview (no recording, no signing). Carries the same
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
        tokenMetadata: tokenIdentity,
        vexFee,
        nativeCost: nativeCostPreview(nativeCost, plannedLegs === null),
      }, null, 2),
    };
  }

  // 7d. The bound Vex fee statement (rule 90: revalidate immediately before
  // signing). The row states the fee a person approved; `vexFee` above is the
  // disposition THIS call would execute on, derived from this call's own split
  // and eligibility read. Any disagreement refuses here, before the plan is
  // committed, before the in-flight guard, before the intent and before the
  // signing wallet is resolved.
  //
  // Not a recorded failure row on purpose: this is an authorization refusal,
  // not a bridge that failed, and the durable failure vocabulary has no code
  // that says so. Recording `bridge_failed` would put a provider failure on the
  // feed for a bridge that was never attempted.
  const feeStatementRefusal = await khalaniVexFeeStatementRefusal({
    params, context, sessionId, derivedNow: vexFee,
  });
  if (feeStatementRefusal !== null) {
    return { success: false, output: `${toolId} failed: ${feeStatementRefusal}` };
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
  // The AUTHORIZED legs - each carries the fingerprint `signStageKhalaniLeg`
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
  // The fee leg's OWN money, not the bridged amount - the row must show the
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
  // (migration 050; it was `allowance` before that - see
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
    // the per-leg FINGERPRINT the signer re-validates. Persisting it here - in
    // the same transaction that creates the rows, before any key is decrypted
    // - is what makes the exposure part of the authorized record rather than a
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
  const { executionId, expectedFill: logicalRow } = intent;

  // 12. Resolve the source-family signing wallet (decrypts) - only now.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, fromFamily);
  } catch (err) {
    await abortRemaining(executionId, 0, "signer resolution failed");
    return walletScopeErrorToResult(err);
  }

  const recordedLegs: RecordedLeg[] = [];

  const pendingBase: KhalaniBridgePendingBase = {
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

  // The Vex fee leg is planned LAST (index `stagedLegs.length - 1` when
  // charged) and is driven OUTSIDE the bridge loop - its outcome must never
  // fail, abort, or delay the bridge (see 13b).
  const feeLegIndex = stagedLegs.findIndex((leg) => leg.purpose === "vex_fee");
  const bridgeLegCount = feeLegIndex === -1 ? stagedLegs.length : feeLegIndex;

  // 13. Staged broadcast loop - one Vex-signed BRIDGE leg at a time.
  const legLoop = await runKhalaniBridgeLegs({
    executionId, stagedLegs, bridgeLegCount, intentLegs: intent.legs,
    sourceChain, chains, signer, fromChainId, fromChainName,
    // The deposit leg's amount evidence is bound to the token Vex quoted and to
    // the amount it was quoted for - never to a provider echo.
    fromToken, quotedAmountRaw: quoted.quotedAmountRaw,
    sessionId, params, pendingBase, recordedLegs,
  });
  if (legLoop.outcome === "halted") return legLoop.result;
  const { depositTxHash } = legLoop;

  if (!depositTxHash) {
    // Unreachable - planKhalaniDepositLegs guarantees exactly one deposit leg.
    await abortRemaining(executionId, legLoop.currentIndex, "no deposit hash after staged legs");
    return bridgeResult({ ...pendingBase, success: false, status: "pending", message: "The bridge deposit did not produce a hash; the attempt is recorded - do not re-bridge.", legs: recordedLegs });
  }

  // 14 + 15. Submit the confirmed deposit hash to Khalani and attach the
  // provider order id to the logical row.
  const submitted = await submitKhalaniDeposit({
    executionId, feeLegIndex, quoteId, routeId: selectedRoute.routeId,
    depositTxHash, fromAddress, pendingBase, recordedLegs,
  });
  if (submitted.outcome === "halted") return submitted.result;
  const pollOrderId = submitted.pollOrderId;

  // 13b. Vex fee leg - LAST, and only now: the deposit is confirmed on-chain
  // and registered with the provider, so collecting the fee can neither delay
  // nor alter the bridge's own fill tracking (they are separate lifecycles
  // sharing one plan). Its outcome NEVER changes the bridge's: a failed or
  // unconfirmed fee transfer is missed Vex revenue on a bridge that DID
  // happen, never a user-facing failure and never a claim that funds are at
  // risk. An ambiguous broadcast is left unresolved for the receipt sweep
  // exactly like any other staged transaction - a blind retry could charge the
  // user twice.
  const feeOutcome = await runKhalaniVexFeeLeg({
    executionId, feeLegIndex, stagedLegs, intentLegs: intent.legs,
    sourceChain, chains, signer, fromChainId, fromChainName, recordedLegs,
  });

  // 16. In-turn order poll - truthful, never fabricated (R6/B4/Q2).
  const poll = await pollKhalaniOrderToTerminal(pollOrderId, context.abortSignal);
  return interpretPoll({
    poll, orderId: pollOrderId, depositTxHash, recordedLegs, toChainName,
    logicalRowId: logicalRow.id,
    pendingBase: { ...pendingBase, vexFee: { disclosure: vexFee, ...feeOutcome } },
  });
}
