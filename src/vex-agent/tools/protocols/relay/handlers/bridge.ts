/**
 * Relay bridge handlers — quote.get (read) + bridge (mutating).
 *
 * Relay is a KEYLESS cross-chain bridge and the ONLY route to/from Robinhood
 * Chain (Khalani does not cover 4663). The quote returns signable steps; the
 * bridge signs them in order (see `@tools/relay/execute`) and polls to a terminal
 * state. Capture mirrors khalani.bridge's audit shape (type "bridge").
 */

import { formatUnits, getAddress, isAddress } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getRelayClient, getCachedRelayChains } from "@tools/relay/client.js";
import { resolveRelayChainId, toRelayCurrency, RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import { executeRelayBridge } from "@tools/relay/execute.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import type { RelayChain, RelayQuoteDetailsSide, RelayQuoteRequest, RelayQuoteResponse } from "@tools/relay/types.js";

import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ToolResult } from "../../../types.js";
import type { ProtocolHandler, ProtocolExecutionContext } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";

interface RelayLegs {
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: "EXACT_INPUT" | "EXACT_OUTPUT";
}

/** Distinct tx chainIds per step (for the gate's shape validation + display). */
function stepSummaries(quote: RelayQuoteResponse): Array<{ id: string; kind: string; chainIds: number[] }> {
  return quote.steps.map((step) => {
    const chainIds = new Set<number>();
    for (const item of step.items) {
      if (item.data) chainIds.add(item.data.chainId);
    }
    return { id: step.id, kind: step.kind, chainIds: [...chainIds] };
  });
}

function firstRequestId(quote: RelayQuoteResponse): string | null {
  for (const step of quote.steps) {
    if (step.requestId) return step.requestId;
  }
  return null;
}

interface CaptureLeg {
  /** Display token: SYMBOL when known, else the currency address. */
  token: string;
  /** Human-readable amount, or null when Relay gave nothing convertible. */
  amount: string | null;
}

/**
 * One trade-capture leg from the quote's `details` (currencyIn/currencyOut).
 * Symbol precedence: quote currency metadata → the chain's native-currency
 * symbol (zero-address native) → the raw currency address (legacy fallback).
 * Amount precedence: Relay's `amountFormatted` → formatUnits(amount, decimals)
 * → null. No network calls — everything comes from the quote + cached chains.
 */
function captureLeg(
  side: RelayQuoteDetailsSide | undefined,
  currency: string,
  chainId: number,
  chains: readonly RelayChain[],
): CaptureLeg {
  const nativeSymbol = currency === RELAY_NATIVE_CURRENCY
    ? chains.find((c) => c.id === chainId)?.currency?.symbol
    : undefined;
  const token = side?.currency?.symbol ?? nativeSymbol ?? currency;

  const decimals = side?.currency?.decimals;
  const raw = side?.amount;
  const amount = side?.amountFormatted
    ?? (raw !== undefined && decimals !== undefined && /^\d+$/.test(raw)
      ? formatUnits(BigInt(raw), decimals)
      : null);
  return { token, amount };
}

async function resolveLegs(
  params: Record<string, unknown>,
  chains: readonly RelayChain[],
): Promise<RelayLegs> {
  const fromChain = str(params, "fromChain"), toChain = str(params, "toChain");
  const fromToken = str(params, "fromToken"), toToken = str(params, "toToken");
  const amount = str(params, "amount");
  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    throw new VexError(ErrorCodes.AGENT_VALIDATION_ERROR, "Missing required: fromChain, fromToken, toChain, toToken, amount");
  }
  const tradeTypeRaw = str(params, "tradeType");
  return {
    originChainId: resolveRelayChainId(fromChain, chains),
    destinationChainId: resolveRelayChainId(toChain, chains),
    originCurrency: toRelayCurrency(fromToken),
    destinationCurrency: toRelayCurrency(toToken),
    amount,
    tradeType: tradeTypeRaw === "EXACT_OUTPUT" ? "EXACT_OUTPUT" : "EXACT_INPUT",
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

  const quote = await getRelayClient().getQuote(buildRequest(legs, user, params));
  if (quote.steps.length === 0) return fail("Relay returned no steps for this route.");

  // result.data carries the structural fields the prequote recorder re-validates
  // (provider + origin/destination + step kinds/chainIds).
  return ok({
    provider: "relay",
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    fromToken: legs.originCurrency,
    toToken: legs.destinationCurrency,
    amount: legs.amount,
    tradeType: legs.tradeType,
    steps: stepSummaries(quote),
    fees: quote.fees ?? null,
    details: quote.details ?? null,
    requestId: firstRequestId(quote),
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
    return fail(err instanceof Error ? err.message : String(err));
  }

  // Preview address (read) — the real signer resolves AFTER the dryRun gate.
  let previewUser: string;
  try {
    previewUser = resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const quote = await getRelayClient().getQuote(buildRequest(legs, previewUser, params));
  if (quote.steps.length === 0) return fail("Relay returned no steps for this route.");

  if (params.dryRun === true) {
    return ok({
      dryRun: true,
      originChainId: legs.originChainId,
      destinationChainId: legs.destinationChainId,
      steps: stepSummaries(quote),
      fees: quote.fees ?? null,
    });
  }

  let signer: ChainWallet;
  try {
    signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
  } catch (err) {
    return walletScopeErrorToResult(err);
  }
  if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");

  const result = await executeRelayBridge({
    quote,
    signer,
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
  });

  // "failure"/"refund" are TERMINAL Relay intent statuses (`pollToTerminal`
  // returns them without throwing): every step may have mined successfully and
  // the bridge still did not deliver. The tool result must say so — the
  // capture pipeline projects proj_activity only from successful results, and
  // the model plans off `success`. No capture, no pin: nothing arrived.
  if (result.finalStatus === "failure" || result.finalStatus === "refund") {
    logger.warn("relay.bridge.terminal_failure", {
      originChainId: legs.originChainId,
      destinationChainId: legs.destinationChainId,
      finalStatus: result.finalStatus,
    });
    const message = result.finalStatus === "refund"
      ? "Relay reported this bridge as refunded: the destination amount did NOT arrive; funds were returned toward the origin/refund address. Verify balances before any follow-up."
      : "Relay reported this bridge as failed: the destination amount did NOT arrive. Verify balances via the request id before retrying.";
    return {
      success: false,
      output: JSON.stringify({
        success: false,
        requestId: result.requestId,
        status: result.finalStatus,
        txHashes: result.txHashes,
        fromChain: legs.originChainId,
        toChain: legs.destinationChainId,
        message,
      }, null, 2),
      data: {
        requestId: result.requestId,
        status: result.finalStatus,
        txHashes: result.txHashes,
      },
    };
  }

  const captureStatus = result.finalStatus === "success" ? "executed" : "pending";

  // Display legs (symbols + human-readable amounts) for the capture; the raw
  // currency addresses stay in inputTokenAddress/outputTokenAddress.
  const inLeg = captureLeg(quote.details?.currencyIn, legs.originCurrency, legs.originChainId, chains);
  const outLeg = captureLeg(quote.details?.currencyOut, legs.destinationCurrency, legs.destinationChainId, chains);

  // Auto-pin (fail-soft): an ERC-20 bridged ONTO a local chain joins the
  // tracked_tokens set (seed ∪ pins) so balance scans and the portfolio see
  // it. Native needs no pin. A DB bookmark — never fails the bridge result.
  // Pending pins too: the bridge may still complete and the scan must not
  // miss the token when it lands.
  if (getLocalChain(legs.destinationChainId) && legs.destinationCurrency !== RELAY_NATIVE_CURRENCY && isAddress(legs.destinationCurrency)) {
    try {
      await pinTrackedToken({
        walletAddress: signer.address,
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

  logger.info("relay.bridge.completed", {
    originChainId: legs.originChainId,
    destinationChainId: legs.destinationChainId,
    finalStatus: result.finalStatus,
  });

  return {
    success: true,
    output: JSON.stringify({
      success: true,
      requestId: result.requestId,
      status: result.finalStatus,
      txHashes: result.txHashes,
      fromChain: legs.originChainId,
      toChain: legs.destinationChainId,
      // "pending" = the status poll window closed before a terminal status:
      // broadcast happened and the bridge may still complete, but it is NOT
      // confirmed — spell that out so it is never read as completion.
      ...(result.finalStatus !== "success"
        ? { message: "Relay has not confirmed this bridge yet (status is still pending after the poll window). It may still complete — check the request id before any retry; do NOT re-bridge." }
        : {}),
    }, null, 2),
    data: {
      requestId: result.requestId,
      status: result.finalStatus,
      txHashes: result.txHashes,
      // Per-hop explorer refs (metadata-only, model-invisible): a bridge spans
      // the origin AND destination chains, so each broadcast hash is paired
      // with its own chain. `deriveExplorerRefs` validates + merges these with
      // the coherent origin-chain capture ref (deduped). The `_tradeCapture`
      // audit shape below is deliberately UNCHANGED (projections depend on it).
      _explorerRefs: result.transactions.map((t) => ({
        chain: String(t.chainId),
        txRef: t.hash,
      })),
      _tradeCapture: {
        type: "bridge",
        chain: String(legs.originChainId),
        status: captureStatus,
        inputToken: inLeg.token,
        inputTokenAddress: legs.originCurrency,
        inputAmount: inLeg.amount ?? legs.amount,
        outputToken: outLeg.token,
        outputTokenAddress: legs.destinationCurrency,
        ...(outLeg.amount !== null ? { outputAmount: outLeg.amount } : {}),
        signature: result.txHashes[0] ?? "",
        walletAddress: signer.address,
        meta: {
          provider: "relay",
          sourceChain: String(legs.originChainId),
          destChain: String(legs.destinationChainId),
          requestId: result.requestId,
          finalStatus: result.finalStatus,
        },
      },
    },
  };
}

export const RELAY_BRIDGE_HANDLERS: Record<string, ProtocolHandler> = {
  "relay.quote.get": (p, ctx) => relayQuoteGet(p, ctx),
  "relay.bridge": (p, ctx) => relayBridge(p, ctx),
};
