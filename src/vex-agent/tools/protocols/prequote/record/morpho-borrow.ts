/**
 * Morpho Blue MARKET prequote recording (E3c) - `morpho.market.quote` records
 * ONE of the six market-lane kinds, decided from the direction the quote itself
 * reports rather than from the raw params, so a quote that priced one operation
 * can never record another's authorization.
 *
 * That is the whole safety property of this file. The four operations run
 * against the same market and the same wallet, and two of them can carry the
 * same raw amount, so the direction is the only thing separating "put collateral
 * in" from "draw debt out". It is read from the result the handler produced.
 *
 * Best-effort like every recorder: an identity or wallet-scope throw is a
 * bounded skip, never an error the quote's own result carries. A missing
 * prequote is safe, because the execute gate blocks in the absence of one.
 */

import { randomUUID } from "node:crypto";

import logger from "@utils/logger.js";

import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { CreatePrequoteInput, PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import { buildMorphoBorrowIdentityFor } from "../identity/morpho-borrow.js";
import { extractMorphoMarketQuote } from "../safety/extract/morpho-borrow.js";
import { writePrequoteRow } from "./row.js";
import { MORPHO_MARKET_QUOTE_GATE_TARGETS } from "./gate-targets.js";
import { readParamSlippageBps } from "../slippage.js";

export async function recordMorphoBorrowPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const extracted = extractMorphoMarketQuote(resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }

  let identity;
  try {
    identity = buildMorphoBorrowIdentityFor(extracted.direction, sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "morpho_borrow_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  // Descriptive row columns only (matching is via match_hash + kind). This lane
  // moves ONE token per operation, so the leg the wallet does not use carries
  // the market id rather than a second token: writing an unrelated address there
  // would read as a pair that does not exist.
  // Which way the wallet's own token moves. `supply` joins the two pulling
  // borrower operations here: lending an asset into the market SENDS it.
  const walletSends = extracted.direction === "supplyCollateral"
    || extracted.direction === "repay"
    || extracted.direction === "supply";
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash: computePrequoteMatchHash(identity),
    kind: MORPHO_MARKET_QUOTE_GATE_TARGETS[extracted.direction].kind,
    family: registered.family,
    provider: registered.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    tokenIn: walletSends ? extracted.token : extracted.marketId,
    tokenOut: walletSends ? extracted.marketId : extracted.token,
    amount: identity.amount,
    slippageBps: readParamSlippageBps(params),
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    routeRef: null,
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  };
  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", {
      toolId,
      family: registered.family,
      verdict: extracted.verdict,
    });
  }
}
