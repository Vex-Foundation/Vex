/** Read-only regression: no signer, key lookup, nonce reservation or broadcast. */
import { describe, expect, it } from "vitest";
import { createPublicClient } from "viem";
import { z } from "zod";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { buildSwapTx } from "@tools/uniswap/execute.js";
import { buildPinnedEvmTransport, resolvePinnedRpcEndpoint, rpcHostOf } from "@tools/evm-chains/rpc-transport.js";
import { v4RouteBindingSchema } from "@tools/uniswap/v4-types.js";
import { classifyUniswapRevertError } from "@tools/uniswap/revert-mapping.js";

const enabled = process.env.VEX_UNISWAP_V4_LIVE_ESTIMATE === "1";
const wallet = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const context: ProtocolExecutionContext = { sessionPermission: "restricted", approved: false,
  walletResolution: { source: "session", evm: null, solana: null }, walletPolicy: { kind: "none" } };
const quoteSchema = z.object({ route: v4RouteBindingSchema.extend({ version: z.literal("v4") }).strip(),
  swapAmountRaw: z.string(), amountOutRaw: z.string(), minAmountOutRaw: z.string() });

(enabled ? describe : describe.skip)("Uniswap v4 native quotes estimated on the execution RPC", () => {
  for (const sample of [
    { chainId: 8453, tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    { chainId: 4663, tokenOut: "0x008Df4b3E857D06c4603Aeb11F267ccD32ce2005" },
  ]) it(`estimates and calls chain ${sample.chainId} without signing`, { timeout: 120000 }, async () => {
    const result = await executeProtocolTool({ toolId: "uniswap.swap.quote", params: {
      chain: String(sample.chainId), tokenIn: "ETH", tokenOut: sample.tokenOut, amountIn: "0.0001", slippageBps: 100,
    } }, context);
    expect(result.success, result.output).toBe(true);
    const quote = quoteSchema.parse(JSON.parse(result.output));
    const binding = v4RouteBindingSchema.strip().parse(quote.route);
    const deployment = getUniswapDeployment(sample.chainId);
    if (!deployment) throw new Error("Missing sample deployment");
    const endpoint = await resolvePinnedRpcEndpoint(sample.chainId);
    const client = createPublicClient({ chain: getUniswapPublicClient(deployment).chain,
      transport: buildPinnedEvmTransport(sample.chainId) });
    const tx = buildSwapTx({ deployment, route: { version: "v4", v4: binding,
      path: binding.zeroForOne ? [binding.poolKey.currency0, binding.poolKey.currency1] : [binding.poolKey.currency1, binding.poolKey.currency0],
      amountOut: BigInt(quote.amountOutRaw) }, amountIn: BigInt(quote.swapAmountRaw), minAmountOut: BigInt(quote.minAmountOutRaw),
      recipient: wallet, deadline: BigInt(Math.floor(Date.now() / 1000) + 600), tokenInIsNative: true, tokenOutIsNative: false });
    try {
      const gas = await client.estimateGas({ account: wallet, ...tx });
      expect(gas).toBeGreaterThan(0n);
      const called = await client.call({ account: wallet, ...tx });
      expect(called.data ?? "0x").toBe("0x");
      process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_estimate", chainId: sample.chainId, host: rpcHostOf(endpoint.url),
        poolId: binding.poolId, poolKey: binding.poolKey, amountInRaw: quote.swapAmountRaw, minAmountOutRaw: quote.minAmountOutRaw,
        gas: gas.toString(), callResult: called.data ?? "0x" }) + "\n");
    } catch (error) {
      const failure = classifyUniswapRevertError(error);
      // Only decoded diagnostic fields, never viem's request or account objects.
      process.stdout.write(JSON.stringify({ event: "uniswap.v4.live_estimate_refusal", chainId: sample.chainId,
        failureCode: failure.failureCode, revert: failure.revert }) + "\n");
      throw new Error("Read-only estimate or call failed; see its diagnostic evidence");
    }
  });
});
