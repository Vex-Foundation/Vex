/**
 * Extraction for the Virtuals bonding-curve quote.
 *
 * The other EVM venues extract from an aggregator's `safety` block - a honeypot
 * and fee-on-transfer audit of two arbitrary tokens. A curve trade has neither:
 * the pair is fixed (VIRTUAL against one agent token), there is no aggregator to
 * ask, and the risk a person actually needs to see is not "is this token a
 * honeypot" but "how much of this trade does the curve itself take". So this
 * extractor records THAT, and records the verdict as `unknown` rather than
 * borrowing a `pass` it has not earned.
 *
 * `unknown` is a real state the gate already handles: it logs the allow and the
 * approval preview shows it. Claiming `pass` for an unaudited agent token would
 * be the one thing worse than saying nothing.
 */

import { z } from "zod";

import type { ExtractedQuote } from "./extracted-quote.js";

/**
 * The fields this extractor reads off the quote's own answer. A shape it cannot
 * validate yields `null`, and the recorder then writes NO ROW - fail closed,
 * never a row with invented identity.
 */
const VirtualsQuoteSchema = z.object({
  chainId: z.number().int().positive(),
  side: z.union([z.literal("buy"), z.literal("sell")]),
  agent: z.object({ token: z.string().min(1) }),
  spend: z.object({ token: z.string().min(1) }),
  receive: z.object({ token: z.string().min(1) }),
  floors: z.object({ slippageBps: z.number().int().min(0).max(10_000) }),
  curveTax: z.object({
    protocolTaxPct: z.number().int().min(0).max(100),
    antiSniper: z.object({
      type: z.number().int().min(0).max(255),
      effectivePct: z.number().int().min(0).max(100),
      windowActive: z.boolean(),
      appliesToThisSide: z.boolean(),
    }),
  }),
});

export function extractVirtuals(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = VirtualsQuoteSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;

  const { curveTax } = parsed.data;
  return {
    // The IDENTITY is the pair as the trade spends and receives it, so a buy and
    // a sell of the same agent hash differently and one can never authorize the
    // other.
    tokenIn: parsed.data.spend.token,
    tokenOut: parsed.data.receive.token,
    chainId: parsed.data.chainId,
    amount: amountRaw,
    slippageBps: parsed.data.floors.slippageBps,
    // NOT `pass`: no honeypot or fee-on-transfer audit exists for a curve agent
    // token, and this lane will not invent one. The bounded detail carries what
    // IS known and measured.
    verdict: "unknown",
    safetyDetail: {
      venue: "virtuals-curve",
      side: parsed.data.side,
      agentToken: parsed.data.agent.token,
      curveProtocolTaxPct: curveTax.protocolTaxPct,
      antiSniperType: curveTax.antiSniper.type,
      antiSniperPct: curveTax.antiSniper.effectivePct,
      antiSniperWindowActive: curveTax.antiSniper.windowActive,
      antiSniperAppliesToThisSide: curveTax.antiSniper.appliesToThisSide,
      auditNote:
        "No honeypot or fee-on-transfer audit exists for a Virtuals curve agent token, so the safety verdict is "
        + "unknown rather than pass. What IS measured is the curve's own tax and the anti-sniper window, both read on chain.",
    },
  };
}
