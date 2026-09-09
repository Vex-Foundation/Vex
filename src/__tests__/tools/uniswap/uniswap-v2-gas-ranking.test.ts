import { describe, expect, it } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { quoteBestRoute } from "@tools/uniswap/quote.js";
import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V3_QUOTER_V2_ABI } from "@tools/uniswap/abis.js";

const original = getUniswapDeployment(1);
if (!original?.v2 || !original.v3) throw new Error("test requires both existing router deployments");
const deployment = { ...original, connectors: [], v4: undefined, v3: { ...original.v3, feeTiers: [3000] } };
const wallet: Address = "0x1111111111111111111111111111111111111111";
const tokenIn = { address: "0x2222222222222222222222222222222222222222", symbol: "TOKEN", decimals: 18, isNative: false } as const;
const tokenOut = { address: deployment.weth, symbol: "ETH", decimals: 18, isNative: true };

function client(failEstimate = false) {
  const estimates: { from: string; to: string; data: Hex; value: Hex }[] = [];
  const c = createPublicClient({ chain: mainnet, transport: custom({ request: async ({ method, params }) => {
    if (method === "eth_gasPrice") return "0x1";
    if (method === "eth_estimateGas") {
      const tx = (params as [{ from: string; to: string; data: Hex; value: Hex }])[0];
      estimates.push(tx);
      if (failEstimate) throw new Error("allowance not yet sufficient");
      return "0x64";
    }
    if (method === "eth_call") {
      const tx = (params as [{ to: string; data: Hex }])[0];
      if (tx.to.toLowerCase() === deployment.v2?.router02.toLowerCase()) return encodeFunctionResult({ abi: UNISWAP_V2_ROUTER_ABI, functionName: "getAmountsOut", result: [100n, 1000n] });
      if (tx.to.toLowerCase() === deployment.v3.quoterV2.toLowerCase()) return encodeFunctionResult({ abi: UNISWAP_V3_QUOTER_V2_ABI, functionName: "quoteExactInputSingle", result: [1100n, 0n, 0, 300n] });
    }
    throw new Error("unsupported test RPC");
  } }, { retryCount: 0 }) });
  return { c, estimates };
}

describe("wallet-aware V2 net-of-gas ranking", () => {
  it("a measured V2 call wins over greater V3 output after gas", async () => {
    const { c, estimates } = client();
    const result = await quoteBestRoute(c, { deployment, tokenIn, tokenOut, amountIn: 100n, slippageBps: 100, wallet });
    expect(result?.route.version).toBe("v2");
    expect(result?.route.gasEstimate).toBe(100n);
    expect(result?.selectionBasis).toBe("output_net_of_quoted_gas");
    expect(estimates).toHaveLength(1);
    const tx = estimates[0];
    if (!tx) throw new Error("missing estimate");
    expect(tx.from).toBe(wallet);
    expect(tx.to.toLowerCase()).toBe(deployment.v2?.router02.toLowerCase());
    expect(BigInt(tx.value)).toBe(0n);
    const decoded = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: tx.data });
    expect(decoded.functionName).toBe("swapExactTokensForETHSupportingFeeOnTransferTokens");
    expect(decoded.args).toEqual([100n, 990n, [tokenIn.address, deployment.weth], wallet, expect.any(BigInt)]);
  });
  it.each(["no_wallet", "estimate_failed"] as const)("%s keeps the explicit gross-output fallback", async scenario => {
    const { c, estimates } = client(scenario === "estimate_failed");
    const result = await quoteBestRoute(c, { deployment, tokenIn, tokenOut, amountIn: 100n, ...(scenario === "no_wallet" ? {} : { wallet }) });
    expect(result?.route.version).toBe("v3");
    expect(result?.selectionBasis).toBe("gross_output_gas_comparison_unavailable");
    expect(estimates).toHaveLength(scenario === "no_wallet" ? 0 : 1);
  });
});
