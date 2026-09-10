import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeFunctionResult, type Chain } from "viem";
import { base } from "viem/chains";
import { refreshUniswapRoute } from "@tools/uniswap/refresh-route.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V3_QUOTER_V2_ABI } from "@tools/uniswap/abis.js";

const deployment = getUniswapDeployment(8453);
if (!deployment) throw new Error("Base deployment missing");
const path = ["0x4200000000000000000000000000000000000006", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"];

describe("accepted route refresh", () => {
  it.each(["v2", "v3"] as const)("gets a fresh output with one %s call", async (version) => {
    const bytes = version === "v2"
      ? encodeFunctionResult({ abi: UNISWAP_V2_ROUTER_ABI, functionName: "getAmountsOut", result: [100n, 91n] })
      : encodeFunctionResult({ abi: UNISWAP_V3_QUOTER_V2_ABI, functionName: "quoteExactInput", result: [91n, [1n], [0], 50_000n] });
    const request = vi.fn(async (_request: { method: string }) => bytes);
    const chain: Chain = base;
    const client = createPublicClient({ chain, transport: custom({ request }) });
    const result = await refreshUniswapRoute(client, deployment, { version, path, ...(version === "v3" ? { fees: [500] } : {}) }, 100n);
    expect(result.amountOut).toBe(91n);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ method: "eth_call" });
  });
});
