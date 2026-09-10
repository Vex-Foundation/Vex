import { readTokensPairs } from "../dexscreener/price-read.js";
import { selectTokenWatchPrice } from "../dexscreener/token-watch-price.js";
import { getWrappedNativeContract } from "./wrapped-native.js";
import { swapPriceReferenceSchema, type SwapPriceReference } from "./swap-price-reference.js";

/** Uses the existing 30-second price-read cache and normalized, outlier-screened pool selector. */
export async function readSwapPriceReference(input: {
  readonly chainId: number;
  readonly chainSlug: string;
  readonly tokenIn: { readonly address: string; readonly isNative: boolean };
  readonly tokenOut: { readonly address: string; readonly isNative: boolean };
}): Promise<SwapPriceReference | null> {
  const wrapped = getWrappedNativeContract(input.chainId)?.address;
  const inAddress = input.tokenIn.isNative ? wrapped : input.tokenIn.address;
  const outAddress = input.tokenOut.isNative ? wrapped : input.tokenOut.address;
  if (inAddress === undefined || outAddress === undefined) return null;
  try {
    // Sequential: two small reads, sharing the same provider cache as liquidity and price watches.
    const outputPairs = await readTokensPairs(input.chainSlug, outAddress);
    const outPrice = selectTokenWatchPrice(outputPairs, { chainSlug: input.chainSlug, tokenAddress: outAddress });
    // A pair containing both assets supplies a consistent reference for both legs in one read.
    const samePairInput = selectTokenWatchPrice(outputPairs, { chainSlug: input.chainSlug, tokenAddress: inAddress });
    const inPrice = samePairInput ?? selectTokenWatchPrice(await readTokensPairs(input.chainSlug, inAddress),
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
