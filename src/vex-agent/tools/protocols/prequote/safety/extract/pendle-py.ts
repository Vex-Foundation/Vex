/**
 * Pendle PY quote extraction (pendle.py.quote) — mint / pre-expiry redeem (P4).
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

// ── Pendle PY quote result (pendle.py.quote) — mint / pre-expiry redeem (P4) ─────
//
// A PY quote previews a mint (token → PT+YT) or a pre-expiry redeem (PT+YT →
// token). The verdict reuses the PT market-quality signals: liquidity floor +
// price-impact magnitude. A MINT also enforces expiry sanity (you cannot mint
// into an expired market) and emits `termLock { maturityIso }` — the minted PT is
// a committed term. A pre-expiry redeem is an EXIT, so it carries no term-lock and
// no expiry gate.

const PendlePyQuoteResultSchema = z.object({
  direction: z.enum(["mint", "redeem"]),
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  pt: z.string(),
  yt: z.string().nullable(),
  market: z.string().nullable(),
  expiry: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  priceImpact: z.number().nullable(),
});

export interface ExtractedPendlePyQuote {
  readonly direction: "mint" | "redeem";
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly ptAddress: string;
  readonly ytAddress: string | null;
  readonly marketAddress: string | null;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Pendle PY quote (`pendle.py.quote`). Returns null when the
 * result payload does not structurally validate. Exported for focused unit tests.
 */
export function extractPendlePyQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedPendlePyQuote | null {
  const parsed = PendlePyQuoteResultSchema.safeParse(data);
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

  // Expiry sanity + term-lock — MINT only (a redeem is an exit).
  if (d.direction === "mint") {
    const expiryMs = d.expiry ? Date.parse(d.expiry) : NaN;
    if (!Number.isFinite(expiryMs)) {
      legs.push("unknown");
      safetyDetail.expiry = { checked: false };
    } else if (expiryMs <= Date.now()) {
      legs.push("fail");
      safetyDetail.expiry = { checked: true, expired: true };
    } else {
      legs.push("pass");
      safetyDetail.expiry = { checked: true, expired: false };
      // The minted PT commits funds until maturity — surface the typed,
      // unspoofable term-lock to the approval preview.
      safetyDetail.termLock = { maturityIso: new Date(expiryMs).toISOString() };
    }
  }

  return {
    direction: d.direction,
    chainId: d.chainId,
    tokenIn: d.tokenIn.address,
    tokenOut: d.tokenOut.address,
    ptAddress: d.pt,
    ytAddress: d.yt,
    marketAddress: d.market,
    amount: amountRaw,
    slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}
