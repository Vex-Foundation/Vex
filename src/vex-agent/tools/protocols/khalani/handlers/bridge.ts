/**
 * Khalani bridge handler — STAGED execute onto the Agent Scan `agent_activity`
 * contract (Phase-2 W3a; plan R2/R4/R5/R14-Q2/R15/C1/C2).
 *
 * The execute path records BEFORE it signs: `createBridgeActivityIntent` plans
 * every Vex-signed leg (allowances + the origin `bridge_deposit`) PLUS exactly
 * one logical `bridge_fill_expected` row (carrying the route endpoints, requested
 * amounts, USD estimates, and the quote/route ids) — all inside one transaction,
 * guarded by the DB in-flight index (C2). Then every leg follows the full staged
 * discipline (sign → persist hash CAS → broadcast → accept), the deposit hash is
 * submitted to Khalani, and the provider order id is CAS-attached to the logical
 * row. The in-turn order poll NEVER fabricates a `confirmed` fill: a provider
 * `filled` is left pending for the W4 sweep's independent RPC verification (R6/B4
 * — see the seam note below); only provider-terminal `failed`/`refunded` are
 * recorded (the conservative failure direction).
 *
 * VERIFICATION SEAM LEFT FOR W4: `confirmBridgeExpectedFill` requires an
 * independent RPC verification of the destination fill (B4). W4
 * (`sync/bridge-activity-repair.ts`) owns that checklist + SSRF-controlled RPC
 * fallback; W3a has no verified path, so it leaves the logical row pending and
 * the W4 sweep performs the verified confirm + balance enqueue + reveal clear.
 *
 * SOLANA: a Vex-signed Solana deposit stages its base58 signature in `tx_hash`
 * with `nonce NULL` (chain_family='solana') through the dedicated
 * `markActivitySolanaBroadcast` CAS (B1 nonce matrix) — wired by the
 * coordinator after W3a's original refusal (the primitive did not exist yet).
 * The `chain_family='solana'` CAS predicate keeps an EVM leg from ever staging
 * nonce-less (defense-in-depth at the DB layer).
 */

import { getKhalaniClient } from "@tools/khalani/client.js";
import {
  getCachedKhalaniChains,
  getChain,
  getChainExplorerUrl,
  getChainFamily,
} from "@tools/khalani/chains.js";
import { resolveRouteBestIndex } from "@tools/khalani/helpers.js";
import { prepareQuoteRequest } from "@tools/khalani/request.js";
import { resolveKhalaniPrequoteRoute } from "@tools/khalani/prequote-route-guard.js";
import { classifyKhalaniQuoteResponse } from "@tools/khalani/quote-result.js";
import { pollKhalaniOrderToTerminal } from "@tools/khalani/order-status.js";
import {
  planKhalaniDepositLegs,
  signStageKhalaniLeg,
  type KhalaniStagedLeg,
} from "@tools/khalani/bridge-executor.js";
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
  abortPlannedEvents,
  type AgentActivityEvent,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
  type BridgeActivityLeg,
  type BridgeChainFamily,
  type BridgeExpectedFill,
  type BridgeRouteEndpoints,
} from "@vex-agent/db/repos/agent-activity.js";
import { type KhalaniFailureSignal } from "../failure-mapping.js";
import { revealOnEligibleKhalaniFailure } from "./reveal.js";
import {
  estimateUsd,
  humanizeAmount,
  resolveKhalaniTokenInfo,
  KHALANI_TOKEN_PRICE_USD_SOURCE,
  type KhalaniTokenInfo,
} from "./bridge-usd.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { VexError } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str } from "../../handler-helpers.js";
import logger from "@utils/logger.js";

const PROTOCOL = "khalani";
const NAMESPACE = "khalani";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary). */
function khalaniFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

/** Build a `.../tx/<hash>` explorer link from the Khalani chain registry, or undefined. */
function txExplorerUrl(chainId: number, chains: KhalaniChain[], txHash: string): string | undefined {
  const base = getChainExplorerUrl(chainId, chains);
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/tx/${txHash}`;
}

/** Map filler/route jargon to plain words for the agent-facing summary. */
function humanizeRouteType(type: string): string {
  return type
    .replace(/native-filler/gi, "direct filler")
    .replace(/external-intent-router/gi, "intent router");
}

interface RecordedLeg {
  readonly role: string;
  readonly chain: string;
  readonly txHash: string | null;
  readonly explorerUrl?: string;
  readonly status: string;
}

interface AmountView {
  readonly token: string;
  readonly symbol?: string;
  readonly amountHuman?: string;
  readonly amountRaw: string;
  readonly usdEst?: string;
}

/**
 * Build the agent-grade result. OWNER RULE: never truncated — every leg, hash,
 * amount, and USD estimate is projected as a structured field. USD is always
 * marked as an estimate. `success` is FALSE for any not-yet-verified outcome
 * (pending/settling/filled-unverified/failed/refunded) — success-shaped
 * ambiguity is forbidden (R2/Q2); only the W4 sweep's verified confirm is a
 * success, and it seeds balances then (C3).
 */
function bridgeResult(input: {
  success: boolean;
  status: string;
  message: string;
  executionId: number;
  fromChainName: string;
  toChainName: string;
  routeType: string;
  etaSeconds: number;
  amountIn: AmountView;
  amountOut: AmountView;
  legs: readonly RecordedLeg[];
  orderId?: string;
  depositTxHash?: string;
}): ToolResult {
  const inLabel = input.amountIn.amountHuman ?? `${input.amountIn.amountRaw} (smallest units)`;
  const inSym = input.amountIn.symbol ?? input.amountIn.token;
  const summary =
    `Bridging ${inLabel} ${inSym} from ${input.fromChainName} to ${input.toChainName} via Khalani `
    + `(route: ${humanizeRouteType(input.routeType)}, ~${input.etaSeconds}s expected).`;
  const data = {
    summary,
    status: input.status,
    message: input.message,
    fromChain: input.fromChainName,
    toChain: input.toChainName,
    route: humanizeRouteType(input.routeType),
    etaSeconds: input.etaSeconds,
    amountIn: {
      token: input.amountIn.symbol ?? input.amountIn.token,
      tokenAddress: input.amountIn.token,
      amountHuman: input.amountIn.amountHuman ?? null,
      amountRaw: input.amountIn.amountRaw,
      usdEstimate: input.amountIn.usdEst ?? null,
    },
    amountOut: {
      token: input.amountOut.symbol ?? input.amountOut.token,
      tokenAddress: input.amountOut.token,
      amountHuman: input.amountOut.amountHuman ?? null,
      amountRaw: input.amountOut.amountRaw,
      usdEstimate: input.amountOut.usdEst ?? null,
    },
    usdNote: "USD figures are estimates from a Khalani token-price lookup, not provider-quoted values.",
    legs: input.legs,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    ...(input.depositTxHash ? { depositTxHash: input.depositTxHash } : {}),
    _executionId: input.executionId,
  };
  return { success: input.success, output: JSON.stringify(data), data };
}

/**
 * Best-effort abort of never-signed downstream rows — a throw is logged, never
 * propagated. `toIndexExclusive` (when set) bounds the abort to
 * `event_index < toIndexExclusive`, so an ambiguous DEPOSIT can abort its
 * never-signed sibling legs while leaving the logical `bridge_fill_expected` row
 * (the highest index) pending for W4 recovery (blocker 1).
 */
async function abortRemaining(executionId: number, fromIndex: number, reason: string, toIndexExclusive?: number): Promise<void> {
  try {
    if (toIndexExclusive === undefined) {
      await abortPlannedEvents(executionId, fromIndex, reason);
    } else {
      await abortPlannedEvents(executionId, fromIndex, reason, toIndexExclusive);
    }
  } catch (err) {
    logger.warn("khalani.bridge.abort_planned_events_failed", {
      executionId,
      fromIndex,
      error: khalaniFailureMessage(err),
    });
  }
}

export const BRIDGE_HANDLERS: Record<string, ProtocolHandler> = {
  "khalani.bridge": async (
    params: Record<string, unknown>,
    context: ProtocolExecutionContext,
  ): Promise<ToolResult> => {
    const toolId = "khalani.bridge";
    const fromChain = str(params, "fromChain");
    const toChain = str(params, "toChain");
    const fromToken = str(params, "fromToken");
    const toToken = str(params, "toToken");
    const amount = str(params, "amount");
    if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
      return { success: false, output: "Missing required parameters: fromChain, toChain, fromToken, toToken, amount" };
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
        referrer: str(params, "referrer") || undefined,
        referrerFeeBps: str(params, "referrerFeeBps") || undefined,
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

    // 5. Freshness.
    const expiresAt = selectedRoute.quote.quoteExpiresAt ?? selectedRoute.quote.validBefore;
    if (expiresAt > 0 && Date.now() >= expiresAt * 1000) {
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

    // 7. dryRun — read-only preview (no recording, no signing).
    if (params.dryRun === true) {
      return {
        success: true,
        output: JSON.stringify({
          dryRun: true, quoteId,
          route: {
            routeId: selectedRoute.routeId, type: humanizeRouteType(selectedRoute.type),
            amountIn: selectedRoute.quote.amountIn, amountOut: selectedRoute.quote.amountOut,
            etaSeconds: selectedRoute.quote.expectedDurationSeconds,
          },
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
    try {
      for (let i = 0; i < stagedLegs.length; i++) {
        currentIndex = i;
        const stagedLeg = stagedLegs[i]!;
        const legRow = intent.legs[i]!;
        const outcome = await signStageKhalaniLeg(stagedLeg, sourceChain, chains, signer, {
          onHashStaged: async (h) => {
            // Nonce-less staging is Solana-only: the dedicated CAS's
            // `chain_family='solana'` predicate makes a nonce-less EVM leg a
            // CAS miss (abort below), never a wrongly-shaped stage.
            const res = h.nonce === null
              ? await markActivitySolanaBroadcast(legRow.id, { txHash: h.txHash, fromAddress: h.fromAddress })
              : await markActivityBroadcast(legRow.id, { txHash: h.txHash, fromAddress: h.fromAddress, nonce: h.nonce });
            if (!res.applied) {
              throw new Error(`agent_activity: staging CAS miss for event ${legRow.id} — refusing to broadcast untracked`);
            }
          },
          onAccepted: async () => {
            const r = await markBroadcastAccepted(legRow.id);
            if (!r.applied) logger.warn("khalani.bridge.broadcast_accept_miss", { id: legRow.id });
          },
        });

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
          return bridgeResult({
            ...pendingBase, success: false, status: "reverted",
            message: `The ${stagedLeg.role} transaction (${outcome.txHash}) reverted on-chain. No further steps were attempted and no bridge was initiated.`,
            legs: recordedLegs,
          });
        }

        // Confirmed on-chain — record the leg from its own receipt, but RESPECT
        // the CAS result (m5, mirrors Phase-1 C41): a miss that is not a benign
        // already-confirmed-with-the-SAME-hash race means Vex's own record of the
        // (real) on-chain settlement did not persist, so the leg is reported
        // `confirmed_unrecorded`, never an ordinary confirmed.
        let legStatus = "confirmed";
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
  },
};

// ── Poll interpretation ──────────────────────────────────────────────

interface InterpretPollInput {
  poll: Awaited<ReturnType<typeof pollKhalaniOrderToTerminal>>;
  orderId: string;
  depositTxHash: string;
  pendingBase: {
    executionId: number; fromChainName: string; toChainName: string;
    routeType: string; etaSeconds: number; amountIn: AmountView; amountOut: AmountView;
  };
  recordedLegs: RecordedLeg[];
  toChainName: string;
}

async function interpretPoll(input: InterpretPollInput): Promise<ToolResult> {
  const { poll, orderId, depositTxHash, pendingBase, recordedLegs, toChainName } = input;

  const withFill = (status: string): RecordedLeg[] => [
    ...recordedLegs,
    { role: "bridge_fill_expected", chain: toChainName, txHash: null, status },
  ];

  if (poll.kind === "unavailable") {
    logger.warn("khalani.bridge.status_unverifiable", { orderId });
    return bridgeResult({
      ...pendingBase, success: false, status: "pending", orderId, depositTxHash,
      message: `The deposit was broadcast (${depositTxHash}) but Khalani's order status was unreachable this turn. Delivery is UNCONFIRMED and tracked automatically — do not re-bridge; verify via orderId=${orderId} if needed.`,
      legs: withFill("pending"),
    });
  }

  if (poll.kind === "terminal" && (poll.status === "failed" || poll.status === "refunded")) {
    // ARCHITECTURAL (FIX-ROUND-1): the in-turn poll NEVER terminalizes the logical
    // row from provider status. W4 owns ALL terminal transitions — it verifies and
    // APPENDS refund/failure evidence before terminalizing, and keeps the row
    // pending if the evidence write fails, so a known refund hash is never lost.
    // Here we only REPORT the provider-terminal status truthfully; the row stays
    // pending and is reconciled by the background tracker.
    const message = poll.status === "refunded"
      ? "Khalani reports this bridge as refunded: the destination amount did NOT arrive; funds are being returned toward the refund address. Verification and recording are in progress and tracked automatically — do not re-bridge; money back is not a successful bridge."
      : "Khalani reports this bridge as failed: the destination amount did NOT arrive. Verification and recording are in progress and tracked automatically — do not re-bridge; verify balances via the order id before retrying.";
    return bridgeResult({ ...pendingBase, success: false, status: poll.status, orderId, depositTxHash, message, legs: withFill(poll.status) });
  }

  if (poll.kind === "terminal" && poll.status === "filled") {
    // R6/B4: NEVER fabricate a confirmed fill. Provider `filled` is left PENDING
    // for W4's independent RPC verification (the verified-confirm seam) — this
    // handler has no verified path, so it only reports the provider view.
    return bridgeResult({
      ...pendingBase, success: false, status: "filled_unverified", orderId, depositTxHash,
      message: `Khalani reports this bridge as filled — the deposit (${depositTxHash}) went through and delivery is in progress. Verification is pending (confirmed independently by the background tracker); do not re-bridge.`,
      legs: withFill("filled_unverified"),
    });
  }

  // Non-terminal at window close (created/deposited/published/refund_pending).
  const settlingMessage = poll.status === "refund_pending"
    ? `The deposit (${depositTxHash}) went through but Khalani's last status was "refund_pending": a refund is IN FLIGHT and the destination amount has NOT arrived. Tracked automatically — do not re-bridge.`
    : `The deposit (${depositTxHash}) went through and the bridge is still settling (last status "${poll.status}"). It is tracked automatically — do not re-bridge.`;
  return bridgeResult({
    ...pendingBase, success: false, status: "pending", orderId, depositTxHash,
    message: settlingMessage, legs: withFill("pending"),
  });
}

// ── Small helpers ─────────────────────────────────────────────────────

function inFlightResult(toolId: string, existing: AgentActivityEvent | null): ToolResult {
  const detail = existing ? ` (execution ${existing.protocolExecutionId}, status ${existing.status})` : "";
  return {
    success: false,
    output: `${toolId}: a bridge for this route is already in flight${detail} — wait for it to settle before starting another.`,
  };
}

/** Fetch an existing order id for a submitted deposit hash (DuplicateRecord recovery). */
async function fetchExistingOrderId(address: string, depositTxHash: string): Promise<string | null> {
  try {
    const orders = await getKhalaniClient().getOrders(address, { txHashSearch: depositTxHash, limit: 1 });
    const match = orders.data.find((o) => o.depositTxHash === depositTxHash) ?? orders.data[0];
    return match ? match.id : null;
  } catch (err) {
    logger.warn("khalani.bridge.fetch_existing_order_failed", { error: summarizeProtocolError(err).message });
    return null;
  }
}
