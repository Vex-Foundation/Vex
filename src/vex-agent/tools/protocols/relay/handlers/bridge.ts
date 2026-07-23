/**
 * Relay bridge handlers — quote.get (read) + bridge (mutating), on the W-SPINE
 * `agent_activity` contract (Wave-3 W3b).
 *
 * Relay is a KEYLESS cross-chain bridge and the direct route to/from Robinhood
 * Chain (Khalani does not cover 4663); as the general-purpose fallback it is
 * reveal-gated (W5). `relay.bridge` migrates the OLD proj_activity capture onto
 * the durable `agent_activity` bridge ledger:
 *
 *  1. Pre-sign gates (all pure, all fail-closed, NONE record) run in order —
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
 * REVEAL-CLEAR SEAM (B5): W3b NEVER clears the route reveal — not on broadcast,
 * pending, or an in-turn provider status (even 'success'). Only an independently
 * VERIFIED pending→confirmed clears it, and the W4 sweep owns that call (it also
 * owns pending→confirmed, refund terminalization, and the balance-job enqueue).
 * W3b leaves the confirmation to that verified path; no verification helper
 * exists here, so the in-turn poll is INFORMATIONAL only.
 */

import { getAddress, isAddress, type Hex } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getCachedRelayChains, getRelayClient } from "@tools/relay/client.js";
import { resolveRelayChainId, toRelayCurrency, RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import { adaptRelayQuote, type RelayQuoteSide } from "@tools/relay/quote.js";
import { evaluateRelayRouteHealth, type RelayRouteHealth } from "@tools/relay/health.js";
import { assertRelayQuoteCorrelation } from "@tools/relay/correlation.js";
import { classifyRelayBridgeSteps, type RelayStepRole } from "@tools/relay/step-policy.js";
import { planRelayStepTx, resolveRelayStepClients, pollRelayIntentStatus, type RelayPollResult, type RelayStepClients } from "@tools/relay/execute.js";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import type { RelayChain, RelayQuoteRequest, RelayQuoteResponse, RelayTradeType } from "@tools/relay/types.js";
import { loadConfig } from "@config/store.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import {
  createBridgeActivityIntent,
  createBridgePreBroadcastFailure,
  checkBridgeInFlight,
  attachProviderOrderId,
  markActivityBroadcast,
  markBroadcastAccepted,
  confirmActivityEvent,
  failActivityEvent,
  abortPlannedEvents,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
  type BridgeActivityLeg,
  type BridgeRouteEndpoints,
} from "@vex-agent/db/repos/agent-activity.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";
import {
  relayChainDisplay,
  bridgeSideDisplay,
  bridgeSummaryLine,
  type BridgeAmountDisplay,
  type BridgeEndpointDisplay,
  type BridgeOutputLeg,
} from "./bridge-output.js";

const PROTOCOL = "relay";
const BRIDGE_TOOL_ID = "relay.bridge";
const BRIDGE_FAMILY = "eip155" as const;

interface RelayLegs {
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: RelayTradeType;
}

/** Distinct tx chainIds per step — the structural shape the prequote recorder re-validates. */
function stepSummaries(quote: RelayQuoteResponse): Array<{ id: string; kind: string; chainIds: number[] }> {
  return quote.steps.map((step) => {
    const chainIds = new Set<number>();
    for (const item of step.items) {
      if (item.data) chainIds.add(item.data.chainId);
    }
    return { id: step.id, kind: step.kind, chainIds: [...chainIds] };
  });
}

async function resolveLegs(
  params: Record<string, unknown>,
  chains: readonly RelayChain[],
): Promise<RelayLegs> {
  const fromChain = str(params, "fromChain"), toChain = str(params, "toChain");
  const fromToken = str(params, "fromToken"), toToken = str(params, "toToken");
  const amount = str(params, "amount");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    throw new Error("Missing required: fromChain, fromToken, toChain, toToken, amount");
  }
  // Widened trade type (W2/R10): pass EXPECTED_OUTPUT through when the user asks
  // for it (Relay's recommended plain-bridge mode); default stays EXACT_INPUT so
  // `amount` reads as the source amount and the prequote identity (same default)
  // still collides.
  const tradeTypeRaw = str(params, "tradeType");
  const tradeType: RelayTradeType =
    tradeTypeRaw === "EXACT_OUTPUT" ? "EXACT_OUTPUT"
    : tradeTypeRaw === "EXPECTED_OUTPUT" ? "EXPECTED_OUTPUT"
    : "EXACT_INPUT";
  return {
    originChainId: resolveRelayChainId(fromChain, chains),
    destinationChainId: resolveRelayChainId(toChain, chains),
    originCurrency: toRelayCurrency(fromToken),
    destinationCurrency: toRelayCurrency(toToken),
    amount,
    tradeType,
  };
}

function buildRequest(legs: RelayLegs, user: string, params: Record<string, unknown>): RelayQuoteRequest {
  const recipient = str(params, "recipient") || user;
  const refundTo = str(params, "refundTo") || user;
  const slippage = str(params, "slippageBps");
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
    ...(slippage ? { slippageTolerance: slippage } : {}),
  };
}

/**
 * The route endpoints, built from the SAME (chainId, family, toRelayCurrency)
 * tuples W5's `resolveRelayRevealRoute` uses (key-consistency contract) — so the
 * stored `normalized_route` round-trips with the reveal key and W4's
 * `clearRelayRouteReveal` hits. Diverging would only fail closed (the reveal
 * never applies), never over-grant.
 */
function buildRoute(legs: RelayLegs): BridgeRouteEndpoints {
  return {
    fromChainId: legs.originChainId,
    fromChainFamily: BRIDGE_FAMILY,
    fromToken: legs.originCurrency,
    toChainId: legs.destinationChainId,
    toChainFamily: BRIDGE_FAMILY,
    toToken: legs.destinationCurrency,
  };
}

/** Repo leg input from an adapted quote side (quoted amounts — never executed truth). */
function relayLegInput(side: RelayQuoteSide, currencyAddress: string, rawFallback?: string): AgentActivityLegInput {
  return {
    tokenAddress: currencyAddress,
    tokenSymbol: side.symbol ?? undefined,
    tokenDecimals: side.decimals ?? undefined,
    amountHuman: side.amountFormatted ?? undefined,
    amountRaw: side.amountRaw ?? rawFallback,
  };
}

function healthFailureReason(health: Extract<RelayRouteHealth, { serviceable: false }>): string {
  const side = health.failedSide === "origin" ? "origin" : "destination";
  const reasons: Record<string, string> = {
    chain_not_found: `the ${side} chain (${health.chainId}) is not in Relay's live chain registry`,
    vm_type_not_evm: `the ${side} chain (${health.chainId}) is not an EVM chain (out of scope this phase)`,
    deposit_not_enabled: `deposits are not currently enabled on the ${side} chain (${health.chainId})`,
    chain_disabled: `the ${side} chain (${health.chainId}) is currently disabled on Relay`,
  };
  return `Relay cannot service this route: ${reasons[health.reason] ?? `the ${side} chain is unavailable`}.`;
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
    return fail(err instanceof Error ? err.message : String(err));
  }
  let user: string;
  try {
    user = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  let quote: RelayQuoteResponse;
  try {
    quote = await getRelayClient().getQuote(buildRequest(legs, user, params));
  } catch (err) {
    return fail(`relay.quote.get failed: ${summarizeProtocolError(err).message}`);
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
      + (health.serviceable ? "" : ` NOTE: ${healthFailureReason(health)}`),
    provider: PROTOCOL,
    serviceable: health.serviceable,
    fromChain: from,
    toChain: to,
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    fromToken: legs.originCurrency,
    toToken: legs.destinationCurrency,
    amount: legs.amount,
    tradeType: legs.tradeType,
    amounts: { in: inSide, out: outSide },
    feeUsdByBucket: adapted.feeUsdByBucket,
    estimatedTimeSeconds: adapted.timeEstimateSeconds,
    steps: stepSummaries(quote),
    requestId: adapted.requestId,
  });
}

/** Pre-sign gate/validation failure → hashless `definitively_failed` logical row (R15/C1). */
async function failPreSign(
  route: BridgeRouteEndpoints,
  walletAddress: string,
  sessionId: string,
  params: Record<string, unknown>,
  failureCode: AgentActivityFailureCode,
  reason: string,
  from: BridgeEndpointDisplay,
  to: BridgeEndpointDisplay,
  tokenIn: AgentActivityLegInput | undefined,
  tokenOut: AgentActivityLegInput | undefined,
): Promise<ToolResult> {
  const { executionId } = await createBridgePreBroadcastFailure({
    toolId: BRIDGE_TOOL_ID,
    namespace: PROTOCOL,
    protocol: PROTOCOL,
    intentParams: params,
    walletAddress,
    sessionId,
    route,
    tokenIn,
    tokenOut,
    failureCode,
    failureReason: reason,
  });
  const body = {
    status: "rejected",
    summary: `Relay could not bridge from ${from.name} to ${to.name}: ${reason}`,
    message: `${reason} No funds were moved and nothing was signed.`,
    fromChain: from,
    toChain: to,
  };
  return { success: false, output: JSON.stringify(body, null, 2), data: { ...body, _executionId: executionId } };
}

/** A prior bridge already occupies this wallet+session+route slot (C2). Nothing recorded for this attempt. */
function inFlightResult(from: BridgeEndpointDisplay, to: BridgeEndpointDisplay): ToolResult {
  const body = {
    status: "in_flight",
    summary: `A bridge is already in flight for this route (${from.name} → ${to.name}).`,
    message:
      `A bridge is already in flight for this route (${from.name} → ${to.name}). `
      + "Wait for it to finalize before starting another — Vex is tracking it automatically. Do NOT re-bridge.",
    fromChain: from,
    toChain: to,
  };
  return { success: false, output: JSON.stringify(body, null, 2), data: body };
}

/** Fail-soft auto-pin: an ERC-20 bridged ONTO a local chain joins tracked_tokens so balance scans see it when it lands. */
async function maybeAutoPin(walletAddress: string, legs: RelayLegs): Promise<void> {
  if (!getLocalChain(legs.destinationChainId)) return;
  if (legs.destinationCurrency === RELAY_NATIVE_CURRENCY || !isAddress(legs.destinationCurrency)) return;
  try {
    await pinTrackedToken({
      walletAddress,
      chainId: legs.destinationChainId,
      tokenAddress: getAddress(legs.destinationCurrency),
      source: "bridge",
    });
  } catch (err) {
    logger.warn("relay.bridge.auto_pin_failed", {
      chainId: legs.destinationChainId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

interface OriginBroadcast {
  readonly role: RelayStepRole;
  readonly txHash: string;
  // `confirmed_unrecorded` (m5-relay / Phase-1 C41): the origin tx confirmed
  // on-chain but Vex's durable confirm write did NOT apply — never present it as
  // an ordinary confirmation.
  readonly status: "confirmed" | "confirmed_unrecorded" | "broadcast_unconfirmed" | "reverted";
}

function outputLegs(
  broadcasts: readonly OriginBroadcast[],
  from: BridgeEndpointDisplay,
  to: BridgeEndpointDisplay,
  fillStatus: string,
  fillTxHash: string | null,
): BridgeOutputLeg[] {
  const legs: BridgeOutputLeg[] = broadcasts.map((b) => ({
    role: b.role,
    chainId: from.id,
    chainName: from.name,
    txHash: b.txHash,
    status: b.status,
  }));
  legs.push({ role: "bridge_fill_expected", chainId: to.id, chainName: to.name, txHash: fillTxHash, status: fillStatus });
  return legs;
}

/**
 * Truthful pending result (B5/C3): the origin deposit was broadcast but the
 * bridge is NOT final — `success:false` so the runtime never seeds balances for
 * a pending bridge (C3) and the model never reads it as completion. The logical
 * row stays pending for the W4 sweep. The last in-turn provider status is
 * surfaced honestly (incl. a refund/failure distinction) but NEVER terminalizes
 * the durable row here.
 */
function pendingResult(args: {
  executionId: number;
  requestId: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  inSide: BridgeAmountDisplay;
  outSide: BridgeAmountDisplay;
  feeUsdByBucket: Record<string, string>;
  broadcasts: readonly OriginBroadcast[];
  poll: RelayPollResult | null;
  depositUnconfirmed: boolean;
}): ToolResult {
  const { executionId, requestId, from, to, inSide, outSide, feeUsdByBucket, broadcasts, poll } = args;
  const providerStatus = poll?.observed ? poll.status : null;
  const destinationTxHashes = poll?.destinationTxHashes ?? [];
  const fillTxHash = destinationTxHashes[0] ?? null;
  const inTxHashes = broadcasts.map((b) => b.txHash);

  const depositState = args.depositUnconfirmed
    ? "the origin deposit was broadcast but Vex could not yet confirm it on-chain"
    : "the origin deposit is confirmed on-chain";
  let message: string;
  let fillStatus = "pending";
  if (providerStatus === "refund") {
    fillStatus = "reported_refund";
    message =
      `Relay currently reports this bridge as REFUNDED — the destination amount did NOT arrive and funds are being returned to your refund address. `
      + `Money back is NOT a successful bridge. Vex will independently verify and finalize this record automatically. Do NOT re-bridge.`;
  } else if (providerStatus === "failure") {
    fillStatus = "reported_failure";
    message =
      `Relay currently reports this bridge as FAILED — the destination amount did NOT arrive. `
      + `Vex will independently verify and finalize this record automatically; check the request id before any manual action. Do NOT re-bridge.`;
  } else if (providerStatus === "success") {
    fillStatus = "reported_success";
    message =
      `${depositState}; Relay reports the destination fill succeeded. Vex will independently verify and finalize the record automatically — `
      + `treat it as in progress until then. Do NOT re-bridge.`;
  } else {
    message =
      `${depositState}; the destination fill is in progress${providerStatus ? ` (last status: ${providerStatus})` : ""} — Vex is tracking it automatically `
      + `and will finalize the record once the fill is independently verified. Do NOT re-bridge.`;
  }

  const body = {
    status: "pending",
    summary: `${bridgeSummaryLine(inSide, from, to)}. ${depositState}; destination fill in progress — tracked automatically.`,
    message,
    fromChain: from,
    toChain: to,
    requestId,
    providerStatus,
    legs: outputLegs(broadcasts, from, to, fillStatus, fillTxHash),
    inTxHashes,
    txHashes: destinationTxHashes,
    amounts: { in: inSide, out: outSide },
    feeUsdByBucket,
  };
  return {
    success: false,
    output: JSON.stringify(body, null, 2),
    data: {
      ...body,
      _executionId: executionId,
      // Per-hop explorer refs (model-invisible UI deep-links): only Vex's OWN
      // verified origin broadcasts are coherently chain-paired; the provider
      // destination hash is unverified and stays out of this clickable set.
      _explorerRefs: broadcasts.map((b) => ({ chain: String(from.id), txRef: b.txHash })),
    },
  };
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
    return fail(err instanceof Error ? err.message : String(err));
  }

  const from = relayChainDisplay(legs.originChainId, chains);
  const to = relayChainDisplay(legs.destinationChainId, chains);
  const fromSlug = chains.find((c) => c.id === legs.originChainId)?.name;
  const toSlug = chains.find((c) => c.id === legs.destinationChainId)?.name;
  const route = buildRoute(legs);
  const dryRun = params.dryRun === true;

  // Selected wallet ADDRESS only (never decrypts) — recorded on failure rows and
  // used for the in-flight pre-check before we resolve the full signing wallet.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  // relay.bridge is a mutating, reveal-gated tool — a session is always present
  // by the time it dispatches; guard defensively and narrow it for recording.
  const sessionId = context.sessionId;
  if (!sessionId) return fail(`${BRIDGE_TOOL_ID} requires an active session.`);

  // Pre-quote leg inputs (addresses only; refined with symbols once the quote lands).
  let originLeg: AgentActivityLegInput = { tokenAddress: legs.originCurrency, amountRaw: legs.amount };
  let destLeg: AgentActivityLegInput = { tokenAddress: legs.destinationCurrency };

  // ── Health gate (no quote needed) — fail fast on an unserviceable route ──
  const health = evaluateRelayRouteHealth(chains, legs.originChainId, legs.destinationChainId);
  if (!dryRun && !health.serviceable) {
    return failPreSign(route, walletAddress, sessionId, params, "chain_unsupported", healthFailureReason(health), from, to, originLeg, destLeg);
  }

  // ── Quote (v2) ──
  let quote: RelayQuoteResponse;
  try {
    quote = await getRelayClient().getQuote(buildRequest(legs, walletAddress, params));
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
      summary: `${bridgeSummaryLine(inSide, from, to)} → ~${outSide.amount ?? "?"} ${outSide.token}` + (outSide.usd !== null ? ` (~$${outSide.usd} out, est.)` : "") + ".",
      serviceable: health.serviceable,
      correlated: correlation.ok,
      stepsValid: policy.ok,
      fromChain: from,
      toChain: to,
      amounts: { in: inSide, out: outSide },
      feeUsdByBucket: adapted.feeUsdByBucket,
      estimatedTimeSeconds: adapted.timeEstimateSeconds,
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

  // Friendly in-flight pre-check (C2) — the authoritative gate is the DB unique
  // index inside createBridgeActivityIntent; this just fails fast + friendly.
  const preCheck = await checkBridgeInFlight({ walletAddress, sessionId: sessionId, route });
  if (preCheck.inFlight) return inFlightResult(from, to);

  // Full signing wallet (decrypts) — resolved only now that the call may sign.
  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
  const expectedFrom = getAddress(signer.address);

  // ── Origin signing clients — resolved BEFORE the intent (blocker 3) ──
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
  const activityLegs: BridgeActivityLeg[] = signable.map((s, i) => ({
    eventIndex: i,
    eventRole: s.role,
    chainId: legs.originChainId,
    chainSlug: fromSlug,
    chainFamily: BRIDGE_FAMILY,
    tokenIn: originLeg,
  }));
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
      eventIndex: signable.length,
      chainId: legs.destinationChainId,
      chainSlug: toSlug,
      chainFamily: BRIDGE_FAMILY,
      tokenIn: originLeg,
      tokenOut: destLeg,
      usdInEst: adapted.currencyIn.amountUsd ?? undefined,
      usdOutEst: adapted.currencyOut.amountUsd ?? undefined,
      // No total fee USD is derived (Relay's fee buckets overlap — a sum
      // double-counts). Per-bucket USD is surfaced VERBATIM in the output.
      usdFeeEst: undefined,
      usdSource: adapted.usdSource,
    },
  });
  if (created.outcome === "in_flight_conflict") return inFlightResult(from, to);
  const { executionId, legs: legRows, expectedFill: logicalRow } = created;
  const requestId = correlation.requestId;

  // ── Staged broadcast loop (ORIGIN-ONLY, R4). Clients are already resolved
  // (pre-intent, blocker 3). Any post-intent throw aborts the remaining
  // never-signed rows and returns with the SAME _executionId (never a second
  // execution). ──
  const broadcasts: OriginBroadcast[] = [];
  let currentIndex = 0;
  try {
    for (let i = 0; i < signable.length; i++) {
      currentIndex = i;
      const stepEntry = signable[i]!;
      const legRow = legRows[i]!;
      const txParams = planRelayStepTx(stepEntry.step, legs.originChainId, expectedFrom);
      const outcome = await signStageBroadcast(clients.publicClient, clients.walletClient, txParams, {
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(legRow.id, handles);
          if (!res.applied) {
            // A CAS miss means the row is no longer the pending/hashless row we
            // expect — refuse to broadcast an UNTRACKED transaction (throwing
            // here aborts signStageBroadcast BEFORE sendRawTransaction).
            throw new Error(`markActivityBroadcast CAS miss for leg ${legRow.id} — refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(legRow.id);
          if (!res.applied) logger.warn("relay.bridge.broadcast_accept_miss", { id: legRow.id });
        },
      });

      if (outcome.kind === "reverted") {
        broadcasts.push({ role: stepEntry.role, txHash: outcome.txHash, status: "reverted" });
        await failActivityEvent(legRow.id, {
          failureCode: "bridge_failed",
          failureReason: `origin ${stepEntry.role} transaction ${outcome.txHash} reverted on-chain.`,
        });
        await failActivityEvent(logicalRow.id, {
          failureCode: "bridge_failed",
          failureReason: `origin ${stepEntry.role} reverted (${outcome.txHash}); the bridge did not execute.`,
        });
        await abortRemaining(executionId, i + 1, `earlier ${stepEntry.role} reverted`);
        const body = {
          status: "failed",
          summary: `Relay bridge failed: the origin ${stepEntry.role} reverted on-chain. No funds were bridged.`,
          message:
            `The origin ${stepEntry.role} transaction (${outcome.txHash}) reverted on-chain — the bridge did not execute and no destination fill will occur. No funds left the origin chain.`,
          fromChain: from,
          toChain: to,
          requestId,
          legs: outputLegs(broadcasts, from, to, "not_reached", null),
          inTxHashes: broadcasts.map((b) => b.txHash),
        };
        return {
          success: false,
          output: JSON.stringify(body, null, 2),
          data: { ...body, _executionId: executionId, _explorerRefs: broadcasts.map((b) => ({ chain: String(from.id), txRef: b.txHash })) },
        };
      }

      if (outcome.kind === "ambiguous") {
        broadcasts.push({ role: stepEntry.role, txHash: outcome.txHash, status: "broadcast_unconfirmed" });
        if (stepEntry.role === "bridge_deposit") {
          // Deposit in-flight → attach the order id so W4 can track it, leave the
          // logical row PENDING, and DO NOT poll (the origin receipt is itself
          // uncertain). Deposit is the last signable step, so nothing follows.
          await attachRequestIdBestEffort(executionId, requestId);
          await maybeAutoPin(walletAddress, legs);
          return pendingResult({
            executionId, requestId, from, to, inSide, outSide, feeUsdByBucket: adapted.feeUsdByBucket,
            broadcasts, poll: null, depositUnconfirmed: true,
          });
        }
        // An ambiguous APPROVE means the deposit will not be signed → the bridge
        // will not execute; abort the deposit + logical row as not-attempted.
        // The approve leg keeps its staged hash (the receipt sweep owns it).
        await abortRemaining(executionId, i + 1, `${stepEntry.role} could not be confirmed`);
        const body = {
          status: "unconfirmed",
          summary: `Relay bridge not attempted: the token approval could not be confirmed.`,
          message:
            `The token approval (${outcome.txHash}) could not be confirmed on-chain, so the bridge deposit was NOT signed and no funds were bridged. The approval may still settle; do NOT retry until you have verified its status.`,
          fromChain: from,
          toChain: to,
          legs: outputLegs(broadcasts, from, to, "not_reached", null),
          inTxHashes: broadcasts.map((b) => b.txHash),
        };
        return {
          success: false,
          output: JSON.stringify(body, null, 2),
          data: { ...body, _executionId: executionId, _explorerRefs: broadcasts.map((b) => ({ chain: String(from.id), txRef: b.txHash })) },
        };
      }

      // confirmed on origin — but never present an UNRECORDED confirmation as
      // ordinary (m5-relay / Phase-1 C41): the on-chain tx is confirmed, yet if
      // the durable confirm CAS misses to a non-confirmed state (the row is no
      // longer the pending row we expect), Vex's own record did not capture it.
      // `applied:false` with the row already `confirmed` is a benign race (a
      // repair sweep beat us) and stays ordinary; any other state is surfaced as
      // `confirmed_unrecorded`.
      let legStatus: OriginBroadcast["status"] = "confirmed";
      try {
        const confirmResult = await confirmActivityEvent(legRow.id, {});
        if (!confirmResult.applied && confirmResult.row.status !== "confirmed") {
          legStatus = "confirmed_unrecorded";
          logger.warn("relay.bridge.leg_confirm_cas_miss", { id: legRow.id, rowStatus: confirmResult.row.status });
        }
      } catch (err) {
        legStatus = "confirmed_unrecorded";
        logger.warn("relay.bridge.leg_confirm_failed", { id: legRow.id, error: summarizeProtocolError(err).message });
      }
      broadcasts.push({ role: stepEntry.role, txHash: outcome.txHash, status: legStatus });
      if (stepEntry.role === "bridge_deposit") {
        await attachRequestIdBestEffort(executionId, requestId);
      }
    }
  } catch (err) {
    // The intent already exists — abort the remaining never-signed rows (incl. the
    // logical row) and return with the SAME executionId; never create a second one.
    const safe = summarizeProtocolError(err).message;
    await abortRemaining(executionId, currentIndex, safe);
    logger.warn("relay.bridge.post_intent_failure", { executionId, index: currentIndex, error: safe });
    const body = {
      status: "interrupted",
      summary: "Relay bridge was interrupted after it was already recorded.",
      message: `An internal error interrupted the bridge after it was recorded (${safe}). Check the record (execution ${executionId}) before any further action.`,
      fromChain: from,
      toChain: to,
    };
    return { success: false, output: JSON.stringify(body, null, 2), data: { ...body, _executionId: executionId } };
  }

  // Deposit confirmed on origin. Auto-pin (fail-soft) then run the INFORMATIONAL
  // in-turn poll — it never confirms/terminalizes the durable row (W4 owns the
  // verified pending→confirmed + reveal-clear). The logical row stays pending.
  await maybeAutoPin(walletAddress, legs);
  logger.info("relay.bridge.deposit_confirmed", {
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    executionId,
  });
  const poll = await pollRelayIntentStatus(requestId);
  return pendingResult({
    executionId, requestId, from, to, inSide, outSide, feeUsdByBucket: adapted.feeUsdByBucket,
    broadcasts, poll, depositUnconfirmed: false,
  });
}

/** Attach the Relay requestId to the logical row (best-effort; also persisted in route_provenance for W4 recovery). */
async function attachRequestIdBestEffort(executionId: number, requestId: string): Promise<void> {
  try {
    const res = await attachProviderOrderId({ executionId, providerOrderId: requestId });
    if (res.outcome === "conflict_different_id" || res.outcome === "not_pending") {
      logger.warn("relay.bridge.attach_order_id_unexpected", { executionId, outcome: res.outcome });
    }
  } catch (err) {
    logger.warn("relay.bridge.attach_order_id_failed", { executionId, error: summarizeProtocolError(err).message });
  }
}

/** Abort never-signed downstream rows (best-effort; a throw here must not flip the caller's result). */
async function abortRemaining(executionId: number, fromIndex: number, reason: string): Promise<void> {
  try {
    await abortPlannedEvents(executionId, fromIndex, reason);
  } catch (err) {
    logger.warn("relay.bridge.abort_planned_failed", { executionId, fromIndex, error: summarizeProtocolError(err).message });
  }
}

export const RELAY_BRIDGE_HANDLERS: Record<string, ProtocolHandler> = {
  "relay.quote.get": (p, ctx) => relayQuoteGet(p, ctx),
  "relay.bridge": (p, ctx) => relayBridge(p, ctx),
};
