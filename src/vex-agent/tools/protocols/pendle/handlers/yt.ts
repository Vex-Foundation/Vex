/**
 * Pendle YT handlers — quote (read) + buy / sell (mutating) + claim (mutating).
 *
 * This file is the YT family's PUBLIC ENTRY POINT; each tool's implementation
 * lives in `./yt/`.
 *
 * YT (yield token) is the VARIABLE / leveraged-yield leg of a Pendle market: it
 * accrues the underlying yield until expiry and then DECAYS TO ZERO. It is NOT
 * fixed yield. Buy/sell mirror the PT swap path exactly (fresh Convert re-fetch →
 * `selectSafeRoute` fund-safety extractor → exact allowance to the pinned Router →
 * broadcast → spot capture) but bind the YT-specific Router methods
 * (`swapExactTokenForYt` / `swapExactYtForToken`).
 *
 * Claim is an INCOME SWEEP (`redeemDueInterestAndRewardsV2`): it collects accrued
 * YT interest + rewards and LP rewards for the wallet's positions on ONE chain in
 * a single tx. Which markets it sweeps — and which eligible ones the
 * per-transaction cap leaves out, always reported, never silent — is owned by
 * `../claim-targets.ts`. There is nothing to quote (no prequote), but it is approval-gated,
 * Router-pinned, and FULL-decoded via `assertClaimSafe` before signing — funds
 * land on the wallet by protocol (no receiver arg exists), the only external-call
 * surface (`swaps`) is bound empty, and the ONLY allowance a claim may grant is
 * the market's own SY, exact-amount, to the pinned Router (source-verified: the
 * Router pulls the freshly-redeemed SY interest — ActionMiscV3.sol:117-126).
 * Upstream error text NEVER reaches the model.
 */

import type { ProtocolHandler } from "../../types.js";

import { pendleYtQuote } from "./yt/quote.js";
import { executePendleYtSwap } from "./yt/swap.js";
import { pendleClaim } from "./yt/claim.js";

export const PENDLE_YT_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.yt.quote": (p, ctx) => pendleYtQuote(p, ctx),
  "pendle.yt.buy": (p, ctx) => executePendleYtSwap(p, "yt-buy", ctx),
  "pendle.yt.sell": (p, ctx) => executePendleYtSwap(p, "yt-sell", ctx),
  "pendle.claim": (p, ctx) => pendleClaim(p, ctx),
};
