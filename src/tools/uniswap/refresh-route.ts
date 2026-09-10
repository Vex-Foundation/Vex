import { encodePacked, getAddress, type Chain, type PublicClient, type Transport } from "viem";
import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V3_QUOTER_V2_ABI } from "./abis.js";
import type { UniswapDeployment } from "./deployments.js";
import type { UniswapRoute } from "./types.js";

/** One fresh quote on the accepted path, avoiding another full candidate search. No signing. */
export async function refreshUniswapRoute(
  client: PublicClient<Transport, Chain>,
  deployment: UniswapDeployment,
  route: { readonly version: "v2" | "v3"; readonly path: readonly string[]; readonly fees?: readonly number[] },
  amountIn: bigint,
): Promise<UniswapRoute> {
  const path = route.path.map((address) => getAddress(address));
  if (route.version === "v2" && deployment.v2) {
    const amounts = await client.readContract({ address: deployment.v2.router02,
      abi: UNISWAP_V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, path] });
    const amountOut = amounts[amounts.length - 1];
    if (amountOut === undefined || amountOut <= 0n) throw new Error("Accepted Uniswap path no longer prices this trade; re-quote.");
    return { version: "v2", path, amountOut };
  }
  if (route.version === "v3" && deployment.v3 && route.fees?.length === path.length - 1) {
    const types: string[] = ["address"];
    const values: unknown[] = [path[0]];
    for (let index = 0; index < route.fees.length; index++) {
      types.push("uint24", "address");
      values.push(route.fees[index], path[index + 1]);
    }
    const result = await client.readContract({ address: deployment.v3.quoterV2,
      abi: UNISWAP_V3_QUOTER_V2_ABI, functionName: "quoteExactInput", args: [encodePacked(types, values), amountIn] });
    const [amountOut, , , gasEstimate] = result;
    if (amountOut <= 0n) throw new Error("Accepted Uniswap path no longer prices this trade; re-quote.");
    return { version: "v3", path, fees: [...route.fees], amountOut, gasEstimate };
  }
  throw new Error("Accepted Uniswap path is unavailable on this deployment; re-quote.");
}
