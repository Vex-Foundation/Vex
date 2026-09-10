/** Read-only: one full-pool request per Kyber chain, sequentially; no wallet or signing access. */
import { getKyberChains } from "@tools/kyberswap/chains.js";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import { readTokenPools } from "@tools/dexscreener/price-read.js";
import { selectTokenWatchPrice } from "@tools/dexscreener/token-watch-price.js";
import { setTimeout } from "node:timers/promises";

async function measure(): Promise<void> {
  for (const chain of getKyberChains().filter((entry) => entry.aggregator)) {
    const address = getKyberWrappedNativeAddress(chain.slug);
    const start = performance.now();
    try {
      const pools = await readTokenPools(chain.slug, address, { signal: AbortSignal.timeout(12000) });
      const price = selectTokenWatchPrice(pools, { chainSlug: chain.slug, tokenAddress: address });
      console.log(JSON.stringify({ at: new Date().toISOString(), chainId: chain.chainId,
        chainKey: chain.slug, wrappedNativeAddress: address, rowCount: pools.length,
        matchingChainRows: pools.filter((pool) => pool.chainId === chain.slug).length,
        priced: price !== null && price.liquidityUsd > 0,
        elapsedMs: Math.round(performance.now() - start) }));
    } catch {
      console.log(JSON.stringify({ at: new Date().toISOString(), chainId: chain.chainId,
        chainKey: chain.slug, wrappedNativeAddress: address, outcome: "independent_reference_unavailable",
        elapsedMs: Math.round(performance.now() - start) }));
    }
    await setTimeout(300);
  }
}
measure().catch(() => { console.error("Native reference probe unavailable"); process.exitCode = 1; });
