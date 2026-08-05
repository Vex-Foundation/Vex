/**
 * Swap prequote recording — the token-safety-verdict path shared by kyberswap,
 * uniswap, jupiter and the Trench Express curve quote.
 */

import { randomUUID } from "node:crypto";

import { resolveSelectedAddress } from "@vex-agent/tools/internal/wallet/resolve.js";
import logger from "@utils/logger.js";
import {
  canonicalizeJupiterFeeTail,
  resolveJupiterFeeSwapKnobs,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";

import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "../../types.js";
import type { CreatePrequoteInput, PrequoteFamily } from "@vex-agent/db/repos/swap-prequotes.js";

import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import { extractQuote } from "../safety/extract.js";
import { canonSlippageBps, readParamSlippageBps } from "../slippage.js";
import { familyToChainFamily, writePrequoteRow } from "./row.js";

export async function recordSwapPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  // Resolve the SELECTED address (never decrypts a key). A wallet-scope throw
  // (no wallet selected for this family) is a valid skip — fail-closed, never
  // fabricate.
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

  const extracted = extractQuote(toolId, params, resultData);
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }

  // W5 (design §6 R4): Jupiter fee-bearing tail, read from the QUOTE PARAMS
  // (same convention as `slippageBps` below) so it stays in lockstep with the
  // gate, which reads the SAME knobs from the execute params. Best-effort — a
  // malformed knob (e.g. an out-of-range tipLamports) is a bounded skip, never
  // a thrown recorder failure; every non-Jupiter provider leaves this
  // `undefined` (the hash tail then canonicalizes to "").
  let jupiterTail: ReturnType<typeof canonicalizeJupiterFeeTail> | undefined;
  if (registered.provider === "jupiter") {
    try {
      jupiterTail = canonicalizeJupiterFeeTail(resolveJupiterFeeSwapKnobs(params), extracted.tokenIn);
    } catch (err) {
      const reason = err instanceof VexError ? err.code : "jupiter_knobs_invalid";
      logger.warn("protocol.prequote.skipped", { toolId, reason });
      return;
    }
  }

  // Stage 9: bind the execute-only money/safety leg. The QUOTE carries none of
  // recipient/approveExact, so default them to what the executor uses when they
  // are omitted (output-to-self == the resolved selected wallet; approveExact
  // false). `slippageBps` is read from the QUOTE PARAMS (not the echoed quote
  // response) so it stays in lockstep with the gate, which reads it from the
  // execute params. Solana has no recipient/approveExact concept — self/false
  // are inert constants there.
  const matchHash = computePrequoteMatchHash({
    kind: "swap",
    sessionId,
    family: registered.family,
    // Venue binding (LOCKED #4) — the quoting provider is part of the identity.
    provider: registered.provider,
    chainId: extracted.chainId,
    walletAddress,
    tokenIn: extracted.tokenIn,
    tokenOut: extracted.tokenOut,
    amount: extracted.amount,
    recipient: walletAddress,
    approveExact: false,
    slippageBps: canonSlippageBps(readParamSlippageBps(params)),
    ...jupiterTail,
  });

  const input: CreatePrequoteInput = {
    prequoteId: `prequote-${randomUUID()}`,
    sessionId,
    matchHash,
    kind: "swap",
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
    // Structural-only route facts. No swap venue writes any today: the one
    // producer was KyberSwap's quote-time price floor, removed by owner
    // decision (2026-07-25) because comparing it against the build reduced to
    // "the price must not have moved", which stranded autonomous retries. The
    // column stays for a future structural fact; nothing derives from it now.
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
