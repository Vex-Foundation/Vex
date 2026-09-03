/**
 * The structural SAFETY block embedded in the Uniswap quote result - factory
 * allowlist + DexScreener min-liquidity + FoT signal.
 *
 * It NEVER gates here (LOCKED #5): the prequote extractor re-validates it into
 * the pass/fail/unknown doctrine, and that is where a refusal is decided.
 */

import { readTokensPairs } from "@tools/dexscreener/price-read.js";
import { UNISWAP_MIN_LIQUIDITY_USD } from "@tools/uniswap/safety.js";
import type { UniswapDeployment } from "@tools/uniswap/deployments.js";
import type { UniswapToken } from "@tools/uniswap/types.js";

export type UniswapSafetyBlock = {
  factory: { checked: true; allowlisted: boolean } | { checkFailed: true };
  liquidity:
    | { checked: true; usd: number | null; aboveThreshold: boolean }
    | { checkFailed: true; reason: string };
  fot: { suspected: boolean };
};

export async function checkOutputLiquidity(
  deployment: UniswapDeployment,
  tokenOut: UniswapToken,
): Promise<UniswapSafetyBlock["liquidity"]> {
  // Native output → WETH: liquidity is not a scam signal for the native wrapper.
  if (tokenOut.isNative) return { checked: true, usd: null, aboveThreshold: true };
  try {
    const pairs = await readTokensPairs(deployment.key, tokenOut.address);
    let bestUsd: number | null = null;
    for (const pair of pairs) {
      if (pair.baseToken?.address?.toLowerCase() !== tokenOut.address.toLowerCase()) continue;
      const usd = pair.liquidity?.usd ?? null;
      if (usd !== null && (bestUsd === null || usd > bestUsd)) bestUsd = usd;
    }
    return { checked: true, usd: bestUsd, aboveThreshold: bestUsd !== null && bestUsd >= UNISWAP_MIN_LIQUIDITY_USD };
  } catch {
    return { checkFailed: true, reason: "unavailable" };
  }
}
