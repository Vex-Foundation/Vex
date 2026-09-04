/**
 * Uniswap quote extraction (uniswap.swap.quote) - factory/liquidity/FoT signals.
 */

import { z } from "zod";

import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import type { SafetyVerdict } from "@vex-agent/db/repos/swap-prequotes.js";

import type { ExtractedQuote } from "./extracted-quote.js";

// ── Uniswap quote result (uniswap.swap.quote) - factory/liquidity/FoT signals ──
//
// Uniswap has no honeypot oracle, so on chains without one Vex derives its own
// conservative signals at quote time (see @tools/uniswap/safety). Verdict map
// (LOCKED #5 - doctrine unchanged; unknown = allowed-with-approval-warning):
//   - factory check failed        → unknown (never pass without confirmation),
//   - factory not allowlisted      → fail (integrity: a spoofed pool),
//   - factory ok + liquidity ≥ min + not FoT → pass,
//   - otherwise                    → unknown.
const UniswapFactorySchema = z.union([
  z.object({ checked: z.literal(true), allowlisted: z.boolean() }),
  z.object({ checkFailed: z.literal(true) }),
]);
const UniswapLiquiditySchema = z.union([
  z.object({ checked: z.literal(true), usd: z.number().nullable(), aboveThreshold: z.boolean() }),
  z.object({ checkFailed: z.literal(true), reason: z.string() }),
]);
const UniswapSafetySchema = z.object({
  factory: UniswapFactorySchema,
  liquidity: UniswapLiquiditySchema,
  fot: z.object({ suspected: z.boolean() }),
});
const UniswapQuoteResultSchema = z.object({
  chainId: z.number(),
  tokenIn: z.object({ address: z.string(), isNative: z.boolean().optional() }),
  tokenOut: z.object({ address: z.string(), isNative: z.boolean().optional() }),
  safety: UniswapSafetySchema,
});

/**
 * Identity leg for a uniswap quote token: a native leg records the SAME
 * sentinel the gate canonicalizes execute-time "native"/ETH input to
 * (`evmLegIdentity` in gate/identity.ts) - the uniswap quote echoes its routing
 * WETH address for a native leg, which would otherwise never hash-match the
 * execute. A verbatim WETH-address quote still records verbatim: an ERC-20
 * WETH swap is a genuinely different trade from a native-ETH swap.
 */
function uniswapLegIdentity(leg: { address: string; isNative?: boolean }): string {
  return leg.isNative === true ? NATIVE_TOKEN_ADDRESS : leg.address;
}

export function extractUniswap(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = UniswapQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippage = typeof params.slippageBps === "number" ? params.slippageBps : null;

  const { factory, liquidity, fot } = parsed.data.safety;
  let verdict: SafetyVerdict;
  if ("checkFailed" in factory) {
    verdict = "unknown";
  } else if (!factory.allowlisted) {
    verdict = "fail";
  } else {
    const liquidityOk = "checked" in liquidity && liquidity.aboveThreshold;
    verdict = liquidityOk && !fot.suspected ? "pass" : "unknown";
  }

  return {
    tokenIn: uniswapLegIdentity(parsed.data.tokenIn),
    tokenOut: uniswapLegIdentity(parsed.data.tokenOut),
    chainId: parsed.data.chainId,
    amount: amountRaw,
    slippageBps: slippage,
    verdict,
    safetyDetail: { factory, liquidity, fot },
  };
}
