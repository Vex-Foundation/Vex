/**
 * Relay bridge handlers - quote.get (read) + bridge (mutating), on the W-SPINE
 * `agent_activity` contract (Wave-3 W3b).
 *
 * FAÇADE. This file keeps its name and its public export
 * (`RELAY_BRIDGE_HANDLERS`); the implementation lives in the sibling `bridge/`
 * folder, split by responsibility (SPEC wave 0R.2):
 *   - `bridge/legs.ts`      - param adaptation, provider request, route key,
 *   - `bridge/fee-leg.ts`   - the Vex fee disclosure and its collection leg,
 *   - `bridge/broadcast.ts` - the ORIGIN-ONLY staged broadcast loop,
 *   - `bridge/results.ts`   - every agent-facing body,
 *   - `bridge/recording.ts` - the best-effort durable-ledger side effects.
 *
 * Relay is a KEYLESS cross-chain bridge and the ONLY route to/from Robinhood
 * Chain (Khalani does not cover 4663); elsewhere it is the alternative venue to
 * Khalani, always callable (owner decision D4). `relay.bridge` migrates the OLD
 * proj_activity capture onto
 * the durable `agent_activity` bridge ledger:
 *
 *  1. Pre-sign gates (all pure, all fail-closed, NONE record) run in order -
 *     W2 health gate → W2 correlation → W2 step policy. ANY gate failure aborts
 *     BEFORE any pending plan or signing, then atomically records a HASHLESS
 *     `definitively_failed` logical row (`createBridgePreBroadcastFailure`, C1).
 *  2. On passing gates, `createBridgeActivityIntent` creates the intent + every
 *     Vex-signed leg (approve/deposit) + ONE planned `bridge_fill_expected`
 *     logical row, all BEFORE signing. The DB in-flight guard (C2) rejects a
 *     second concurrent execute for the same wallet+session+route.
 *  3. EVERY signable step follows full Phase-1 staging (planned row → sign →
 *     persist hash CAS → broadcast → mark accepted, R4) via the shared
 *     `signStageBroadcast` primitive. ORIGIN-ONLY (B3): Vex signs only origin
 *     steps; the destination fill is solver-signed + externally observed.
 *  4. TRUTHFUL output (B5/§4): success-while-pending is FORBIDDEN. A broadcast +
 *     provider-pending bridge returns a NOT-final `success:false` result; the
 *     logical row STAYS pending for the W4 sweep. `executed_*` is NEVER copied
 *     from the quote; USD is the adapted quote's per-side estimate (nullable).
 *
 * CONFIRMATION SEAM (B5): W3b never confirms a bridge. Only an independently
 * VERIFIED pending→confirmed transition counts, and the W4 sweep owns that call
 * (it also owns refund terminalization and the balance-job enqueue). No
 * verification helper exists here, so the in-turn poll is INFORMATIONAL only.
 */

import { formatUnits, getAddress, type Hex } from "viem";

import { getCachedRelayChains, getRelayClient } from "@tools/relay/client.js";
import { adaptRelayQuote, type RelayBridgeQuote } from "@tools/relay/quote.js";
import { evaluateRelayRouteHealth } from "@tools/relay/health.js";
import { assertRelayQuoteCorrelation } from "@tools/relay/correlation.js";
import { classifyRelayBridgeSteps } from "@tools/relay/step-policy.js";
import { pollRelayIntentStatus, resolveRelayStepClients, type RelayStepClients } from "@tools/relay/execute.js";
import { BRIDGE_FEE_ACTIVITY_EVENT_ROLE } from "@tools/bridge-fee/index.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";
import { loadConfig } from "@config/store.js";
import {
  createBridgeActivityIntent,
  checkBridgeInFlight,
  type AgentActivityLegInput,
  type BridgeActivityLeg,
} from "@vex-agent/db/repos/agent-activity.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import { findCallerSuppliedForbiddenParam } from "@tools/khalani/request.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { ok, fail, str } from "../../handler-helpers.js";
import { bridgeRecipientRefusal } from "../../conventions.js";
import { relayChainDisplay, bridgeSideDisplay, bridgeSummaryLine, relayFeeUsdEstimate } from "./bridge-output.js";
import { BRIDGE_FAMILY, BRIDGE_TOOL_ID, PROTOCOL } from "./bridge/constants.js";
import {
  buildRequest,
  buildRoute,
  healthFailureReason,
  resolveLegs,
  stepSummaries,
  type RelayLegs,
} from "./bridge/legs.js";
import { feeNotTaken, NO_FEE_COLLECTION, relayFeeDisclosure, runRelayVexFeeLeg } from "./bridge/fee-leg.js";
import { runOriginBroadcasts, type OriginBroadcast } from "./bridge/broadcast.js";
import { maybeAutoPin, relayLegInput } from "./bridge/recording.js";
import { failPreSign, inFlightResult, pendingResult } from "./bridge/results.js";
import {
  noteHandlerPendingReason,
  recordBridgeProviderObservation,
  NO_PROVIDER_STATUS_OBSERVED,
  type ProviderStatusRecording,
} from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

/**
 * The two risk numbers an agent needs in order to DECLINE (W2c): the worst-case
 * received amount `slippageBps` actually controls, and the route's total price
 * impact (live probe: -11.53 % on a $0.18 bridge). Both are provider estimates,
 * surfaced verbatim and omitted rather than guessed when Relay sends neither.
 */
function quoteRiskNote(adapted: RelayBridgeQuote): string {
  const parts: string[] = [];
  if (adapted.totalImpactPercent) parts.push(`total price impact ${adapted.totalImpactPercent}%`);
  if (adapted.currencyOut.minimumAmountRaw) {
    parts.push(`worst-case received ${adapted.currencyOut.minimumAmountRaw} (raw units)`);
  }
  return parts.length === 0 ? "" : ` Relay estimates ${parts.join(", ")}.`;
}

/**
 * `blockProductionLagging` is ADVISORY, never a gate: Relay still accepts the
 * deposit and the sweep still terminalizes the fill, but a lagging destination
 * is precisely when a fill hangs, so the agent is told.
 */
function laggingNote(sides: readonly string[]): string {
  return sides.length === 0
    ? ""
    : ` NOTE: Relay reports block production lagging on the ${sides.join(" and ")} chain - the fill may take longer than the estimate.`;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function relayQuoteGet(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const chains = await getCachedRelayChains();
  let legs: RelayLegs;
  try {
    legs = await resolveLegs(params, chains);
  } catch (err) {
    return fail(summarizeProtocolError(err).message);
  }
  let user: string;
  try {
    user = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let quote: RelayQuoteResponse;
  try {
    quote = await getRelayClient().getQuote(buildRequest(legs, user));
  } catch (err) {
    return fail(`relay__bridge_quote_get failed: ${summarizeProtocolError(err).message}`);
  }
  if (quote.steps.length === 0) return fail("Relay returned no steps for this route.");

  const adapted = adaptRelayQuote(quote);
  const health = evaluateRelayRouteHealth(chains, legs.originChainId, legs.destinationChainId);
  const from = relayChainDisplay(legs.originChainId, chains);
  const to = relayChainDisplay(legs.destinationChainId, chains);
  const inSide = bridgeSideDisplay(adapted.currencyIn, legs.originCurrency, legs.originChainId, chains, legs.amount);
  const outSide = bridgeSideDisplay(adapted.currencyOut, legs.destinationCurrency, legs.destinationChainId, chains);

  // result.data keeps the structural fields the prequote recorder re-validates
  // (`isValidRelayQuoteShape`: provider + origin/destination + step kinds/chainIds).
  return ok({
    summary:
      `${bridgeSummaryLine(inSide, from, to)} → ~${outSide.amount ?? "?"} ${outSide.token}`
      + (outSide.usd !== null ? ` (~$${outSide.usd} out, est.)` : "")
      + (adapted.timeEstimateSeconds !== null ? `. ETA ~${adapted.timeEstimateSeconds}s.` : ".")
      + quoteRiskNote(adapted)
      + (health.serviceable ? laggingNote(health.blockProductionLagging) : ` NOTE: ${healthFailureReason(health)}`),
    provider: PROTOCOL,
    serviceable: health.serviceable,
    fromChain: from,
    toChain: to,
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    fromToken: legs.originCurrency,
    toToken: legs.destinationCurrency,
    amount: legs.requestedAmount,
    bridgedAmount: legs.amount,
    tradeType: legs.tradeType,
    amounts: { in: inSide, out: outSide },
    vexFee: relayFeeDisclosure(legs, adapted.currencyIn),
    feeUsdByBucket: adapted.feeUsdByBucket,
    estimatedTimeSeconds: adapted.timeEstimateSeconds,
    minimumAmountOutRaw: adapted.currencyOut.minimumAmountRaw,
    totalImpactPercent: adapted.totalImpactPercent,
    appliedSlippagePercent: adapted.destinationSlippagePercent,
    blockProductionLagging: health.serviceable ? health.blockProductionLagging : [],
    steps: stepSummaries(quote),
    requestId: adapted.requestId,
  });
}

async function relayBridge(
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ToolResult> {
  const chains = await getCachedRelayChains();
  let legs: RelayLegs;
  try {
    legs = await resolveLegs(params, chains);
  } catch (err) {
    return fail(summarizeProtocolError(err).message);
  }

  const from = relayChainDisplay(legs.originChainId, chains);
  const to = relayChainDisplay(legs.destinationChainId, chains);
  const fromSlug = chains.find((c) => c.id === legs.originChainId)?.name;
  const toSlug = chains.find((c) => c.id === legs.destinationChainId)?.name;
  const route = buildRoute(legs);
  const dryRun = params.dryRun === true;

  // Selected wallet ADDRESS only (never decrypts) - recorded on failure rows and
  // used for the in-flight pre-check before we resolve the full signing wallet.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  // relay.bridge is a mutating tool - a session is always present by the time it
  // dispatches; guard defensively and narrow it for recording.
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${BRIDGE_TOOL_ID} requires an active session.`);

  // Pre-quote leg inputs (addresses only; refined with symbols once the quote lands).
  let originLeg: AgentActivityLegInput = { tokenAddress: legs.originCurrency, amountRaw: legs.amount };
  let destLeg: AgentActivityLegInput = { tokenAddress: legs.destinationCurrency };

  // ── Health gate (no quote needed) - fail fast on an unserviceable route ──
  const health = evaluateRelayRouteHealth(chains, legs.originChainId, legs.destinationChainId);
  if (!dryRun && !health.serviceable) {
    return failPreSign(route, walletAddress, sessionId, params, "chain_unsupported", healthFailureReason(health), from, to, originLeg, destLeg);
  }

  // ── Quote (v2) ──
  let quote: RelayQuoteResponse;
  try {
    quote = await getRelayClient().getQuote(buildRequest(legs, walletAddress));
  } catch (err) {
    const reason = summarizeProtocolError(err).message;
    if (dryRun) return fail(`${BRIDGE_TOOL_ID} preview failed: ${reason}`);
    return failPreSign(route, walletAddress, sessionId, params, "bridge_failed", reason, from, to, originLeg, destLeg);
  }
  if (quote.steps.length === 0) {
    if (dryRun) return fail("Relay returned no steps for this route.");
    return failPreSign(route, walletAddress, sessionId, params, "route_not_found", "Relay returned no steps for this route.", from, to, originLeg, destLeg);
  }

  const adapted = adaptRelayQuote(quote);
  const inSide = bridgeSideDisplay(adapted.currencyIn, legs.originCurrency, legs.originChainId, chains, legs.amount);
  const outSide = bridgeSideDisplay(adapted.currencyOut, legs.destinationCurrency, legs.destinationChainId, chains);
  originLeg = relayLegInput(adapted.currencyIn, legs.originCurrency, legs.amount);
  destLeg = relayLegInput(adapted.currencyOut, legs.destinationCurrency);

  const correlation = assertRelayQuoteCorrelation(quote, loadConfig().services.relayApiUrl);
  const policy = classifyRelayBridgeSteps(quote, legs.originChainId);

  if (dryRun) {
    return ok({
      dryRun: true,
      summary: `${bridgeSummaryLine(inSide, from, to)} → ~${outSide.amount ?? "?"} ${outSide.token}` + (outSide.usd !== null ? ` (~$${outSide.usd} out, est.)` : "") + "."
        + quoteRiskNote(adapted)
        + (health.serviceable ? laggingNote(health.blockProductionLagging) : ""),
      serviceable: health.serviceable,
      correlated: correlation.ok,
      stepsValid: policy.ok,
      fromChain: from,
      toChain: to,
      amounts: { in: inSide, out: outSide },
      vexFee: relayFeeDisclosure(legs, adapted.currencyIn),
      feeUsdByBucket: adapted.feeUsdByBucket,
      estimatedTimeSeconds: adapted.timeEstimateSeconds,
      minimumAmountOutRaw: adapted.currencyOut.minimumAmountRaw,
      totalImpactPercent: adapted.totalImpactPercent,
      appliedSlippagePercent: adapted.destinationSlippagePercent,
      steps: stepSummaries(quote),
      requestId: adapted.requestId,
    });
  }

  // ── Pre-sign gates (fail-closed, hashless failure row, C1) ──
  if (!correlation.ok) {
    return failPreSign(route, walletAddress, sessionId, params, "bridge_failed", correlation.detail, from, to, originLeg, destLeg);
  }
  if (!policy.ok) {
    return failPreSign(route, walletAddress, sessionId, params, "bridge_failed", policy.detail, from, to, originLeg, destLeg);
  }
  const signable = policy.steps;
  const depositIndex = signable.findIndex((s) => s.role === "bridge_deposit");
  if (depositIndex === -1 || depositIndex !== signable.length - 1) {
    return failPreSign(
      route, walletAddress, sessionId, params, "bridge_failed",
      "Relay quote is not a plain bridge (an origin deposit as the final signable step is required).",
      from, to, originLeg, destLeg,
    );
  }

  // Friendly in-flight pre-check (C2) - the authoritative gate is the DB unique
  // index inside createBridgeActivityIntent; this just fails fast + friendly.
  const preCheck = await checkBridgeInFlight({ walletAddress, sessionId: sessionId, route });
  if (preCheck.inFlight) return inFlightResult(from, to);

  // Full signing wallet (decrypts) - resolved only now that the call may sign.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  const expectedFrom = getAddress(signer.address);

  // ── Origin signing clients - resolved BEFORE the intent (blocker 3) ──
  // Client/registry/RPC resolution is the last thing that can fail before a
  // pending plan exists. Doing it PRE-intent means a registry/RPC/construction
  // failure records a HASHLESS `definitively_failed` row (C1) and never strands a
  // pending plan or takes the in-flight guard. Relay-only origin chains (absent
  // from local + Khalani) build a credential-free, SSRF-validated client from the
  // Relay `/chains` registry (blocker 5) rather than deterministically failing.
  let clients: RelayStepClients;
  try {
    clients = await resolveRelayStepClients(legs.originChainId, signer.privateKey as Hex, chains);
  } catch (err) {
    return failPreSign(
      route, walletAddress, sessionId, params, "bridge_failed",
      `Relay could not resolve a signing client for the origin chain: ${summarizeProtocolError(err).message}`,
      from, to, originLeg, destLeg,
    );
  }

  // ── Atomic intent + all legs + ONE planned logical row, BEFORE any signing ──
  //
  // The Vex fee transfer is planned as the FINAL Vex-signed leg, after the
  // deposit - a bridge that never lands never pays a fee. It is recorded under
  // its own `bridge_fee` event_role (migration 050; `allowance` before that -
  // see `BRIDGE_FEE_ACTIVITY_EVENT_ROLE`); its token, amount, USD estimate and
  // hash are the real ones, so the movement is neither hidden nor mislabeled.
  const chargeFee = legs.feeSkipReason === null;
  const feeLegInput: AgentActivityLegInput = {
    ...originLeg,
    amountRaw: legs.feeSplit.feeRaw.toString(),
    ...(adapted.currencyIn.decimals !== null
      ? { amountHuman: formatUnits(legs.feeSplit.feeRaw, adapted.currencyIn.decimals) }
      : { amountHuman: undefined }),
  };
  const activityLegs: BridgeActivityLeg[] = signable.map((s, i) => ({
    eventIndex: i,
    eventRole: s.role,
    chainId: legs.originChainId,
    chainSlug: fromSlug,
    chainFamily: BRIDGE_FAMILY,
    tokenIn: originLeg,
  }));
  const feeLegIndex = chargeFee ? activityLegs.length : -1;
  if (chargeFee) {
    activityLegs.push({
      eventIndex: feeLegIndex,
      eventRole: BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
      chainId: legs.originChainId,
      chainSlug: fromSlug,
      chainFamily: BRIDGE_FAMILY,
      tokenIn: feeLegInput,
      // Vex's own 25 bps, recorded for the first time (migration 050), via the
      // SAME `relayFeeUsdEstimate` derivation that produces the agent-facing
      // disclosure - so the disclosed and the recorded number are one number.
      // `undefined` (never 0) when the origin side carries no readable USD.
      // It belongs on THIS leg rather than the logical row: the fee transfer
      // runs after the deposit, so this row's own status is what says whether
      // Vex was actually paid, which keeps a SUM over confirmed rows honest.
      // Pass `adapted.currencyIn` (the RelayQuoteSide every `relayFeeDisclosure`
      // call site passes), NOT the local `inSide` - that is the display
      // projection and a different type.
      usdVexFeeEst: relayFeeUsdEstimate(adapted.currencyIn, legs.feeSplit.feeRaw) ?? undefined,
      usdSource: adapted.usdSource,
    });
  }
  const created = await createBridgeActivityIntent({
    toolId: BRIDGE_TOOL_ID,
    namespace: PROTOCOL,
    protocol: PROTOCOL,
    intentParams: params,
    walletAddress,
    sessionId: sessionId,
    route,
    quoteRef: {
      requestId: correlation.requestId,
      operation: adapted.operation,
      timeEstimateSeconds: adapted.timeEstimateSeconds,
      tradeType: legs.tradeType,
      usdSource: adapted.usdSource,
      feeUsdByBucket: adapted.feeUsdByBucket,
    },
    legs: activityLegs,
    expectedFill: {
      eventIndex: activityLegs.length,
      chainId: legs.destinationChainId,
      chainSlug: toSlug,
      chainFamily: BRIDGE_FAMILY,
      tokenIn: originLeg,
      tokenOut: destLeg,
      usdInEst: adapted.currencyIn.amountUsd ?? undefined,
      usdOutEst: adapted.currencyOut.amountUsd ?? undefined,
      // No total fee USD is derived (Relay's fee buckets overlap - a sum
      // double-counts). Per-bucket USD is surfaced VERBATIM in the output.
      // Migration 050 changes nothing here: `usd_venue_fee_est` stays NULL for
      // the same reason, because a summed bucket total would be a guess, and
      // `usd_destination_prepay_est` stays NULL because Relay's buckets are
      // provider-named with no bucket Vex can honestly call a destination
      // prepay. The Vex fee is on the `bridge_fee` leg above.
      usdFeeEst: undefined,
      usdSource: adapted.usdSource,
    },
  });
  if (created.outcome === "in_flight_conflict") return inFlightResult(from, to);
  const { executionId, legs: legRows, expectedFill: logicalRow } = created;
  const requestId = correlation.requestId;

  /** The pending body, bound to this call's display context. */
  const pending = (args: {
    broadcasts: readonly OriginBroadcast[];
    poll: Parameters<typeof pendingResult>[0]["poll"];
    depositUnconfirmed: boolean;
    feeCollection: Parameters<typeof pendingResult>[0]["feeCollection"];
    /** Absent on every path that never polled - nothing was read, so nothing was recorded. */
    providerStatusRecording?: ProviderStatusRecording;
  }): ToolResult =>
    pendingResult({
      executionId, requestId, from, to, inSide, outSide, feeUsdByBucket: adapted.feeUsdByBucket,
      broadcasts: args.broadcasts, poll: args.poll, depositUnconfirmed: args.depositUnconfirmed,
      vexFee: relayFeeDisclosure(legs, adapted.currencyIn), feeCollection: args.feeCollection,
      providerStatusRecording: args.providerStatusRecording ?? NO_PROVIDER_STATUS_OBSERVED,
    });

  const run = await runOriginBroadcasts({
    signable, legRows, logicalRowId: logicalRow.id, executionId, requestId, legs, clients,
    expectedFrom, walletAddress, feeLegIndex, from, to,
    feeNotTaken: feeNotTaken(legs), pending,
  });
  if (run.kind === "ended") return run.result;
  const broadcasts = run.broadcasts;

  // Deposit confirmed on origin. Auto-pin (fail-soft) then run the INFORMATIONAL
  // in-turn poll - it never confirms/terminalizes the durable row (W4 owns the
  // verified pending→confirmed + reveal-clear). The logical row stays pending.
  await maybeAutoPin(walletAddress, legs);
  logger.info("relay.bridge.deposit_confirmed", {
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    executionId,
  });
  // R1 Step 4: the logical row is pending for a reason the fallback can route
  // on - the destination fill is the PROVIDER's word and nothing here has proven
  // it. Before 067 this row was pending with no stated reason at all.
  await noteHandlerPendingReason("relay.bridge", logicalRow.id, "provider_fill_unverified");

  // Vex fee leg - LAST, and only now: the deposit is confirmed and its
  // requestId is attached, so collecting the fee cannot delay or alter Relay's
  // own fill tracking (separate lifecycles sharing one plan). Its outcome
  // NEVER changes the bridge's: a fee that does not land is missed Vex
  // revenue on a bridge that DID happen.
  const feeCollection = feeLegIndex === -1
    ? NO_FEE_COLLECTION
    : await runRelayVexFeeLeg({
        executionId,
        legRowId: legRows[feeLegIndex]?.id,
        feeLegIndex,
        tokenAddress: legs.originCurrency,
        feeRaw: legs.feeSplit.feeRaw,
        clients,
        broadcasts,
      });

  const poll = await pollRelayIntentStatus(requestId);
  // R1 Step 3a: persist what the provider actually said, so `AgentScan` is fed
  // at return instead of waiting for the next sweep. `observed:false` means
  // every status call this turn threw - there is no status to record, and
  // recording the placeholder would invent one.
  const providerStatusRecording = poll.observed
    ? await recordBridgeProviderObservation({
      toolId: "relay.bridge", executionId, providerStatus: poll.status,
    })
    : NO_PROVIDER_STATUS_OBSERVED;
  return pending({ broadcasts, poll, depositUnconfirmed: false, feeCollection, providerStatusRecording });
}

/**
 * Reject a caller-supplied fund destination BY NAME, on BOTH Relay entry
 * points, before anything else runs.
 *
 * Two keys, one doctrine. `refundTo` decides where funds land when a bridge
 * FAILS; `recipient` decides where they land when it SUCCEEDS. Neither is a
 * parameter: both are derived from the session's selected EVM wallet (Relay v1
 * is EVM-only, so source, destination and refund are the same account).
 *
 * Rejecting on the QUOTE matters as much as on the execute: the prequote gate
 * binds the quote's params, so an attacker who set the same address on both
 * would collide the hashes and pass the gate. A silent drop would hide the
 * attempt entirely. `relay.bridge` and `relay.quote.get` are directly reachable
 * through `execute_tool`, so the alias-level rejection is not sufficient on its
 * own - and the manifest boundary (`runtime/params.ts`), which refuses the
 * undeclared `recipient` key BEFORE this handler and before the prequote gate,
 * cannot name the address the bridge would actually deliver to. This can.
 *
 * The destination address is resolved ONLY when the key was supplied: an
 * ordinary call must not change its wallet-resolution order, and a supplied
 * `recipient` under a session with no selected EVM wallet fails closed with the
 * ordinary wallet-scope refusal rather than an invented address.
 */
function rejectCallerSuppliedDestination(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): ToolResult | null {
  const forbidden = findCallerSuppliedForbiddenParam(params);
  if (forbidden !== null) {
    return {
      success: false,
      output: `${toolId} failed: ${forbidden.param} is not an accepted parameter - ${forbidden.reason} Remove it and retry.`,
    };
  }
  if (str(params, "recipient") === "") return null;
  let destination: string;
  try {
    destination = resolveSelectedAddress(context.walletResolution, context.walletPolicy, BRIDGE_FAMILY);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  return { success: false, output: bridgeRecipientRefusal(toolId, destination) };
}

export const RELAY_BRIDGE_HANDLERS: Record<string, ProtocolHandler> = {
  "relay.quote.get": async (p, ctx) =>
    rejectCallerSuppliedDestination("relay.quote.get", p, ctx) ?? relayQuoteGet(p, ctx),
  "relay.bridge": async (p, ctx) =>
    rejectCallerSuppliedDestination("relay.bridge", p, ctx) ?? relayBridge(p, ctx),
};
