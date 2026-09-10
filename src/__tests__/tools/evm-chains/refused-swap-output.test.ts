import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, encodeAbiParameters, getAddress } from "viem";
import { observeRefusedKyberOutput } from "@tools/kyberswap/evm/observe-refused-output.js";
import { observeRefusedUniswapOutput } from "@tools/uniswap/observe-refused-output.js";
import { META_AGGREGATION_ROUTER_V2_SWAP_ABI as kyber } from "@tools/kyberswap/evm/swap-calldata-guard.js";
import { UNISWAP_V3_SWAP_ROUTER_02_ABI as v3 } from "@tools/uniswap/abis.js";
import { buildSwapTx } from "@tools/uniswap/execute.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import type { SwapOutputCallClient } from "@tools/evm-chains/swap-output-shortfall.js";

const wallet = getAddress("0x1111111111111111111111111111111111111111");
const target = getAddress("0x2222222222222222222222222222222222222222");
const token = getAddress("0x3333333333333333333333333333333333333333");

describe("post-refusal output observations cannot change the signed floor", () => {
  it("reads Kyber returnAmount with a private diagnostic floor and preserves every other field", async () => {
    const execution = { callTarget: target, approveTarget: target, targetData: "0x" as const, clientData: "0x" as const,
      desc: { srcToken: token, dstToken: target, srcReceivers: [target], srcAmounts: [100n], feeReceivers: [wallet], feeAmounts: [25n],
        dstReceiver: wallet, amount: 100n, minReturnAmount: 900n, flags: 0n, permit: "0x" as const } };
    const data = encodeFunctionData({ abi: kyber, functionName: "swap", args: [execution] });
    const tx = Object.freeze({ to: target, data, value: 0n });
    const call = vi.fn<SwapOutputCallClient["call"]>(async (request) => {
      const decoded = decodeFunctionData({ abi: kyber, data: request.data });
      expect(decoded.args).toEqual([{ ...execution, desc: { ...execution.desc, minReturnAmount: 1n } }]);
      expect(request.account).toBe(wallet);
      expect(request.requestOptions.signal).toBeInstanceOf(AbortSignal);
      return { data: encodeAbiParameters(kyber[0].outputs, [850n, 200_000n]) };
    });
    await expect(observeRefusedKyberOutput({ call }, wallet, tx)).resolves.toBe("850");
    expect(tx.data).toBe(data);
    expect(call).toHaveBeenCalledTimes(1);
    call.mockRejectedValue(new Error("RPC unavailable"));
    await expect(observeRefusedKyberOutput({ call }, wallet, tx)).resolves.toBeNull();
  });

  it("reads V3 multicall output while preserving the approved transaction", async () => {
    const deployment = getUniswapDeployment(8453);
    if (!deployment) throw new Error("Base deployment missing");
    const tx = Object.freeze(buildSwapTx({ deployment,
      route: { version: "v3", path: [getAddress(deployment.weth), token], fees: [500], amountOut: 1000n },
      amountIn: 100n, minAmountOut: 900n, recipient: wallet, deadline: 1_900_000_000n,
      tokenInIsNative: true, tokenOutIsNative: false }));
    const original = tx.data;
    const call = vi.fn<SwapOutputCallClient["call"]>(async (request) => {
      const outer = decodeFunctionData({ abi: v3, data: request.data });
      if (outer.functionName !== "multicall") throw new Error("Expected multicall");
      const swap = decodeFunctionData({ abi: v3, data: outer.args[1][0] });
      if (swap.functionName !== "exactInputSingle") throw new Error("Expected exact input");
      expect(swap.args[0]).toMatchObject({ amountIn: 100n, amountOutMinimum: 1n, recipient: wallet });
      return { data: encodeAbiParameters([{ type: "bytes[]" }], [[encodeAbiParameters(v3[0].outputs, [850n])]]) };
    });
    await expect(observeRefusedUniswapOutput({ call }, wallet, tx)).resolves.toBe("850");
    expect(tx.data).toBe(original);
  });

  it("declines unknown calldata instead of inventing an output", async () => {
    const call = vi.fn<SwapOutputCallClient["call"]>(async () => { throw new Error("RPC unavailable"); });
    await expect(observeRefusedKyberOutput({ call }, wallet, { to: target, data: "0x", value: 0n })).resolves.toBeNull();
  });
});
