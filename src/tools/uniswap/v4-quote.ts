import { zeroAddress, type Address, type Hex, type PublicClient, type Transport, type Chain } from "viem";
import { readTokenPools } from "../dexscreener/price-read.js";
import type { UniswapDeployment } from "./deployments.js";
import type { UniswapRoute, UniswapToken } from "./types.js";
import type { V4RouteBinding } from "./v4-types.js";
import { canonicalV4PoolKeys } from "./v4-canonical-pools.js";
import { V4_QUOTER_ABI, V4_STATE_VIEW_ABI } from "./v4-abis.js";
import { assertV4Binding, bindV4Pool, v4Refusal, v4PoolId } from "./v4-pool.js";

const V4_MAX_DEXSCREENER_CANDIDATES = 3;
export interface V4DiscoveryStats {
  readonly canonical?: { readonly probed: number; readonly initialized: number; readonly failed: number };
  readonly dexscreenerUnavailable?: boolean;
  readonly unavailable?: boolean;
  readonly indexed: number;
  /** Matching DexScreener entries before its three-candidate cap. */
  readonly matching: number;
  /** Binding/quote attempts across both sources, after pool-ID deduplication. */
  readonly considered: number;
  readonly refused: number;
}
export interface V4QuoteCandidates { readonly routes: readonly UniswapRoute[]; readonly discovery: V4DiscoveryStats }

function currencyMatches(token: UniswapToken, currency: string | null, weth: Address): boolean {
  if (!currency) return false;
  return currency.toLowerCase() === token.address.toLowerCase()
    || ((token.isNative || token.address.toLowerCase() === weth.toLowerCase()) && currency.toLowerCase() === zeroAddress);
}
export async function quoteBoundV4Pool(
  client: PublicClient<Transport, Chain>, deployment: UniswapDeployment,
  bound: V4RouteBinding, amountIn: bigint,
): Promise<Extract<UniswapRoute, { version: "v4" }>> {
  assertV4Binding(deployment, bound);
  // The quoter casts uint128 to int128 before negating it. Refuse its signed overflow domain.
  if (amountIn <= 0n || amountIn >= 1n << 127n) throw v4Refusal("input is outside the quoter's positive int128 domain");
  const currencyIn = bound.zeroForOne ? bound.poolKey.currency0 : bound.poolKey.currency1;
  const currencyOut = bound.zeroForOne ? bound.poolKey.currency1 : bound.poolKey.currency0;
  const fresh = await bindV4Pool(client, deployment, bound.poolId, currencyIn, currencyOut);
  return quoteFreshV4Pool(client, deployment, bound, fresh, amountIn);
}

/** Reuse only a binding read within this execute, never the stored approval. */
export async function quoteFreshV4Pool(
  client: PublicClient<Transport, Chain>, deployment: UniswapDeployment,
  approved: V4RouteBinding, fresh: V4RouteBinding, amountIn: bigint,
): Promise<Extract<UniswapRoute, { version: "v4" }>> {
  assertV4Binding(deployment, approved);
  assertV4Binding(deployment, fresh);
  if (fresh.poolId.toLowerCase() !== approved.poolId.toLowerCase()
    || v4PoolId(fresh.poolKey) !== v4PoolId(approved.poolKey)
    || fresh.zeroForOne !== approved.zeroForOne
    || fresh.hookPermissions !== approved.hookPermissions) throw v4Refusal("PoolKey or hook permissions changed");
  return quoteV4WithBinding(client, deployment, fresh, amountIn);
}
async function quoteV4WithBinding(client: PublicClient<Transport, Chain>, deployment: UniswapDeployment, fresh: V4RouteBinding, amountIn: bigint): Promise<Extract<UniswapRoute, { version: "v4" }>> {
  if (amountIn <= 0n || amountIn >= 1n << 127n) throw v4Refusal("input is outside the quoter domain");
  const currencyIn = fresh.zeroForOne ? fresh.poolKey.currency0 : fresh.poolKey.currency1;
  const currencyOut = fresh.zeroForOne ? fresh.poolKey.currency1 : fresh.poolKey.currency0;
  const { result } = await client.simulateContract({
    address: deployment.v4!.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
    args: [{ poolKey: fresh.poolKey, zeroForOne: fresh.zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  if (result[0] <= 0n || result[1] <= 0n) throw v4Refusal("quoter returned no output or gas estimate");
  return { version: "v4", path: [currencyIn, currencyOut], amountOut: result[0], gasEstimate: result[1], v4: fresh };
}
export async function quoteV4Candidates(
  client: PublicClient<Transport, Chain>,
  args: { readonly deployment: UniswapDeployment; readonly tokenIn: UniswapToken; readonly tokenOut: UniswapToken; readonly amountIn: bigint },
): Promise<V4QuoteCandidates> {
  const { deployment, tokenIn, tokenOut, amountIn } = args;
  if (!deployment.v4) return { routes: [], discovery: { indexed: 0, matching: 0, considered: 0, refused: 0 } };
  const discoveryToken = tokenOut.isNative ? tokenIn.address : tokenOut.address;
  let pairs: Awaited<ReturnType<typeof readTokenPools>> = [];
  let dexscreenerUnavailable = false;
  try { pairs = await readTokenPools(deployment.key, discoveryToken); }
  catch { dexscreenerUnavailable = true; }

  const seen = new Set<string>();
  const matching = pairs.filter((pair) => {
    if (pair.chainId !== deployment.key || pair.dexId !== "uniswap" || !pair.labels?.includes("v4") || !/^0x[\da-fA-F]{64}$/.test(pair.pairAddress)) return false;
    const a = pair.baseToken.address, b = pair.quoteToken.address;
    const match = (currencyMatches(tokenIn, a, deployment.weth) && currencyMatches(tokenOut, b, deployment.weth))
      || (currencyMatches(tokenIn, b, deployment.weth) && currencyMatches(tokenOut, a, deployment.weth));
    if (!match || seen.has(pair.pairAddress.toLowerCase())) return false;
    seen.add(pair.pairAddress.toLowerCase());
    return true;
  }).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const routes: UniswapRoute[] = [];
  const attempted = new Set<string>();
  let considered = 0, refused = 0;
  for (const pair of matching) {
    if (considered === V4_MAX_DEXSCREENER_CANDIDATES) break;
    considered++;
    attempted.add(pair.pairAddress.toLowerCase());
    try {
      const input = currencyMatches(tokenIn, pair.baseToken.address, deployment.weth) ? pair.baseToken.address : pair.quoteToken.address;
      const output = input === pair.baseToken.address ? pair.quoteToken.address : pair.baseToken.address;
      const bound = await bindV4Pool(client, deployment, pair.pairAddress as Hex, input as Address, output as Address);
      routes.push(await quoteV4WithBinding(client, deployment, bound, amountIn));
    } catch { refused++; }
  }
  const canonical = { probed: 0, initialized: 0, failed: 0 };
  const currencyIn = tokenIn.isNative ? zeroAddress : tokenIn.address;
  const currencyOut = tokenOut.isNative ? zeroAddress : tokenOut.address;
  // Independent of the DexScreener cap and availability, bounded to four reads.
  // The existing PositionManager hash binding still applies to every quote.
  for (const key of canonicalV4PoolKeys(tokenIn, tokenOut)) {
    const poolId = v4PoolId(key);
    if (attempted.has(poolId)) continue;
    canonical.probed++;
    let initialized: boolean;
    try {
      const slot = await client.readContract({ address: deployment.v4.stateView, abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
      initialized = slot[0] !== 0n;
    } catch { canonical.failed++; continue; }
    if (!initialized) continue;
    canonical.initialized++;
    attempted.add(poolId);
    considered++;
    try {
      const bound = await bindV4Pool(client, deployment, poolId, currencyIn, currencyOut);
      routes.push(await quoteV4WithBinding(client, deployment, bound, amountIn));
    } catch { refused++; }
  }
  return { routes, discovery: { indexed: pairs.length, matching: matching.length, considered, refused,
    canonical, ...(dexscreenerUnavailable ? { dexscreenerUnavailable: true } : {}) } };

}
