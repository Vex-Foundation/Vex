/**
 * Solana quote extraction (solana.swap.quote) — Jupiter token metadata, the
 * per-mint audit block, and the W5 fee-bearing disclosure.
 */

import { z } from "zod";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { jupiterFeePreviewSchema } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";

import { aggregateVerdict } from "./verdict.js";
import type { LegVerdictDetail } from "./verdict.js";
import type { ExtractedQuote } from "./extracted-quote.js";

// Solana token metadata + safety block — structural re-validation of the
// Jupiter quote summary fields we need.
const SolanaTokenMetadataSchema = z.object({
  address: z.string(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
});
const SolanaTokenSafetySchema = z.object({
  isSus: z.boolean().nullish(),
  mintAuthorityDisabled: z.boolean().nullish(),
  freezeAuthorityDisabled: z.boolean().nullish(),
  topHoldersPercentage: z.number().nullish(),
});
const SolanaQuoteSchema = z.object({
  inputToken: SolanaTokenMetadataSchema,
  outputToken: SolanaTokenMetadataSchema,
  safety: z
    .object({
      inputToken: SolanaTokenSafetySchema.optional(),
      outputToken: SolanaTokenSafetySchema.optional(),
    })
    .optional(),
  slippageBps: z.number().nullish(),
  // W5 (design §6 R4): `solana.swap.quote`'s fee-bearing disclosure, when
  // present. Optional so any pre-existing quote-result fixture without it
  // still validates — the new `solana.swap.quote` handler always includes it
  // in real traffic.
  feePreview: jupiterFeePreviewSchema.optional(),
});
type SolanaTokenSafety = z.infer<typeof SolanaTokenSafetySchema>;

function isNativeSolanaMint(mint: string): boolean {
  // Jupiter audits wSOL and returns isSus:false; treat the native sentinel as
  // a no-audit-needed leg regardless of whether a safety entry is present.
  return mint === SOL_MINT;
}

/**
 * Per-leg Solana verdict + bounded detail. A present entry with `isSus === true`
 * → fail; `isSus === false` → pass. A native (SOL/wSOL) leg never worsens the
 * verdict. An ABSENT entry for a non-native mint is fail-closed → unknown (no
 * audit data). `isSus` null/undefined on a present non-native entry is also
 * treated as "no verdict signal" → unknown (fail-closed).
 */
function solanaLegVerdict(
  mint: string,
  safety: SolanaTokenSafety | undefined,
): LegVerdictDetail {
  if (isNativeSolanaMint(mint)) {
    return { verdict: "pass", detail: { native: true } };
  }
  if (!safety || safety.isSus == null) {
    return { verdict: "unknown", detail: { auditPresent: false } };
  }
  const detail: Record<string, unknown> = { isSus: safety.isSus };
  if (safety.mintAuthorityDisabled != null) detail.mintAuthorityDisabled = safety.mintAuthorityDisabled;
  if (safety.freezeAuthorityDisabled != null) detail.freezeAuthorityDisabled = safety.freezeAuthorityDisabled;
  if (safety.topHoldersPercentage != null) detail.topHoldersPercentage = safety.topHoldersPercentage;
  return { verdict: safety.isSus ? "fail" : "pass", detail };
}

export function extractSolana(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = SolanaQuoteSchema.safeParse(data);
  if (!parsed.success) return null;
  // W5a: `amountIn` is a HUMAN decimal STRING (the old `amount` number param
  // is gone, and with it the float multiply it fed). A missing or wrong-typed
  // value records NO prequote row, so the later execute blocks for want of one
  // — fail-closed, matching the gate's "" on the other side.
  const amountIn = params.amountIn;
  if (typeof amountIn !== "string" || amountIn.trim() === "") return null;
  const amount = amountIn;

  // Slippage: prefer the quote's echoed value, else the request param.
  const slippage =
    typeof parsed.data.slippageBps === "number"
      ? parsed.data.slippageBps
      : typeof params.slippageBps === "number"
        ? params.slippageBps
        : null;

  const inMint = parsed.data.inputToken.address;
  const outMint = parsed.data.outputToken.address;
  const inLeg = solanaLegVerdict(inMint, parsed.data.safety?.inputToken);
  const outLeg = solanaLegVerdict(outMint, parsed.data.safety?.outputToken);
  return {
    tokenIn: inMint,
    tokenOut: outMint,
    chainId: null,
    amount,
    slippageBps: slippage,
    verdict: aggregateVerdict([inLeg.verdict, outLeg.verdict]),
    safetyDetail: {
      inputToken: inLeg.detail,
      outputToken: outLeg.detail,
      // W5 (design §6 R4): the bounded fee-bearing disclosure rides the same
      // JSONB channel as every other Solana quote detail — the gate later
      // extracts it back out for the approval preview.
      ...(parsed.data.feePreview !== undefined ? { feePreview: parsed.data.feePreview } : {}),
    },
  };
}
