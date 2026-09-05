/**
 * Pendle PT prequote recording (Wave 5) - `pendle.pt.quote` records either a
 * `swap` or a matured `redeem`.
 */

import { randomUUID } from "node:crypto";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";

import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { CreatePrequoteInput, PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import { buildPendleRedeemIdentity } from "../identity/pendle-redeem.js";
import { extractPendleQuote } from "../safety/extract.js";
import { canonSlippageBps, readParamSlippageBps } from "../slippage.js";
import { familyToChainFamily, writePrequoteRow } from "./row.js";
import { PENDLE_PT_QUOTE_GATE_TARGETS } from "./gate-targets.js";

/**
 * Record a Pendle prequote (Wave 5). The single `pendle.pt.quote` tool records
 * EITHER a `swap` prequote (buy / early-exit sell - Convert action `swap`) OR a
 * `redeem` prequote (matured PT - Convert action `redeem-py`), decided from the
 * echoed `action`. A redeem uses the dedicated redeem identity (never the swap or
 * bridge one). Best-effort: a wallet-scope / identity throw is a bounded skip.
 */
export async function recordPendlePrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(
      context.walletResolution,
      context.walletPolicy,
      familyToChainFamily(registered.family),
    );
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "wallet_unresolved";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  const extracted = extractPendleQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }
  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();

  // Redeem path - dedicated identity (provider/wallet/chainId/pt/yt/amount/receiver).
  if (extracted.action === "redeem") {
    let identity;
    try {
      identity = await buildPendleRedeemIdentity(sessionId, params, context);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "pendle_redeem_identity_failed";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
    const input: CreatePrequoteInput = {
      prequoteId: `prequote-${randomUUID()}`,
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: PENDLE_PT_QUOTE_GATE_TARGETS[extracted.action].kind,
      family: registered.family,
      provider: registered.provider,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      tokenIn: identity.ptAddress,
      tokenOut: extracted.tokenOut,
      amount: identity.amount,
      slippageBps: extracted.slippageBps,
      safetyVerdict: extracted.verdict,
      safetyDetail: extracted.safetyDetail,
      routeRef: null,
      expiresAt,
    };
    if (await writePrequoteRow(toolId, input)) {
      logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
    }
    return;
  }

  // Swap path (buy / early-exit sell) - same money/safety leg as the other swaps:
  // recipient defaults to self, approveExact false, slippage from the quote params.
  const matchHash = computePrequoteMatchHash({
    kind: PENDLE_PT_QUOTE_GATE_TARGETS.swap.kind,
    sessionId,
    family: registered.family,
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    recipient: walletAddress,
    approveExact: false,
    slippageBps: canonSlippageBps(readParamSlippageBps(params)),
  });
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash,
    kind: PENDLE_PT_QUOTE_GATE_TARGETS[extracted.action].kind,
    family: registered.family,
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    slippageBps: extracted.slippageBps,
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    routeRef: null,
    expiresAt,
  };
  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
  }
}
