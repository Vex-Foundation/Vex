/**
 * The durable-ledger side effects the Relay bridge handler performs OUTSIDE the
 * staged broadcast itself: projecting a quote side into a leg input, attaching
 * the provider order id, aborting never-signed rows, and the fail-soft token pin.
 *
 * Every function here is best-effort by contract — a throw must never flip the
 * caller's result.
 *
 * Extracted verbatim from `../bridge.ts` as part of a façade-preserving
 * structural split (SPEC wave 0R.2). `../bridge.ts` remains the public entry
 * point.
 */

import { getAddress, isAddress } from "viem";

import { getLocalChain } from "@tools/evm-chains/registry.js";
import { RELAY_NATIVE_CURRENCY } from "@tools/relay/chains.js";
import type { RelayQuoteSide } from "@tools/relay/quote.js";
import { pinTrackedToken } from "@vex-agent/db/repos/tracked-tokens.js";
import {
  abortPlannedEvents,
  attachProviderOrderId,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import type { RelayLegs } from "./legs.js";

/** Repo leg input from an adapted quote side (quoted amounts — never executed truth). */
export function relayLegInput(side: RelayQuoteSide, currencyAddress: string, rawFallback?: string): AgentActivityLegInput {
  return {
    tokenAddress: currencyAddress,
    tokenSymbol: side.symbol ?? undefined,
    tokenDecimals: side.decimals ?? undefined,
    amountHuman: side.amountFormatted ?? undefined,
    amountRaw: side.amountRaw ?? rawFallback,
  };
}

/** Fail-soft auto-pin: an ERC-20 bridged ONTO a local chain joins tracked_tokens so balance scans see it when it lands. */
export async function maybeAutoPin(walletAddress: string, legs: RelayLegs): Promise<void> {
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

/** Attach the Relay requestId to the logical row (best-effort; also persisted in route_provenance for W4 recovery). */
export async function attachRequestIdBestEffort(executionId: number, requestId: string): Promise<void> {
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
export async function abortRemaining(
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
