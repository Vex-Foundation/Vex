/**
 * Pendle PT quote extraction (pendle.pt.quote) — fixed-yield PT (Wave 5).
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

// ── Pendle quote result (pendle.pt.quote) — fixed-yield PT (Wave 5) ─────────────
//
// A Pendle quote is NEITHER a token-honeypot check nor a bridge: its verdict
// derives from three market-quality signals, and `fail` is reserved for the ONE
// integrity failure (buying INTO an expired market). Everything else that is
// merely risky/unverified degrades to `unknown` (allowed-with-approval-warning) —
// missing data NEVER silently passes.
//   - price impact MAGNITUDE (sign is unreliable upstream): |impact| ≤ 1% → ok;
//     missing or > 1% → unknown (a > 5% impact is flagged "high" in the detail),
//   - market liquidity floor: ≥ $250k → ok; < $250k or missing → unknown,
//   - expiry sanity: a BUY requires expiry > now (else fail); sell/redeem: n/a.
// A buy also emits `termLock { maturityIso }` in the detail — the typed,
// unspoofable approval-preview warning that funds are locked until maturity.

const PendleQuoteResultSchema = z.object({
  action: z.enum(["swap", "redeem"]),
  direction: z.enum(["buy", "sell", "redeem"]),
  // PT (default when absent) vs YT. A YT buy still fails on an expired market but
  // emits NO term-lock — a YT is not locked, it decays to zero — so the approval
  // preview never renders a misleading "funds locked until maturity" for it.
  instrument: z.enum(["pt", "yt"]).optional(),
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  pt: z.string(),
  yt: z.string().nullable(),
  market: z.string().nullable(),
  receiver: z.string().nullable(),
  expiry: z.string().nullable(),
  liquidityUsd: z.number().nullable(),
  priceImpact: z.number().nullable(),
});

export interface ExtractedPendleQuote {
  readonly action: "swap" | "redeem";
  readonly direction: "buy" | "sell" | "redeem";
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly ptAddress: string;
  readonly ytAddress: string | null;
  readonly marketAddress: string | null;
  readonly receiver: string | null;
  readonly amount: string;
  readonly slippageBps: number | null;
  readonly verdict: SafetyVerdict;
  readonly safetyDetail: Record<string, unknown>;
}

/**
 * Validate + extract a Pendle quote (`pendle.pt.quote`). Returns null when the
 * result payload does not structurally validate. The verdict + bounded
 * `safetyDetail` (incl. the buy `termLock`) are computed here so the recorder
 * persists a structural-only preview. Exported for focused unit tests.
 */
export function extractPendleQuote(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedPendleQuote | null {
  const parsed = PendleQuoteResultSchema.safeParse(data);
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

  // Expiry sanity + term-lock (buy only).
  const expiryMs = d.expiry ? Date.parse(d.expiry) : NaN;
  if (d.direction === "buy") {
    if (!Number.isFinite(expiryMs)) {
      legs.push("unknown");
      safetyDetail.expiry = { checked: false };
    } else if (expiryMs <= Date.now()) {
      legs.push("fail");
      safetyDetail.expiry = { checked: true, expired: true };
    } else {
      legs.push("pass");
      safetyDetail.expiry = { checked: true, expired: false };
      // Typed, unspoofable term-lock — the approval preview renders the fixed
      // message from `maturityIso` (never from model args). ONLY for a PT (a
      // committed term): a YT decays to zero rather than locking, so it carries
      // no term-lock and the preview shows no "locked until maturity" message.
      if (d.instrument !== "yt") {
        safetyDetail.termLock = { maturityIso: new Date(expiryMs).toISOString() };
      }
    }
  }

  return {
    action: d.action,
    direction: d.direction,
    chainId: d.chainId,
    tokenIn: d.tokenIn.address,
    tokenOut: d.tokenOut.address,
    ptAddress: d.pt,
    ytAddress: d.yt,
    marketAddress: d.market,
    receiver: d.receiver,
    amount: amountRaw,
    slippageBps,
    verdict: aggregateVerdict(legs),
    safetyDetail,
  };
}
