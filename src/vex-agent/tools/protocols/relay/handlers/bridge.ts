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

import { formatUnits, getAddress, isAddress, type Hex } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getCachedRelayChains, getRelayClient } from "@tools/relay/client.js";
import { resolveRelayChainId, toRelayCurrency, RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import { adaptRelayQuote, type RelayQuoteSide } from "@tools/relay/quote.js";
import { evaluateRelayRouteHealth, type RelayRouteHealth } from "@tools/relay/health.js";
import { assertRelayQuoteCorrelation } from "@tools/relay/correlation.js";
import { classifyRelayBridgeSteps, type RelayStepRole } from "@tools/relay/step-policy.js";
import { planRelayStepTx, resolveRelayStepClients, pollRelayIntentStatus, type RelayPollResult, type RelayStepClients } from "@tools/relay/execute.js";
import { relayNativeValueGuidance, relayStepLabel } from "@tools/relay/native-value.js";
import { signStageBroadcast } from "@tools/kyberswap/evm/staged-broadcast.js";
import {
  BRIDGE_FEE_ACTIVITY_EVENT_ROLE,
  BRIDGE_FEE_RECEIVER_EVM,
  buildBridgeFeeDisclosure,
  buildBridgeFeeSkippedDisclosure,
  buildEvmBridgeFeeTransfer,
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
import { parseSlippageBpsString } from "@vex-agent/tools/protocols/slippage-policy.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import { findCallerSuppliedForbiddenParam } from "@tools/khalani/request.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";
import {
  relayChainDisplay,
  bridgeSideDisplay,
  bridgeSummaryLine,
  relayFeeUsdEstimate,
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
  /**
   * The amount Relay is quoted for and deposits: the caller's `amount` MINUS
   * the Vex fee (`@tools/bridge-fee`), so `amountOut` is what the user
   * actually receives. Equal to `requestedAmount` when no fee is taken.
   */
  amount: string;
  /** The caller's `amount` verbatim — the TOTAL debited across all legs. */
  requestedAmount: string;
  feeSplit: BridgeFeeSplit;
  /** Non-null when no fee is taken; the plain-language reason, disclosed to the agent. */
  feeSkipReason: string | null;
  tradeType: RelayTradeType;
  /**
   * Validated slippage tolerance, or `null` when the caller omitted it (Relay
   * then applies its own default and we send no `slippageTolerance`). Resolved
   * ONCE in `resolveLegs` so the quote and the execute cannot disagree, and so
   * the value that reaches the provider is the same one the prequote identity
   * bound.
   */
  slippageBps: number | null;
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

/**
 * Both callers route this function's throws through `summarizeProtocolError`.
 * The text is locally authored, but `resolveRelayChainId`/`toRelayCurrency`
 * echo the MODEL-SUPPLIED `fromChain`/`toChain`/token values verbatim
 * (`Relay does not support chain "<input>".`), so a model-injected URL or
 * key-shaped string would otherwise reach tool output unredacted — untrusted
 * input at an output sink.
 */
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
  const originChainId = resolveRelayChainId(fromChain, chains);
  const originCurrency = toRelayCurrency(fromToken);

  // Vex integrator fee (`@tools/bridge-fee`) — resolved HERE so the quote
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
 * The fee, as the agent must see it on EVERY Relay surface (quote, dryRun,
 * execute). Pure projection of the already-resolved split — no second
 * derivation, so the disclosed number and the transferred number are the same
 * number by construction.
 */
function relayFeeDisclosure(legs: RelayLegs, inSide: RelayQuoteSide): BridgeFeeDisclosure {
  if (legs.feeSkipReason !== null) {
    return buildBridgeFeeSkippedDisclosure({ reason: legs.feeSkipReason, totalRaw: legs.feeSplit.totalRaw });
  }
  return buildBridgeFeeDisclosure({
    tokenAddress: legs.originCurrency,
    tokenSymbol: inSide.symbol ?? undefined,
    tokenDecimals: inSide.decimals ?? undefined,
    feeRaw: legs.feeSplit.feeRaw,
    bridgedRaw: legs.feeSplit.bridgedRaw,
    totalRaw: legs.feeSplit.totalRaw,
    receiver: BRIDGE_FEE_RECEIVER_EVM,
    feeUsdEstimate: relayFeeUsdEstimate(inSide, legs.feeSplit.feeRaw) ?? undefined,
  });
}

/**
 * Validate the (untrusted) `slippageBps` param before it can reach Relay.
 *
 * Relay declares it as a manifest STRING, so the numeric `unit: "bps"` gate at
 * the protocol boundary never inspects it, and Relay itself performs no local
 * validation — before this check a caller could forward any string straight
 * through to `slippageTolerance`. Uses the SAME parser as the prequote identity
 * (`prequote/identity/relay-bridge.ts`) so the value the gate bound and the
 * value the provider receives can never disagree, and so Vex's slippage ceiling
 * applies here too. Omitted → `null` (Relay's own default; nothing is sent).
 * Invalid or over-ceiling → throw, which both callers already surface as a
 * clean `fail(...)` before any quote or signing.
 */
function resolveSlippageBps(params: Record<string, unknown>): number | null {
  const raw = str(params, "slippageBps");
  if (!raw) return null;
  const parsed = parseSlippageBpsString(`Parameter "slippageBps" for ${BRIDGE_TOOL_ID}`, raw);
  if (!parsed.ok) throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, parsed.reason);
  return parsed.bps;
}

function buildRequest(legs: RelayLegs, user: string, params: Record<string, unknown>): RelayQuoteRequest {
  const recipient = str(params, "recipient") || user;
  // DERIVED, never read from params — the same refund-destination policy the
  // Khalani path applies (`@tools/khalani/request.js`). `refundTo` decides where
  // funds land when a bridge FAILS and is absent from the approval preview's
  // allowlist, so a model-chosen value would redirect a refund with no human
  // ever seeing it. `user` is the resolved source wallet: the money goes back
  // where it came from, which needs no authorization. Callers that supply the
  // key are rejected by name upstream.
  const refundTo = user;
  // The VALIDATED value from `resolveLegs`, never the raw param — this is the
  // last hop before the provider, and it must carry exactly what the prequote
  // identity bound.
  const slippage = legs.slippageBps === null ? "" : String(legs.slippageBps);
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
    amount: legs.requestedAmount,
    bridgedAmount: legs.amount,
    tradeType: legs.tradeType,
    amounts: { in: inSide, out: outSide },
    vexFee: relayFeeDisclosure(legs, adapted.currencyIn),
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
  /**
   * `vex_fee` is Vex's OWN treasury transfer, not a Relay step — surfaced with
   * its own display role so the agent can tell it apart from a real approval
   * (the durable row records it under `allowance`, the closest existing
   * `event_role`; see `BRIDGE_FEE_ACTIVITY_EVENT_ROLE`).
   */
  readonly role: RelayStepRole | "vex_fee";
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
  vexFee: BridgeFeeDisclosure;
  feeCollection: RelayFeeCollection;
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
    // Disclosure + collection outcome. `collection` describes Vex's revenue
    // only — it never qualifies whether the user's bridge worked.
    vexFee: { ...args.vexFee, ...args.feeCollection },
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
    return fail(summarizeProtocolError(err).message);
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
      vexFee: relayFeeDisclosure(legs, adapted.currencyIn),
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
  //
  // The Vex fee transfer is planned as the FINAL Vex-signed leg, after the
  // deposit — a bridge that never lands never pays a fee. It is recorded under
  // its own `bridge_fee` event_role (migration 050; `allowance` before that —
  // see `BRIDGE_FEE_ACTIVITY_EVENT_ROLE`); its token, amount, USD estimate and
  // hash are the real ones, so the movement is neither hidden nor mislabeled.
  const chargeFee = legs.feeSkipReason === null;
  /** Disclosure for every path where the bridge did not complete — nothing is ever charged there. */
  const feeNotTaken = () => ({
    ...buildBridgeFeeSkippedDisclosure({
      reason: "the bridge did not complete, so no Vex fee was taken",
      totalRaw: legs.feeSplit.totalRaw,
    }),
    collection: "not_attempted",
    collectionNote: "No Vex fee was taken: the bridge did not complete.",
  });
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
      // disclosure — so the disclosed and the recorded number are one number.
      // `undefined` (never 0) when the origin side carries no readable USD.
      // It belongs on THIS leg rather than the logical row: the fee transfer
      // runs after the deposit, so this row's own status is what says whether
      // Vex was actually paid, which keeps a SUM over confirmed rows honest.
      // Pass `adapted.currencyIn` (the RelayQuoteSide every `relayFeeDisclosure`
      // call site passes), NOT the local `inSide` — that is the display
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
      // No total fee USD is derived (Relay's fee buckets overlap — a sum
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

  // ── Staged broadcast loop (ORIGIN-ONLY, R4). Clients are already resolved
  // (pre-intent, blocker 3). Any post-intent throw aborts the remaining
  // never-signed rows and returns with the SAME _executionId (never a second
  // execution). ──
  const broadcasts: OriginBroadcast[] = [];
  let currentIndex = 0;
  // Read-after-write anchor for the NEXT origin leg: the approve leg this loop
  // just confirmed is exactly the state the deposit leg's pre-sign estimate
  // depends on, and the estimating node does not always have it yet (live
  // 2026-07-25, deposit `0xc96bfee1…` — `dependent-leg-gas-estimate.ts`).
  let priorLeg: ConfirmedPriorLeg | undefined;
  try {
    for (let i = 0; i < signable.length; i++) {
      currentIndex = i;
      const stepEntry = signable[i]!;
      const legRow = legRows[i]!;
      // The native-value context is what Vex DERIVED for this bridge, never an
      // echo of the quote: `legs.amount` is the post-fee amount Vex asked Relay
      // for, and `legs.originCurrency` is the resolved origin asset. The planner
      // refuses the step if the provider's `tx.value` carries anything beyond
      // it (`@tools/relay/native-value.ts`).
      const txParams = planRelayStepTx(stepEntry.step, legs.originChainId, expectedFrom, {
        role: stepEntry.role,
        originCurrency: legs.originCurrency,
        tradeType: legs.tradeType,
        bridgedAmountRaw: legs.amount,
      });
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
      }, priorLeg);

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
          vexFee: feeNotTaken(),
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
          // An unconfirmed deposit is never charged: finalize ONLY the fee row
          // (bounded), leaving the logical row pending for the W4 sweep.
          if (feeLegIndex !== -1) {
            await abortRemaining(executionId, feeLegIndex, "deposit unconfirmed; fee not attempted", feeLegIndex + 1);
          }
          return pendingResult({
            executionId, requestId, from, to, inSide, outSide, feeUsdByBucket: adapted.feeUsdByBucket,
            broadcasts, poll: null, depositUnconfirmed: true,
            vexFee: relayFeeDisclosure(legs, adapted.currencyIn),
            feeCollection: {
              collection: "not_attempted",
              collectionNote: "No Vex fee was taken: the origin deposit is not confirmed, so the bridge has not been charged.",
            },
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
          vexFee: feeNotTaken(),
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
      priorLeg = priorLegAnchorFrom(outcome.receipt.blockNumber);
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
    // A leg refused because its estimate never succeeded after an approve this
    // same bridge confirmed is NOT an interruption of unknown scope: nothing
    // was signed for it, every remaining row (including the logical fill row,
    // so the in-flight guard is released) is finalized "not attempted", and
    // re-running is safe. Telling an agent otherwise is what turned a
    // transient RPC lag into a permanent refusal (live 2026-07-25).
    if (err instanceof DependentLegGasEstimateError) {
      const refusedRole = signable[currentIndex]?.role ?? "bridge_deposit";
      const body = {
        status: "not_attempted",
        summary: `Relay bridge not attempted: the origin ${refusedRole} could not be gas-estimated.`,
        message: `The origin ${refusedRole} could not be gas-estimated, so it was refused before signing. ${dependentLegEstimateGuidance(err)} The node reported: ${safe}`,
        fromChain: from,
        toChain: to,
        requestId,
        vexFee: feeNotTaken(),
        legs: outputLegs(broadcasts, from, to, "not_reached", null),
        inTxHashes: broadcasts.map((b) => b.txHash),
      };
      return { success: false, output: JSON.stringify(body, null, 2), data: { ...body, _executionId: executionId, retryable: true } };
    }
    // A step refused because Vex could not attribute its `tx.value` is NOT an
    // interruption of unknown scope, and must never be reported as one: the
    // generic body below says "check the record before any further action",
    // which an autonomous agent cannot act on and which reads as "funds may be
    // in flight". Nothing was signed for the refused step, every remaining row
    // is finalized "not attempted", and the agent is told the one thing that
    // can change the outcome — a fresh quote.
    if (err instanceof VexError && err.code === ErrorCodes.NATIVE_VALUE_UNAUTHORIZED) {
      const refusedRole = signable[currentIndex]?.role ?? "bridge_deposit";
      const body = {
        status: "not_attempted",
        summary: `Relay bridge not attempted: the origin ${relayStepLabel(refusedRole)} carried native currency Vex could not account for.`,
        message: `${safe} ${relayNativeValueGuidance(refusedRole)}`,
        fromChain: from,
        toChain: to,
        requestId,
        vexFee: feeNotTaken(),
        legs: outputLegs(broadcasts, from, to, "not_reached", null),
        inTxHashes: broadcasts.map((b) => b.txHash),
      };
      return {
        success: false,
        output: JSON.stringify(body, null, 2),
        data: {
          ...body,
          _executionId: executionId,
          // A retry only helps with a DIFFERENT quote — never a re-send of this
          // one, which is deterministically refused again.
          retryable: false,
          ...(broadcasts.length > 0
            ? { _explorerRefs: broadcasts.map((b) => ({ chain: String(from.id), txRef: b.txHash })) }
            : {}),
        },
      };
    }
    const body = {
      status: "interrupted",
      summary: "Relay bridge was interrupted after it was already recorded.",
      message: `An internal error interrupted the bridge after it was recorded (${safe}). Check the record (execution ${executionId}) before any further action.`,
      fromChain: from,
      toChain: to,
      vexFee: feeNotTaken(),
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

  // Vex fee leg — LAST, and only now: the deposit is confirmed and its
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
  return pendingResult({
    executionId, requestId, from, to, inSide, outSide, feeUsdByBucket: adapted.feeUsdByBucket,
    broadcasts, poll, depositUnconfirmed: false,
    vexFee: relayFeeDisclosure(legs, adapted.currencyIn), feeCollection,
  });
}

/** No fee applies to this bridge — the disclosure already states why. */
const NO_FEE_COLLECTION: RelayFeeCollection = {
  collection: "not_charged",
  collectionNote: "No Vex fee applies to this bridge.",
};

interface RelayFeeCollection {
  readonly collection: string;
  readonly collectionNote: string;
}

/**
 * Sign, stage, broadcast and record the Vex fee transfer on the origin chain.
 * Never throws and never touches the logical fill row: the bridge already
 * happened, so every failure path here is missed revenue reported honestly,
 * not a bridge failure and not a claim that user funds are at risk.
 */
async function runRelayVexFeeLeg(input: {
  readonly executionId: number;
  readonly legRowId: number | undefined;
  readonly feeLegIndex: number;
  readonly tokenAddress: string;
  readonly feeRaw: bigint;
  readonly clients: RelayStepClients;
  readonly broadcasts: OriginBroadcast[];
}): Promise<RelayFeeCollection> {
  const { executionId, legRowId, feeLegIndex, broadcasts } = input;
  if (legRowId === undefined) {
    logger.warn("relay.bridge.fee_leg_row_missing", { executionId, index: feeLegIndex });
    return {
      collection: "not_attempted",
      collectionNote: "The bridge went through. The Vex fee had no recorded row, so no fee was taken.",
    };
  }
  try {
    const transfer = buildEvmBridgeFeeTransfer(input.tokenAddress, input.feeRaw);
    const outcome = await signStageBroadcast(
      input.clients.publicClient,
      input.clients.walletClient,
      {
        to: transfer.to,
        data: transfer.kind === "erc20" ? transfer.data : "0x",
        value: transfer.value,
      },
      {
        onHashStaged: async (handles) => {
          const res = await markActivityBroadcast(legRowId, handles);
          if (!res.applied) {
            throw new Error(`markActivityBroadcast CAS miss for Vex fee leg ${legRowId} — refusing to broadcast untracked`);
          }
        },
        onAccepted: async () => {
          const res = await markBroadcastAccepted(legRowId);
          if (!res.applied) logger.warn("relay.bridge.fee_accept_miss", { id: legRowId });
        },
      },
    );

    if (outcome.kind === "reverted") {
      broadcasts.push({ role: "vex_fee", txHash: outcome.txHash, status: "reverted" });
      await failActivityEvent(legRowId, {
        failureCode: "mined_revert",
        failureReason: `Vex fee transfer ${outcome.txHash} reverted on-chain; the bridge itself was unaffected.`,
      });
      return {
        collection: "reverted",
        collectionNote: "The bridge went through. The Vex fee transfer reverted, so no fee was collected — your bridge is unaffected.",
      };
    }
    if (outcome.kind === "ambiguous") {
      // Left PENDING with its staged hash for the receipt sweep. NEVER retried
      // here: a blind retry could charge the user twice.
      broadcasts.push({ role: "vex_fee", txHash: outcome.txHash, status: "broadcast_unconfirmed" });
      return {
        collection: "unconfirmed",
        collectionNote: "The bridge went through. The Vex fee transfer was broadcast but not confirmed this turn; it is tracked automatically and is never re-sent.",
      };
    }

    let legStatus: OriginBroadcast["status"] = "confirmed";
    try {
      const confirmResult = await confirmActivityEvent(legRowId, {});
      if (!confirmResult.applied && confirmResult.row.status !== "confirmed") {
        legStatus = "confirmed_unrecorded";
        logger.warn("relay.bridge.fee_confirm_cas_miss", { id: legRowId, rowStatus: confirmResult.row.status });
      }
    } catch (err) {
      legStatus = "confirmed_unrecorded";
      logger.warn("relay.bridge.fee_confirm_failed", { id: legRowId, error: summarizeProtocolError(err).message });
    }
    broadcasts.push({ role: "vex_fee", txHash: outcome.txHash, status: legStatus });
    return {
      collection: legStatus,
      collectionNote: "The bridge went through and the Vex fee was transferred to the treasury.",
    };
  } catch (err) {
    logger.warn("relay.bridge.fee_leg_failed", { executionId, error: summarizeProtocolError(err).message });
    await abortRemaining(executionId, feeLegIndex, "vex fee leg refused before signing", feeLegIndex + 1);
    return {
      collection: "not_attempted",
      collectionNote: "The bridge went through. The Vex fee transfer was refused before signing, so no fee was collected — your bridge is unaffected.",
    };
  }
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

/**
 * Abort never-signed downstream rows (best-effort; a throw here must not flip
 * the caller's result). `toIndexExclusive` bounds the abort to
 * `event_index < toIndexExclusive` — used to finalize ONLY the Vex fee row
 * while leaving the logical `bridge_fill_expected` row pending for the W4
 * sweep, since an in-flight bridge must keep its guard.
 */
async function abortRemaining(
  executionId: number,
  fromIndex: number,
  reason: string,
  toIndexExclusive?: number,
): Promise<void> {
  try {
    if (toIndexExclusive === undefined) {
      await abortPlannedEvents(executionId, fromIndex, reason);
    } else {
      await abortPlannedEvents(executionId, fromIndex, reason, toIndexExclusive);
    }
  } catch (err) {
    logger.warn("relay.bridge.abort_planned_failed", { executionId, fromIndex, error: summarizeProtocolError(err).message });
  }
}

/**
 * Reject a caller-supplied refund destination BY NAME, on BOTH Relay entry
 * points, before anything else runs.
 *
 * Rejecting on the QUOTE matters as much as on the execute: the prequote gate
 * binds the money leg, so an attacker who set the same address on both would
 * collide the hashes and pass the gate. A silent drop would hide the attempt
 * entirely. `relay.bridge` and `relay.quote.get` are directly reachable through
 * `execute_tool`, so the alias-level rejection is not sufficient on its own.
 */
function rejectCallerSuppliedDestination(toolId: string, params: Record<string, unknown>): ToolResult | null {
  const forbidden = findCallerSuppliedForbiddenParam(params);
  if (forbidden === null) return null;
  return {
    success: false,
    output: `${toolId} failed: ${forbidden.param} is not an accepted parameter — ${forbidden.reason} Remove it and retry.`,
  };
}

export const RELAY_BRIDGE_HANDLERS: Record<string, ProtocolHandler> = {
  "relay.quote.get": async (p, ctx) =>
    rejectCallerSuppliedDestination("relay.quote.get", p) ?? relayQuoteGet(p, ctx),
  "relay.bridge": async (p, ctx) =>
    rejectCallerSuppliedDestination("relay.bridge", p) ?? relayBridge(p, ctx),
};
