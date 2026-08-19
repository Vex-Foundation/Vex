/**
 * Morpho vault quote extraction (`morpho.vault.quote`) - the deposit / withdraw
 * preview that authorizes a Morpho execute (E3b-2).
 *
 * WHAT A VERDICT CAN HONESTLY MEAN HERE. A Morpho vault is not a token pair, so
 * the honeypot and fee-on-transfer machinery the swap lane runs has nothing to
 * check: there is no counterparty token to scan. What the quote DOES know, and
 * what the agent needs disclosed at the approval card, is governance: whether a
 * gate contract can refuse this very operation on chain, and whether Morpho's
 * own vault read answered at all.
 *
 * So the verdict is `pass` or `unknown` and never `fail`. Rule 90's disclose-do-
 * not-block ruling applies: a gated vault is a hazard the user must be TOLD
 * about, not an operation Vex silently refuses on their behalf. `unknown` is
 * reserved for the case that actually is unknown - the governance read did not
 * answer, so gating cannot be ruled out - which is not the same as "no gates"
 * and must not be reported as if it were.
 *
 * THE SIMULATION VERDICT IS DISCLOSED BUT DELIBERATELY NOT DEMOTED. A deposit
 * simulates as a revert until the exact-amount approval exists on chain, which
 * is the normal state of every first deposit. Treating that as a safety signal
 * would mark every honest first deposit suspicious.
 */

import { z } from "zod";

import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

import { aggregateVerdict } from "./verdict.js";
import type { LegVerdict } from "./verdict.js";

const MorphoQuoteResultSchema = z.object({
  quote: z.object({
    chainId: z.number(),
    direction: z.enum(["deposit", "withdraw"]),
    vault: z.object({ address: z.string(), asset: z.string() }),
    sharePrice: z.object({ slippageBps: z.number() }),
    preflight: z.object({ verdict: z.string() }),
  }),
  governance: z.object({ status: z.string() }).passthrough(),
});

export interface ExtractedMorphoLendQuote {
  readonly direction: "deposit" | "withdraw";
  readonly chainId: number;
  readonly vault: string;
  /** The vault's own asset. Descriptive only; the identity anchors on the vault. */
  readonly asset: string;
  readonly amount: string;
  readonly slippageBps: number;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Morpho vault quote. Returns null when the result payload
 * does not structurally validate or the params carry no raw amount for the
 * quoted direction, in which case recording is skipped and the gate blocks the
 * execute instead. Exported for focused unit tests.
 */
export function extractMorphoLendQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedMorphoLendQuote | null {
  const parsed = MorphoQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const quote = parsed.data.quote;

  // The amount is read from the PARAMS under the direction's own key, never from
  // the result: the execute gate reads the same key from the same side, so a
  // result-derived amount could drift from what was actually asked for.
  const amountKey = quote.direction === "deposit" ? "depositAmountRaw" : "withdrawAmountRaw";
  const amount = params[amountKey];
  if (typeof amount !== "string" || amount.trim() === "") return null;

  const legs: LegVerdict[] = [];
  const safetyDetail: Record<string, unknown> = {};

  const governanceStatus = parsed.data.governance.status;
  if (governanceStatus === "read") {
    legs.push("pass");
    safetyDetail.governance = { checked: true };
  } else {
    // Gating is UNKNOWN rather than absent. The two are different answers and
    // the reassuring one is the wrong one.
    legs.push("unknown");
    safetyDetail.governance = { checked: false };
  }

  safetyDetail.preflight = { verdict: quote.preflight.verdict };
  safetyDetail.slippageBps = quote.sharePrice.slippageBps;

  return {
    direction: quote.direction,
    chainId: quote.chainId,
    vault: quote.vault.address,
    asset: quote.vault.asset,
    amount: amount.trim(),
    slippageBps: quote.sharePrice.slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}
