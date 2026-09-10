import { readTokenPools } from "../dexscreener/price-read.js";
import { selectTokenWatchPrice } from "../dexscreener/token-watch-price.js";
import { getWrappedNativeContract } from "./wrapped-native.js";
import { swapPriceReferenceSchema, type SwapPriceReference } from "./swap-price-reference.js";
import type { DexPair } from "../dexscreener/types.js";

/** Uses the existing 30-second price-read cache and normalized, outlier-screened pool selector. */
export async function readSwapPriceReference(input: {
  readonly chainId: number;
  readonly chainSlug: string;
  /** Venue-verified identity for pricing only; this grants no wrap or signing capability. */
  readonly wrappedNativeAddress?: string;
  /** A full output-token population already requested by this quote's liquidity check, never representative rows. */
  readonly outputPools?: Promise<readonly DexPair[]> | undefined;
  readonly tokenIn: { readonly address: string; readonly isNative: boolean };
  readonly tokenOut: { readonly address: string; readonly isNative: boolean };
}): Promise<SwapPriceReference | null> {
  const wrapped = input.wrappedNativeAddress ?? getWrappedNativeContract(input.chainId)?.address;
  const inAddress = input.tokenIn.isNative ? wrapped : input.tokenIn.address;
  const outAddress = input.tokenOut.isNative ? wrapped : input.tokenOut.address;
  if (inAddress === undefined || outAddress === undefined) return null;
  try {
    // At most two sequential full-population reads, each cached for 30 seconds.
    // Merely occurring in an output pool does not prove that the input's pool
    // population is covered. Reuse is valid only for identical pricing assets.
    const outputPairs = await (input.outputPools ?? readTokenPools(input.chainSlug, outAddress));
    const outPrice = selectTokenWatchPrice(outputPairs, { chainSlug: input.chainSlug, tokenAddress: outAddress });
    const inputPairs = inAddress.toLowerCase() === outAddress.toLowerCase()
      ? outputPairs : await readTokenPools(input.chainSlug, inAddress);
    const inPrice = selectTokenWatchPrice(inputPairs,
      { chainSlug: input.chainSlug, tokenAddress: inAddress });
    if (inPrice === null || outPrice === null || inPrice.liquidityUsd <= 0 || outPrice.liquidityUsd <= 0) return null;
    return swapPriceReferenceSchema.parse({ source: "dexscreener", chainId: input.chainId,
      tokenIn: input.tokenIn.address, tokenOut: input.tokenOut.address,
      inputPriceUsd: inPrice.priceUsd, outputPriceUsd: outPrice.priceUsd,
      inputPair: inPrice.pairAddress, outputPair: outPrice.pairAddress });
  } catch {
    return null;
  }
}
