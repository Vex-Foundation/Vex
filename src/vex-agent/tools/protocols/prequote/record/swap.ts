/**
 * Swap prequote recording - the token-safety-verdict path shared by kyberswap,
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
import type { ToolResult } from "../../../types.js";
import type {
  CreatePrequoteInput,
  PrequoteEligibilityKind,
  PrequoteFamily,
} from "@vex-agent/db/repos/swap-prequotes.js";

import { parseSpendabilityPreview } from "../../quote-authority/spendability.js";
import { PREQUOTE_MAX_AGE_MS } from "../registry.js";
import { computePrequoteMatchHash } from "../identity/hash.js";
import { extractQuote } from "../safety/extract.js";
import { canonSlippageBps, readParamSlippageBps } from "../slippage.js";
import { familyToChainFamily, writePrequoteRow } from "./row.js";

const ELIGIBILITY_KINDS: ReadonlySet<string> = new Set<PrequoteEligibilityKind>([
  "executable",
  "unpriceable_output",
  "excessive_impact",
  "oversize_snapshot",
  "provider_usd_invalid",
  // Spendability (WP2, contract C2). A quote the wallet cannot pay for is
  // recorded exactly like a quote whose route was unusable: as a superseding
  // row that authorizes nothing.
  "insufficient_balance",
  "balance_unavailable",
  "gas_reserve_insufficient",
]);

/**
 * Narrow the handoff's structural `string` to the stored union. An unrecognised
 * label is recorded as `provider_usd_invalid` rather than `executable`: an
 * eligibility this build cannot name must never be the one that authorizes a
 * swap.
 */
function normalizeEligibilityKind(kind: string | undefined): PrequoteEligibilityKind {
  if (kind === undefined) return "executable";
  return ELIGIBILITY_KINDS.has(kind) ? (kind as PrequoteEligibilityKind) : "provider_usd_invalid";
}

/**
 * Fold the quote-time spendability facts into the row's bounded safety block.
 *
 * VALIDATED BEFORE IT IS STORED, not on the way out only: the payload becomes
 * part of what a human later reads on an approval card, so a malformed handoff
 * must fail here - where the row is still being built - rather than survive to
 * the card and be dropped there without anyone knowing a venue produced
 * garbage. An unparseable payload leaves the block exactly as the quote's own
 * safety extraction built it, and the card simply carries no spendability line.
 *
 * `spendability` is a RESERVED key of the safety block. A venue whose own
 * safety detail used that name would have its value replaced here; none does,
 * and the recorder is the one writer of this column.
 */
function withSpendability(
  toolId: string,
  safetyDetail: Record<string, unknown>,
  spendability: unknown,
): Record<string, unknown> {
  if (spendability === undefined) return safetyDetail;
  const parsed = parseSpendabilityPreview(spendability);
  if (parsed === undefined) {
    logger.warn("protocol.prequote.spendability_unreadable", { toolId });
    return safetyDetail;
  }
  return { ...safetyDetail, spendability: parsed };
}

export async function recordSwapPrequote(
  toolId: string,
  sessionId: string,
  registered: { readonly family: PrequoteFamily; readonly provider: string },
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
  quoteAuthority?: ToolResult["quoteAuthority"],
): Promise<void> {
  // Resolve the SELECTED address (never decrypts a key). A wallet-scope throw
  // (no wallet selected for this family) is a valid skip - fail-closed, never
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

  // FAILURE PATH. A quote that refused on provider shape still writes a row:
  // without it, an older priced quote for the SAME identity stays the newest
  // row and stays claimable, so the refusal would leave the stale authority
  // standing. The marker is `eligibility_kind <> 'executable'`, which the claim
  // predicate rejects, and its mere existence supersedes every earlier row for
  // the identity.
  //
  // THE QUOTE PAYLOAD WINS WHENEVER IT EXISTS. The ineligible identity is the
  // FALLBACK for the failure path, where no successful payload exists to extract
  // from; it is not a replacement for one. Preferring it unconditionally meant an
  // ineligible-but-successful quote (unpriceable output, excessive impact,
  // oversize snapshot) recorded the handoff's safety fields instead of the safety
  // block the quote itself returned - discarding a known verdict.
  const ineligible = quoteAuthority?.ineligibleIdentity;
  const extracted = extractQuote(toolId, params, resultData)
    ?? (ineligible === undefined
      ? null
      : {
          tokenIn: ineligible.tokenIn,
          tokenOut: ineligible.tokenOut,
          chainId: ineligible.chainId,
          amount: ineligible.amount,
          slippageBps: ineligible.slippageBps,
          verdict: ineligible.safetyVerdict,
          safetyDetail: ineligible.safetyDetail,
        });
  if (!extracted) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "shape_invalid" });
    return;
  }

  // W5 (design §6 R4): Jupiter fee-bearing tail, read from the QUOTE PARAMS
  // (same convention as `slippageBps` below) so it stays in lockstep with the
  // gate, which reads the SAME knobs from the execute params. Best-effort - a
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
  // execute params. Solana has no recipient/approveExact concept - self/false
  // are inert constants there.
  const matchHash = computePrequoteMatchHash({
    kind: "swap",
    sessionId,
    family: registered.family,
    // Venue binding (LOCKED #4) - the quoting provider is part of the identity.
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
    safetyDetail: withSpendability(toolId, extracted.safetyDetail, quoteAuthority?.spendability),
    // The execution snapshot (`quote-authority/snapshot.ts`) when the venue
    // produced one: the route summary as a raw JSON string plus its digest, the
    // approved output and floor, and the tolerance the build must be POSTed
    // with. Venues that record no snapshot leave this null and keep their
    // pre-existing safety-only gating.
    routeRef: quoteAuthority?.routeSnapshot ?? null,
    // Only `executable` may be claimed by an execute. Defaults to executable so
    // every venue that does not participate in the claim lane is unchanged.
    eligibilityKind: normalizeEligibilityKind(quoteAuthority?.eligibilityKind),
    expiresAt: new Date(Date.now() + PREQUOTE_MAX_AGE_MS).toISOString(),
  };

  if (await writePrequoteRow(toolId, input)) {
    logger.info("protocol.prequote.recorded", {
      toolId,
      family: registered.family,
      verdict: extracted.verdict,
      eligibility: normalizeEligibilityKind(quoteAuthority?.eligibilityKind),
    });
  }
}
