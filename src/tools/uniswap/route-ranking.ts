/** Rank comparable quote candidates with integer gas conversion and explicit gaps. */
import { parseUnits, type Address, type PublicClient, type Chain, type Transport } from "viem";
import { buildV2SwapTx } from "./execute.js";
import type { UniswapRoute, UniswapToken } from "./types.js";
import type { UniswapDeployment } from "./deployments.js";
import { readTokenPools } from "../dexscreener/price-read.js";

export interface RouteGasPrice { readonly gasPriceWei: bigint; readonly outputUnits: bigint; readonly nativeWei: bigint }
export function selectUniswapRoute(routes: readonly UniswapRoute[], price: RouteGasPrice | null): { route: UniswapRoute; selectionBasis: string } | null {
  if (routes.length === 0) return null;
  const comparable = price !== null && price.nativeWei > 0n && price.outputUnits > 0n && routes.every(r => r.gasEstimate !== undefined);
  const score = (r: UniswapRoute): bigint => comparable && price && r.gasEstimate !== undefined
    ? r.amountOut - (r.gasEstimate * price.gasPriceWei * price.outputUnits + price.nativeWei - 1n) / price.nativeWei
    : r.amountOut;
  let best = routes[0]!;
  for (const route of routes) if (score(route) > score(best)) best = route;
  return { route: best, selectionBasis: comparable ? "output_net_of_quoted_gas" : "gross_output_gas_comparison_unavailable" };
}
export async function outputGasPrice(deployment: UniswapDeployment, tokenOut: UniswapToken, gasPriceWei: bigint): Promise<RouteGasPrice | null> {
  if (tokenOut.isNative || tokenOut.address.toLowerCase() === deployment.weth.toLowerCase()) return { gasPriceWei, outputUnits: 1n, nativeWei: 1n };
  const pairs = await readTokenPools(deployment.key, tokenOut.address);
  const pair = pairs.filter(p => p.baseToken.address?.toLowerCase() === tokenOut.address.toLowerCase()
    && [deployment.weth.toLowerCase(), "0x0000000000000000000000000000000000000000"].includes(p.quoteToken.address?.toLowerCase() ?? "")
    && p.priceNative && /^\d+(\.\d{1,18})?$/.test(p.priceNative))
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pair?.priceNative) return null;
  const nativeWei = parseUnits(pair.priceNative, 18);
  return nativeWei > 0n ? { gasPriceWei, nativeWei, outputUnits: 10n ** BigInt(tokenOut.decimals) } : null;
}

/** Estimate each successful V2 candidate from the actual executing wallet. */
export async function estimateV2RouteGas(client: PublicClient<Transport, Chain>, input: {
  readonly deployment: UniswapDeployment;
  readonly route: UniswapRoute;
  readonly wallet: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly tokenInIsNative: boolean;
  readonly tokenOutIsNative: boolean;
}): Promise<UniswapRoute> {
  const tx = buildV2SwapTx({ ...input, recipient: input.wallet, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
  try {
    const gasEstimate = await client.estimateGas({ account: input.wallet, ...tx });
    return gasEstimate > 0n ? { ...input.route, gasEstimate } : input.route;
  } catch {
    // An absent allowance, insufficient balance or an unavailable estimate is
    // not a gas figure. The ranking labels its gross-output fallback explicitly.
    return input.route;
  }
}
