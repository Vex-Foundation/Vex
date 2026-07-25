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
import { findCallerSuppliedFeeParam, prepareQuoteRequest } from "@tools/khalani/request.js";
import { resolveKhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import { classifyKhalaniQuoteResponse } from "@tools/khalani/quote-result.js";
import { pollKhalaniOrderToTerminal } from "@tools/khalani/order-status.js";
import {
  planKhalaniDepositLegs,
  signStageKhalaniLeg,
  type KhalaniStagedLeg,
} from "@tools/khalani/bridge-executor.js";
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
import { VexError } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolExecutionContext } from "../../types.js";
import { str } from "../../handler-helpers.js";
import logger from "@utils/logger.js";
import {
  abortRemaining,
  type AmountView,
  bridgeResult,
  fetchExistingOrderId,
  humanizeRouteType,
  inFlightResult,
  khalaniFailureMessage,
  type RecordedLeg,
  txExplorerUrl,
} from "./bridge-support.js";
import { interpretPoll } from "./bridge-poll.js";

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
  const amount = str(params, "amount");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    return { success: false, output: "Missing required parameters: fromChain, toChain, fromToken, toToken, amount" };
  }

  // Fee params are never accepted from tool input (see the bridge referral-fee
  // policy in `@tools/khalani/request.js`). Rejected BY NAME here — before any
  // quote, recording, or signing — so an attempted overcharge is loud on the
  // direct `execute_tool` path too, not silently stripped. The alias boundary
  // rejects the same keys; this is the second half of that pair.
  const suppliedFeeParam = findCallerSuppliedFeeParam(params);
  if (suppliedFeeParam !== null) {
    return {
      success: false,
      output: `${toolId} failed: ${suppliedFeeParam} is not an accepted parameter — Vex never charges a bridge referral fee and never takes fee parameters from tool input. Remove it and retry.`,
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
      refundTo: str(params, "refundTo") || undefined,
      filler: str(params, "filler") || undefined,
    });
  } catch (err) {
    return failPreSign("bridge_failed", khalaniFailureMessage(err));
  }

  // 4. Quote (plain). Empty routes[] is Khalani's canonical no-route signal.
  const routeIdParam = str(params, "routeId");
  let selectedRoute: QuoteRoute;
  let quoteId: string;
  try {
    const quoteResponse = await getKhalaniClient().getQuotes(
      prepared.request,
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

  // 7. dryRun — read-only preview (no recording, no signing). Carries the same
  // deadline the real execute enforces (step 5), so a preview never hides the
  // window the agent has to act in.
  if (params.dryRun === true) {
    const projected = projectQuoteRoute(selectedRoute, Date.now());
    return {
      success: true,
      output: JSON.stringify({
        dryRun: true, quoteId,
        route: { ...projected, type: humanizeRouteType(selectedRoute.type) },
        fromChain: fromChainName, toChain: toChainName,
      }, null, 2),
    };
  }

  // 8. Plan the Vex-signed legs (no signing yet).
  let stagedLegs: KhalaniStagedLeg[];
  try {
    stagedLegs = planKhalaniDepositLegs(plan, getChain(fromChainId, chains));
  } catch (err) {
    return failPreSign("bridge_failed", khalaniFailureMessage(err));
  }

  // 9. USD + amount resolution at record time (Khalani serves no USD).
  const [fromInfo, toInfo]: [KhalaniTokenInfo | null, KhalaniTokenInfo | null] = await Promise.all([
    resolveKhalaniTokenInfo(fromToken, fromChainId),
    resolveKhalaniTokenInfo(toToken, toChainId),
  ]);
  const amountInRaw = selectedRoute.quote.amountIn;
  const amountOutRaw = selectedRoute.quote.amountOut;
  const fromHuman = humanizeAmount(amountInRaw, fromInfo?.decimals);
  const toHuman = humanizeAmount(amountOutRaw, toInfo?.decimals);
  const usdIn = estimateUsd(fromHuman, fromInfo?.priceUsd);
  const usdOut = estimateUsd(toHuman, toInfo?.priceUsd);
  const usdSource = usdIn || usdOut ? KHALANI_TOKEN_PRICE_USD_SOURCE : undefined;

  const sourceLegInput: AgentActivityLegInput = {
    tokenAddress: fromToken, tokenSymbol: fromInfo?.symbol, tokenDecimals: fromInfo?.decimals,
    amountHuman: fromHuman, amountRaw: amountInRaw,
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
  const activityLegs: BridgeActivityLeg[] = stagedLegs.map((leg, i) => ({
    eventIndex: i, eventRole: leg.role, chainId: fromChainId, chainSlug: fromChainName, chainFamily: fromFamily,
    tokenIn: sourceLegInput,
  }));
  const expectedFill: BridgeExpectedFill = {
    eventIndex: stagedLegs.length, chainId: toChainId, chainSlug: toChainName, chainFamily: toFamily,
    tokenIn: sourceLegInput, tokenOut: destLegInput,
    usdInEst: usdIn, usdOutEst: usdOut, usdFeeEst: undefined, usdSource,
  };
  const intent = await createBridgeActivityIntent({
    toolId, namespace: NAMESPACE, protocol: PROTOCOL, intentParams: params,
    walletAddress: fromAddress, sessionId, route,
    quoteRef: { quoteId, routeId: selectedRoute.routeId, routeType: selectedRoute.type },
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

  const sourceChain = getChain(fromChainId, chains);
  const recordedLegs: RecordedLeg[] = [];

  const pendingBase = {
    executionId, fromChainName, toChainName,
    routeType: selectedRoute.type, etaSeconds: selectedRoute.quote.expectedDurationSeconds,
    amountIn: amountInView, amountOut: amountOutView,
  };

  // 13. Staged broadcast loop — one Vex-signed leg at a time.
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
    for (let i = 0; i < stagedLegs.length; i++) {
      currentIndex = i;
      const stagedLeg = stagedLegs[i]!;
      const legRow = intent.legs[i]!;
      const outcome = await signStageKhalaniLeg(stagedLeg, sourceChain, chains, signer, {
        onHashStaged: async (h) => {
          // Nonce-less staging is Solana-only: the dedicated CAS's
          // `chain_family='solana'` predicate makes a nonce-less EVM leg a
          // CAS miss (abort below), never a wrongly-shaped stage. A `null`
          // nonce always carries the blockhash evidence (W5 §2/R2b) — see
          // `KhalaniStageHandles`'s discriminated-union doc.
          const res = h.nonce === null
            ? await markActivitySolanaBroadcast(legRow.id, {
                txHash: h.txHash, fromAddress: h.fromAddress,
                recentBlockhash: h.recentBlockhash, lastValidBlockHeight: h.lastValidBlockHeight,
              })
            : await markActivityBroadcast(legRow.id, { txHash: h.txHash, fromAddress: h.fromAddress, nonce: h.nonce });
          if (!res.applied) {
            throw new Error(`agent_activity: staging CAS miss for event ${legRow.id} — refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const r = await markBroadcastAccepted(legRow.id);
          if (!r.applied) logger.warn("khalani.bridge.broadcast_accept_miss", { id: legRow.id });
        },
      }, priorLeg);

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
        return bridgeResult({ ...pendingBase, success: false, status: "pending", message: `The deposit (${depositTxHash}) was already submitted; its order could not be re-fetched in this turn but is recorded and tracked automatically. Do not re-bridge.`, legs: recordedLegs, depositTxHash });
      }
    } else {
      // Deposit is confirmed + recorded; W4 recovers the null-order-id row.
      logger.warn("khalani.bridge.submit_failed", { executionId, error: khalaniFailureMessage(err) });
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

  // 16. In-turn order poll — truthful, never fabricated (R6/B4/Q2).
  const poll = await pollKhalaniOrderToTerminal(pollOrderId);
  return interpretPoll({
    poll, orderId: pollOrderId, depositTxHash,
    pendingBase, recordedLegs, toChainName,
  });
}
