import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, encodeErrorResult, parseAbi, toFunctionSelector, type Hex } from "viem";
import evidence from "./fixtures/v4-execution-estimates-turn5.json" with { type: "json" };
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { buildSwapTx } from "@tools/uniswap/execute.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { v4RouteBindingSchema } from "@tools/uniswap/v4-types.js";
import { classifyUniswapRevertError } from "@tools/uniswap/revert-mapping.js";
import { VexError, ErrorCodes } from "../../../errors.js";

const floorData = "0x8b063d7300000000000000000000000000000000000000000000000000000000000788b8000000000000000000000000000000000000000000000000000000000003c45c";

describe("real v4 native estimate evidence", () => {
  it.each(evidence.positive)("rebuilds the unchanged, successful chain $chainId calldata byte for byte", row => {
    const deployment = getUniswapDeployment(row.chainId);
    if (!deployment) throw new Error("missing recorded deployment");
    const binding = v4RouteBindingSchema.parse({ ...row.binding, poolId: row.poolId, poolKey: row.poolKey });
    expect(v4PoolId(binding.poolKey)).toBe(row.poolId);
    const tx = buildSwapTx({ deployment, route: { version: "v4", path: [binding.poolKey.currency0, binding.poolKey.currency1],
      v4: binding, amountOut: BigInt(row.quotedAmountOutRaw) }, amountIn: BigInt(row.amountInRaw),
      minAmountOut: BigInt(row.minAmountOutRaw), recipient: row.request.from as Hex, deadline: BigInt(row.deadline),
      tokenInIsNative: true, tokenOutIsNative: false });
    expect(tx).toEqual({ to: row.request.to, data: row.request.data, value: BigInt(row.request.value) });
    expect(row.pinnedResults.find(r => r.method === "eth_call")?.result).toBe("0x");
    const gas = row.pinnedResults.find(r => r.method === "eth_estimateGas")?.result;
    if (!gas) throw new Error("missing live estimate");
    expect(BigInt(gas)).toBeGreaterThan(0n);
  });

  it("decodes the controlled Base floor refusal using the reference signature selector", () => {
    expect(toFunctionSelector("V4TooLittleReceived(uint256,uint256)")).toBe("0x8b063d73");
    const captured = evidence.negativeControls[0]?.results[0]?.error?.[0];
    if (!captured || !("data" in captured)) throw new Error("missing captured revert bytes");
    expect(captured.data).toBe(floorData);
    const result = classifyUniswapRevertError({ cause: { code: 3, data: floorData } });
    expect(result).toMatchObject({ failureCode: "slippage", onChainRevert: true,
      revert: { errorName: "V4TooLittleReceived", selector: "0x8b063d73", data: floorData } });
    expect(result.failureReason).toContain("V4TooLittleReceived(493752, 246876)");
  });

  it("retains the full outer wrapper and decodes its nested floor error", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error ExecutionFailed(uint256 commandIndex,bytes message)"]),
      errorName: "ExecutionFailed", args: [0n, floorData] });
    expect(classifyUniswapRevertError({ cause: { code: 3, data } })).toMatchObject({ failureCode: "slippage",
      revert: { errorName: "V4TooLittleReceived", selector: "0x8b063d73", data: floorData, outerData: data } });
  });

  it("decodes a core WrappedError without losing its complete wrapper bytes", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error WrappedError(address target,bytes4 selector,bytes reason,bytes details)"]),
      errorName: "WrappedError", args: ["0x0000000000000000000000000000000000000044", "0x12345678", floorData, "0x"] });
    expect(classifyUniswapRevertError({ code: 3, data })).toMatchObject({ failureCode: "slippage",
      revert: { data: floorData, outerData: data, errorName: "V4TooLittleReceived" } });
  });

  it.each([
    ["V4TooLittleReceivedPerHop", "uint256,uint256,uint256", [0n, 100n, 90n], "slippage"],
    ["V4TooLittleReceivedPerHopSingle", "uint256,uint256", [100n, 90n], "slippage"],
    ["V4TooMuchRequestedPerHop", "uint256,uint256,uint256", [0n, 100n, 110n], "slippage"],
    ["V4TooMuchRequestedPerHopSingle", "uint256,uint256", [100n, 110n], "slippage"],
    ["PoolNotInitialized", "", [], "route_not_found"],
    ["CurrencyNotSettled", "", [], "simulation_reverted"],
    ["NonzeroNativeValue", "", [], "simulation_reverted"],
  ] as const)("classifies the source-declared %s error", (name, parameters, args, failureCode) => {
    const abi = parseAbi([`error ${name}(${parameters})`]);
    const data = encodeErrorResult({ abi, errorName: name, args });
    const result = classifyUniswapRevertError({ code: 3, data });
    expect(result).toMatchObject({ failureCode, onChainRevert: true,
      revert: { data, selector: toFunctionSelector(`${name}(${parameters})`), errorName: name } });
    if (failureCode !== "slippage") expect(result.remedy).toMatch(/do not retry/i);
  });

  it("reads viem 2.54.3's raw contract revert and preserves unknown data below its node wrapper", () => {
    const error = new ContractFunctionRevertedError({ abi: parseAbi(["error V4TooLittleReceived(uint256,uint256)"]),
      data: floorData, functionName: "execute" });
    expect(classifyUniswapRevertError(error).revert).toEqual({ errorName: "V4TooLittleReceived", selector: "0x8b063d73", data: floorData });
    const unknown = new ExecutionRevertedError({ cause: new BaseError("RPC refused", {
      cause: Object.assign(new Error("RPC refusal"), { code: -32000, data: "0x12345678" }),
    }) });
    expect(classifyUniswapRevertError(unknown)).toMatchObject({ failureCode: "simulation_reverted", revert: { data: "0x12345678" } });
  });

  it("retains unknown RPC revert bytes without guessing a remedy or classifying request calldata", () => {
    const data = `0x12345678${"ab".repeat(300)}`;
    expect(classifyUniswapRevertError({ cause: { code: 3, data } })).toMatchObject({
      failureCode: "simulation_reverted", revert: { selector: "0x12345678", data }, onChainRevert: true });
    expect(classifyUniswapRevertError({ request: { data } }).revert).toBeUndefined();
    expect(classifyUniswapRevertError({ data }).revert).toBeUndefined();
  });

  it("keeps the actual local VexError reason and hint without asserting a chain revert", () => {
    const result = classifyUniswapRevertError(new VexError(ErrorCodes.SWAP_FAILED,
      "Transaction preparation did not resolve a nonce", "Check the pinned RPC nonce response before retrying"));
    expect(result.failureReason).toBe("Transaction preparation did not resolve a nonce");
    expect(result.remedy).toBe("Check the pinned RPC nonce response before retrying");
    expect(result.onChainRevert).toBe(false);
    expect(result.revert).toBeUndefined();
  });

  it("keeps raw ABI Error(string) on the existing V2/V3 reason table", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error Error(string message)"]), errorName: "Error", args: ["Too little received"] });
    expect(classifyUniswapRevertError({ code: 3, data })).toMatchObject({ failureCode: "slippage",
      failureReason: "Too little received", revert: { selector: "0x08c379a0", errorName: "Error", data } });
  });
});
