/**
 * Morpho vault prequote recording (E3b-2) - `morpho.vault.quote` records either
 * a `lend_deposit` or a `lend_withdraw`, decided from the direction the quote
 * itself reports rather than from the raw params, so a quote that priced one
 * direction can never record the other.
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
import {
  buildMorphoLendDepositIdentity,
  buildMorphoLendWithdrawIdentity,
} from "../identity/morpho-lend.js";
import { extractMorphoLendQuote } from "../safety/extract/morpho-lend.js";
import { writePrequoteRow } from "./row.js";
import { MORPHO_LEND_QUOTE_GATE_TARGETS } from "./gate-targets.js";

export async function recordMorphoLendPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const extracted = extractMorphoLendQuote(params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }

  let identity;
  try {
    identity = extracted.direction === "deposit"
      ? buildMorphoLendDepositIdentity(sessionId, params, context)
      : buildMorphoLendWithdrawIdentity(sessionId, params, context);
  } catch (err) {
    const reason = err instanceof VexError ? err.code : "morpho_lend_identity_failed";
    logger.warn("protocol.prequote.skipped", { toolId, reason });
    return;
  }

  // Descriptive row columns only (matching is via match_hash + kind). A deposit
  // pays the vault's asset to acquire the vault's shares; a withdrawal is the
  // mirror. The vault address stands for the share leg because a Morpho vault
  // IS its share token.
  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash: computePrequoteMatchHash(identity),
    kind: MORPHO_LEND_QUOTE_GATE_TARGETS[extracted.direction].kind,
    family: registered.family,
    provider: registered.provider,
    chainId: identity.chainId,
    walletAddress: identity.walletAddress,
    tokenIn: extracted.direction === "deposit" ? extracted.asset : identity.vault,
    tokenOut: extracted.direction === "deposit" ? identity.vault : extracted.asset,
    amount: identity.amount,
    slippageBps: extracted.slippageBps,
    safetyVerdict: extracted.verdict,
    safetyDetail: extracted.safetyDetail,
    routeRef: null,
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  };
  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", { toolId, family: registered.family, verdict: extracted.verdict });
  }
}
