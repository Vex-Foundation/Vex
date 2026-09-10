import { z } from "zod";
import { parseBoundedDecimal, formatBoundedDecimal } from "../dexscreener/token-watch-price.js";

const positiveDecimal = z.string().refine((value) => {
  const parsed = parseBoundedDecimal(value);
  return parsed !== null && parsed.units > 0n;
});

/** Stored with the quote and activity so AgentScan values the same assets against the same reference. */
export const swapPriceReferenceSchema = z.object({
  source: z.literal("dexscreener"),
  chainId: z.number().int().positive(),
  tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  inputPriceUsd: positiveDecimal,
  outputPriceUsd: positiveDecimal,
  inputPair: z.string().min(1).max(128),
  outputPair: z.string().min(1).max(128),
});
export type SwapPriceReference = z.infer<typeof swapPriceReferenceSchema>;

export function canonicalizeSwapPriceReference(reference: SwapPriceReference): string {
  return JSON.stringify([reference.source, reference.chainId, reference.tokenIn.toLowerCase(),
    reference.tokenOut.toLowerCase(), reference.inputPriceUsd, reference.outputPriceUsd,
    reference.inputPair.toLowerCase(), reference.outputPair.toLowerCase()]);
}

/** Atomic token amounts stay integers throughout valuation. Only the dimensionless impact is a number. */
export function valueSwapAtReference(reference: SwapPriceReference, input: {
  readonly amountInRaw: string; readonly amountOutRaw: string;
  readonly inputDecimals: number; readonly outputDecimals: number;
}): { amountInUsd: string; amountOutUsd: string; priceImpactFraction: number } {
  const value = (raw: string, decimals: number, price: string) => {
    const parsed = parseBoundedDecimal(price);
    if (!parsed || !/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error("Invalid swap reference valuation inputs");
    }
    return { units: BigInt(raw) * parsed.units, scale: decimals + parsed.scale };
  };
  const from = value(input.amountInRaw, input.inputDecimals, reference.inputPriceUsd);
  const to = value(input.amountOutRaw, input.outputDecimals, reference.outputPriceUsd);
  if (from.units === 0n) throw new Error("Cannot measure impact against zero input value");
  const scale = Math.max(from.scale, to.scale);
  const a = from.units * 10n ** BigInt(scale - from.scale);
  const b = to.units * 10n ** BigInt(scale - to.scale);
  const precision = 1_000_000_000_000n;
  const difference = (a - b) * precision;
  // Round adverse impact upward at 12 fractional places, so rounding cannot bypass the ceiling.
  const impact = difference > 0n ? (difference + a - 1n) / a : difference / a;
  return { amountInUsd: formatBoundedDecimal(from), amountOutUsd: formatBoundedDecimal(to),
    priceImpactFraction: Number(impact) / Number(precision) };
}

/** An absolute one-dollar discrepancy flags the provider feed; it never changes a token amount or floor. */
export function providerUsdDisagrees(provider: string, chosen: string): boolean {
  const left = parseBoundedDecimal(provider), right = parseBoundedDecimal(chosen);
  if (left === null || right === null || left.units === 0n) return true;
  const scale = Math.max(left.scale, right.scale);
  const difference = left.units * 10n ** BigInt(scale - left.scale) - right.units * 10n ** BigInt(scale - right.scale);
  return (difference < 0n ? -difference : difference) > 10n ** BigInt(scale);
}
