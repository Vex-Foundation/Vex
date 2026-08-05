/**
 * Pendle PY prequote recording (P4) — `pendle.py.quote` records either a `mint`
 * or a pre-expiry `redeem_py`.
 */

import { randomUUID } from "node:crypto";

import logger from "@utils/logger.js";

import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { CreatePrequoteInput, PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import { buildPendleMintIdentity, buildPendleRedeemPyIdentity } from "../identity/pendle-py.js";
import { extractPendlePyQuote } from "../safety/extract.js";
import { writePrequoteRow } from "./row.js";

/**
 * Record a Pendle PY prequote (P4). `pendle.py.quote` records EITHER a `mint`
 * prequote (direction "mint" — token → PT+YT) OR a `redeem_py` prequote
 * (direction "redeem" — pre-expiry PT+YT → token), decided from the echoed
 * `direction`. Each uses its dedicated identity (never the swap / redeem one).
 * Best-effort: a wallet-scope / identity throw is a bounded skip.
 */
export async function recordPendlePyPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const extracted = extractPendlePyQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }
  const expiresAt = new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString();

  if (extracted.direction === "mint") {
    let identity;
    try {
      identity = await buildPendleMintIdentity(sessionId, params, context);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "pendle_mint_identity_failed";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
    const input: CreatePrequoteInput = {
      prequoteId: `prequote-${randomUUID()}`,
      sessionId,
      matchHash: computePrequoteMatchHash(identity),
      kind: "mint",
      family: registered.family,
      provider: registered.provider,
      chainId: identity.chainId,
      walletAddress: identity.walletAddress,
      // Descriptive row columns (matching is via match_hash + kind): mint pays a
      // token to acquire the PT.
      tokenIn: identity.tokenIn,
      tokenOut: identity.ptAddress,
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

  // Pre-expiry redeem (direction "redeem") — dedicated redeem_py identity.
  let identity;
  try {
    identity = await buildPendleRedeemPyIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "pendle_redeem_py_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash: computePrequoteMatchHash(identity),
    kind: "redeem_py",
    family: registered.family,
    provider: registered.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    // Descriptive: py-redeem burns the PT (+YT) into the output token.
    tokenIn: identity.ptAddress,
    tokenOut: identity.outputToken,
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
