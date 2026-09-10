/** The four standard hookless keys, not a claim that all v4 pools use them. */
import { zeroAddress } from "viem";
import type { UniswapToken } from "./types.js";
import type { V4PoolKey } from "./v4-types.js";

export const V4_CANONICAL_FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;

export function canonicalV4PoolKeys(tokenIn: UniswapToken, tokenOut: UniswapToken): readonly V4PoolKey[] {
  const input = tokenIn.isNative ? zeroAddress : tokenIn.address;
  const output = tokenOut.isNative ? zeroAddress : tokenOut.address;
  if (input.toLowerCase() === output.toLowerCase()) return [];
  const [currency0, currency1] = BigInt(input) < BigInt(output) ? [input, output] : [output, input];
  return V4_CANONICAL_FEE_TIERS.map(tier => ({ currency0, currency1, ...tier, hooks: zeroAddress }));
}
