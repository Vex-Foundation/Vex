/**
 * Pendle LP prequote recording (P5) — `pendle.lp.quote` records either an
 * `lp_add` or an `lp_remove`.
 */

import { randomUUID } from "node:crypto";

import logger from "@utils/logger.js";

import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { CreatePrequoteInput, PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import { buildPendleLpAddIdentity, buildPendleLpRemoveIdentity } from "../identity/pendle-lp.js";
import { extractPendleLpQuote } from "../safety/extract.js";
import { writePrequoteRow } from "./row.js";

/**
 * Record a Pendle LP prequote (P5). `pendle.lp.quote` records EITHER an `lp_add`
 * prequote (direction "add" — token → LP) OR an `lp_remove` prequote (direction
 * "remove" — LP → token), decided from the echoed `direction`. Each uses its
 * dedicated identity (never the swap / mint / redeem one). Best-effort: a
 * wallet-scope / identity throw is a bounded skip.
 */
export async function recordPendleLpPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const extracted = extractPendleLpQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }
  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();

  if (extracted.direction === "add") {
    let identity;
    try {
      identity = await buildPendleLpAddIdentity(sessionId, params, context);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "pendle_lp_add_identity_failed";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
    const input: CreatePrequoteInput = {
      prequoteId: `prequote-${randomUUID()}`,
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: "lp_add",
      family: registered.family,
      provider: registered.provider,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      // Descriptive row columns (matching is via match_hash + kind): an add pays a
      // token to acquire the market's LP token.
      tokenIn: identity.tokenIn,
      tokenOut: identity.market,
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

  // Remove (direction "remove") — dedicated lp_remove identity.
  let identity;
  try {
    identity = await buildPendleLpRemoveIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "pendle_lp_remove_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash: computePrequoteMatchHash(identity),
    kind: "lp_remove",
    family: registered.family,
    provider: registered.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    // Descriptive: a remove burns the market's LP token into the output token.
    tokenIn: identity.market,
    tokenOut: identity.tokenOut,
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
}
