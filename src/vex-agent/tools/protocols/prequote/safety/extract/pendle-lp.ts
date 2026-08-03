/**
 * Pendle LP quote extraction (pendle.lp.quote) — single-token add / remove (P5).
 */

import { z } from "zod";

import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

import { aggregateVerdict } from "./verdict.js";
import type { LegVerdict } from "./verdict.js";
import {
  PENDLE_IMPACT_HIGH,
  PENDLE_IMPACT_WARN,
  PENDLE_LIQUIDITY_FLOOR_USD,
} from "./pendle-thresholds.js";

// ── Pendle LP quote result (pendle.lp.quote) — single-token add / remove (P5) ────
//
// An LP quote previews adding single-token liquidity (token → LP) or removing it
// (LP → token). The verdict reuses the PT market-quality signals: liquidity floor
// + price-impact magnitude. LP is NOT a fixed-rate term commitment, so there is NO
// term-lock on either direction. The market EXPIRES, though: after expiry LP still
// removes (principal side) but stops earning swap fees/rewards — so the bounded
// `safetyDetail` DISCLOSES expiry/matured state (informational; never a hard fail).

const PendleLpQuoteResultSchema = z.object({
  direction: z.enum(["add", "remove"]),
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  market: z.string(),
  expiry: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  priceImpact: z.number().nullable(),
});

export interface ExtractedPendleLpQuote {
  readonly direction: "add" | "remove";
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly market: string;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Pendle LP quote (`pendle.lp.quote`). Returns null when the
 * result payload does not structurally validate. Exported for focused unit tests.
 */
export function extractPendleLpQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedPendleLpQuote | null {
  const parsed = PendleLpQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippageBps = typeof params.slippageBps === "number" ? params.slippageBps : null;
  const d = parsed.data;

  const legs: LegVerdict[] = [];
  const safetyDetail: Record<string, unknown> = {};

  // Liquidity floor.
  if (d.liquidityUsd === null) {
    legs.push("unknown");
    safetyDetail.liquidity = { checked: false };
  } else {
    const ok = d.liquidityUsd >= PENDLE_LIQUIDITY_FLOOR_USD;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.liquidity = { checked: true, usd: d.liquidityUsd, aboveFloor: ok };
  }

  // Price-impact magnitude (sign unreliable).
  if (d.priceImpact === null) {
    legs.push("unknown");
    safetyDetail.priceImpact = { checked: false };
  } else {
    const mag = Math.abs(d.priceImpact);
    const ok = mag <= PENDLE_IMPACT_WARN;
    legs.push(ok ? "pass" : "unknown");
    safetyDetail.priceImpact = { checked: true, magnitude: mag, high: mag > PENDLE_IMPACT_HIGH };
  }

  // Expiry disclosure — informational (NOT a term-lock, NOT a hard fail). A
  // matured market can still be removed but no longer earns fees/rewards.
  const expiryMs = d.expiry ? Date.parse(d.expiry) : NaN;
  if (Number.isFinite(expiryMs)) {
    safetyDetail.expiry = {
      checked: true,
      maturityIso: new Date(expiryMs).toISOString(),
      matured: expiryMs <= Date.now(),
    };
  } else {
    safetyDetail.expiry = { checked: false };
  }

  return {
    direction: d.direction,
    chainId: d.chainId,
    tokenIn: d.tokenIn.address,
    tokenOut: d.tokenOut.address,
    market: d.market,
    amount: amountRaw,
    slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}
