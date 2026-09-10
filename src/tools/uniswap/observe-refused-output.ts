import { decodeFunctionData, decodeFunctionResult, decodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { UNISWAP_V2_ROUTER_ABI as v2, UNISWAP_V3_SWAP_ROUTER_02_ABI as v3 } from "./abis.js";
import type { SwapOutputCallClient } from "@tools/evm-chains/swap-output-shortfall.js";

/** Read-only post-refusal observation. The diagnostic calldata cannot leave this function. */
export async function observeRefusedUniswapOutput(client: SwapOutputCallClient, account: Address,
  tx: { readonly to: Address; readonly data: Hex; readonly value: bigint }): Promise<string | null> {
  try {
    const decoded = decodeFunctionData({ abi: [...v2, ...v3], data: tx.data });
    const call = async (data: Hex) => client.call({ account, to: tx.to, data, value: tx.value,
      requestOptions: { signal: AbortSignal.timeout(3000) } });
    if (decoded.functionName === "swapExactETHForTokens") {
      const result = await call(encodeFunctionData({ abi: v2, functionName: decoded.functionName,
        args: [1n, decoded.args[1], decoded.args[2], decoded.args[3]] }));
      if (result.data === undefined) return null;
      const amounts = decodeFunctionResult({ abi: v2, functionName: decoded.functionName, data: result.data });
      return amounts[amounts.length - 1]?.toString() ?? null;
    }
    // V2 fee-on-transfer variants return no amount. Do not invent one.
    if (decoded.functionName !== "multicall") return null;
    const [deadline, calls] = decoded.args;
    if (calls.length < 1 || calls.length > 2) return null;
    const first = decodeFunctionData({ abi: v3, data: calls[0] });
    if (first.functionName !== "exactInputSingle" && first.functionName !== "exactInput") return null;
    const body: Hex[] = [first.functionName === "exactInputSingle"
      ? encodeFunctionData({ abi: v3, functionName: first.functionName, args: [{ ...first.args[0], amountOutMinimum: 1n }] })
      : encodeFunctionData({ abi: v3, functionName: first.functionName, args: [{ ...first.args[0], amountOutMinimum: 1n }] })];
    if (calls[1] !== undefined) {
      const unwrap = decodeFunctionData({ abi: v3, data: calls[1] });
      if (unwrap.functionName !== "unwrapWETH9") return null;
      body.push(encodeFunctionData({ abi: v3, functionName: "unwrapWETH9", args: [1n, unwrap.args[1]] }));
    }
    const result = await call(encodeFunctionData({ abi: v3, functionName: "multicall", args: [deadline, body] }));
    if (result.data === undefined) return null;
    const returned = decodeFunctionResult({ abi: v3, functionName: "multicall", data: result.data });
    if (returned[0] === undefined) return null;
    return decodeAbiParameters(v3[0].outputs, returned[0])[0].toString();
  } catch { return null; }
}
