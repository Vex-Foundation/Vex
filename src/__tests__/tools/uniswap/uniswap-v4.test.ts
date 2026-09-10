import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, encodeErrorResult, parseAbi, parseAbiParameters, zeroAddress, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { buildSwapTx } from "@tools/uniswap/execute.js";
import { verifyFinalUniswapSwapRequest } from "@tools/uniswap/final-request-guard.js";
import { V4_ACTIONS_PARAMS, V4_SWAP_PARAMS_20, V4_SWAP_PARAMS_211, UNIVERSAL_ROUTER_ABI, V4_POSITION_MANAGER_ABI, V4_STATE_VIEW_ABI, V4_QUOTER_ABI, PERMIT2_ABI } from "@tools/uniswap/v4-abis.js";
import { bindV4Pool, assertV4Binding, describeV4Route, v4PoolId } from "@tools/uniswap/v4-pool.js";
import { needsV4Allowance, buildV4ApproveTx } from "@tools/uniswap/v4-allowance.js";
import { validateUniswapSpender } from "@tools/uniswap/erc20.js";
import { classifyUniswapRevertError } from "@tools/uniswap/revert-mapping.js";
import { quoteBestRoute } from "@tools/uniswap/quote.js";
import { quoteBoundV4Pool } from "@tools/uniswap/v4-quote.js";
import type { V4PoolKey, V4RouteBinding } from "@tools/uniswap/v4-types.js";
import type { UniswapRoute } from "@tools/uniswap/types.js";

const pools = vi.hoisted(() => vi.fn());
vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokenPools: pools }));
const deployment = required(getUniswapDeployment(1));
const router = required(deployment.v4);
const recipient = "0x1111111111111111111111111111111111111111";
const key: V4PoolKey = { currency0: zeroAddress, currency1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", fee: 3000, tickSpacing: 10, hooks: zeroAddress };
function binding(k = key): V4RouteBinding {
  return { poolId: v4PoolId(k), poolKey: k, zeroForOne: true, hookPermissions: Number(BigInt(k.hooks) & 16383n), dynamicFee: k.fee === 0x800000, observedLpFee: 3000, universalRouter: router.universalRouter, universalRouterVersion: router.universalRouterVersion, permit2: router.permit2 };
}
function route(b = binding()): Extract<UniswapRoute, { version: "v4" }> {
  return { version: "v4", path: b.zeroForOne ? [b.poolKey.currency0, b.poolKey.currency1] : [b.poolKey.currency1, b.poolKey.currency0], amountOut: 1000n, gasEstimate: 80000n, v4: b };
}
const args = { deployment, route: route(), amountIn: 100n, minAmountOut: 95n, recipient, deadline: 1900000000n, tokenInIsNative: true, tokenOutIsNative: false } as const;
function rpc(k = key, amountOut = 1000n) {
  const requests: string[] = [];
  const client = createPublicClient({ chain: mainnet, transport: custom({ request: async ({ method, params }) => {
    requests.push(method);
    if (method !== "eth_call") throw new Error("unsupported read");
    const tx = (params as [{ to: string; data: Hex }])[0];
    if (tx.to.toLowerCase() === router.positionManager.toLowerCase()) return encodeFunctionResult({ abi: V4_POSITION_MANAGER_ABI, functionName: "poolKeys", result: [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks] });
    if (tx.to.toLowerCase() === router.stateView.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: V4_STATE_VIEW_ABI, data: tx.data });
      return encodeFunctionResult({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", result: [args[0] === v4PoolId(k) ? 1n << 96n : 0n, 0, 0, 3000] });
    }
    if (tx.to.toLowerCase() === router.quoter.toLowerCase()) return encodeFunctionResult({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", result: [amountOut, 80000n] });
    throw new Error("pool unavailable");
  } }) });
  return { client, requests };
}

describe("v4 binding and quote", () => {
  it("binds the observed ROBINHOOD native hooked pool by full keccak", () => {
    expect(v4PoolId({ currency0: zeroAddress, currency1: "0x008Df4b3E857D06c4603Aeb11F267ccD32ce2005", fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" })).toBe("0x7f8271c1a7a6a434f33b0babc15bf2980a0dcb4196848b4f7e789a7fd73a5350");
  });
  it("proves changed hook flags imply a changed key or forged derived flags", () => {
    const b = binding();
    expect(() => assertV4Binding(deployment, { ...b, hookPermissions: 4 })).toThrow(/hook flags/);
    expect(() => assertV4Binding(deployment, { ...b, poolKey: { ...key, hooks: "0x0000000000000000000000000000000000000044" } })).toThrow(/hook flags/);
    expect(describeV4Route(binding({ ...key, hooks: "0x0000000000000000000000000000000000000044" }))).toContain("this hook can change the output after the swap");
  });
  it.each(["hash", "unpopulated", "foreign_pair"])("refuses %s before quoting", async (scenario) => {
    const { client } = rpc(scenario === "unpopulated" ? { ...key, tickSpacing: 0 } : key);
    await expect(bindV4Pool(client, deployment, scenario === "hash" ? `0x${"11".repeat(32)}` : v4PoolId(key), zeroAddress, scenario === "foreign_pair" ? recipient : key.currency1)).rejects.toThrow(/v4 refused/);
  });
  it("calls the non-view quoter with eth_call and preserves the bound path", async () => {
    const { client, requests } = rpc();
    const quoted = await quoteBoundV4Pool(client, deployment, binding(), 100n);
    expect(quoted.amountOut).toBe(1000n);
    expect(quoted.v4.poolId).toBe(v4PoolId(key));
    expect(new Set(requests)).toEqual(new Set(["eth_call"]));
  });
  it("selects a discovered v4 pool when V2 and V3 have no route", async () => {
    pools.mockResolvedValue([{ chainId: "ethereum", dexId: "uniswap", labels: ["v4"], pairAddress: v4PoolId(key), baseToken: { address: key.currency1 }, quoteToken: { address: zeroAddress }, liquidity: { usd: 10000 } }]);
    const { client } = rpc();
    const result = await quoteBestRoute(client, { deployment: { ...deployment, v2: undefined, v3: undefined }, slippageBps: 100, tokenIn: { address: deployment.weth, isNative: true, symbol: "ETH", decimals: 18 }, tokenOut: { address: key.currency1, isNative: false, symbol: "USDC", decimals: 6 }, amountIn: 100n });
    expect(result?.route.version).toBe("v4");
    expect(result?.v4Discovery).toEqual({ indexed: 1, matching: 1, considered: 1, refused: 0, canonical: { probed: 4, initialized: 0, failed: 0 } });
  });
});

describe("v4 exact-input encoding", () => {
  it.each(["2.0", "2.1.1"] as const)("encodes the %s nested tuple and explicit settlement bounds", version => {
    const d = { ...deployment, v4: { ...router, universalRouterVersion: version } };
    const b = { ...binding(), universalRouterVersion: version };
    const tx = buildSwapTx({ ...args, deployment: d, route: route(b) });
    expect(tx.value).toBe(100n);
    const outer = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data });
    expect(outer.args[0]).toBe("0x1004");
    expect(outer.args[2]).toBe(args.deadline);
    const [actions, params] = decodeAbiParameters(V4_ACTIONS_PARAMS, required(outer.args[1][0]));
    expect(actions).toBe("0x060c0f");
    const [swap] = version === "2.0" ? decodeAbiParameters(V4_SWAP_PARAMS_20, required(params[0])) : decodeAbiParameters(V4_SWAP_PARAMS_211, required(params[0]));
    expect(swap).toMatchObject({ poolKey: key, amountIn: 100n, amountOutMinimum: 95n, hookData: "0x" });
    expect(decodeAbiParameters(parseAbiParameters("address,uint256"), required(params[1]))).toEqual([zeroAddress, 100n]);
    expect(decodeAbiParameters(parseAbiParameters("address,uint256"), required(params[2]))).toEqual([key.currency1, 95n]);
    expect(verifyFinalUniswapSwapRequest({ ...tx, gas: 100n, nonce: 1, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }, { builtTransaction: tx, expectedRouter: router.universalRouter, expectedValueRaw: "100", approvedMinOutRaw: "95", universalRouterVersion: version }).ok).toBe(true);
    expect(verifyFinalUniswapSwapRequest({ ...tx, gas: 100n, nonce: 1, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }, { builtTransaction: tx, expectedRouter: router.universalRouter, expectedValueRaw: "100", approvedMinOutRaw: "94", universalRouterVersion: version }).ok).toBe(false);
  });
  it("refuses a deployment version mismatch at build time", () => {
    expect(() => buildSwapTx({ ...args, route: route({ ...binding(), universalRouterVersion: "2.0" }) })).toThrow(/version changed/);
  });
  it.each([
    { inputNative: true, outputNative: false, wrapped: false, reverse: false, commands: "0x1004" },
    { inputNative: true, outputNative: false, wrapped: true, reverse: false, commands: "0x0b100c04" },
    { inputNative: false, outputNative: true, wrapped: false, reverse: true, commands: "0x1004" },
    { inputNative: false, outputNative: true, wrapped: true, reverse: true, commands: "0x100c04" },
    { inputNative: false, outputNative: false, wrapped: false, reverse: false, commands: "0x020c100b04" },
  ])("native transition $commands preserves input and refund ownership", scenario => {
    const k = scenario.wrapped ? { ...key, currency0: key.currency1, currency1: deployment.weth } : key;
    const b = { ...binding(k), zeroForOne: scenario.wrapped ? scenario.reverse : !scenario.reverse };
    const tx = buildSwapTx({ ...args, route: route(b), tokenInIsNative: scenario.inputNative, tokenOutIsNative: scenario.outputNative });
    expect(decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data }).args[0]).toBe(scenario.commands);
    expect(tx.value).toBe(scenario.inputNative ? 100n : 0n);
  });
});

describe("Permit2 grants and typed reverts", () => {
  it("skips sufficient live allowance and renews expired allowance", () => {
    expect(needsV4Allowance({ amount: 100n, expiration: 1600, nonce: 0 }, 100n, 1000)).toBe(false);
    expect(needsV4Allowance({ amount: 100n, expiration: 999, nonce: 0 }, 100n, 1000)).toBe(true);
    expect(needsV4Allowance({ amount: 99n, expiration: 2000, nonce: 0 }, 100n, 1000)).toBe(true);
    const tx = buildV4ApproveTx(deployment, key.currency1, 100n, 1600);
    expect(tx.to).toBe(router.permit2);
    expect(decodeFunctionData({ abi: PERMIT2_ABI, data: tx.data }).args).toEqual([key.currency1, router.universalRouter, 100n, 1600]);
    expect(() => validateUniswapSpender(router.universalRouter, 8453)).toThrow();
    expect(() => validateUniswapSpender(recipient, 1)).toThrow();
  });
  it.each([
    ["UnexpectedRevertBytes", "simulation_reverted"], ["V4TooLittleReceived", "slippage"],
  ])("maps %s without exposing nested hook payloads", (name, code) => {
    const data = name === "UnexpectedRevertBytes"
      ? encodeErrorResult({ abi: V4_QUOTER_ABI, errorName: "UnexpectedRevertBytes", args: ["0x1234"] })
      : encodeErrorResult({ abi: parseAbi(["error V4TooLittleReceived(uint256,uint256)"]), errorName: "V4TooLittleReceived", args: [100n, 90n] });
    expect(classifyUniswapRevertError({ data }).failureCode).toBe(code);
  });
});

// Fixed vectors transcribed from the first-party planner tests, not produced by
// this encoder. Shape variants are independently covered by the router tests.
import vectors from "./fixtures/v4-planner-vectors.json" with { type: "json" };
import { selectUniswapRoute } from "@tools/uniswap/route-ranking.js";
describe("first-party fixed vectors and gas ranking", () => {
  it("matches the SDK 2.0 USDC/WETH single-hop vector byte for byte", () => {
    const vectorKey = { currency0: key.currency1, currency1: deployment.weth, fee: 3000, tickSpacing: 10, hooks: zeroAddress };
    expect(encodeAbiParameters(V4_SWAP_PARAMS_20, [{ poolKey: vectorKey, zeroForOne: true, amountIn: 10n ** 18n, amountOutMinimum: 5n * 10n ** 17n, hookData: "0x" }])).toBe(vectors.single20);
  });
  it.each([
    ["settleOpen", 0n, true], ["settleEight", 8n, true], ["settleRouter", 8n, false],
  ] as const)("matches SDK %s", (name, amount, payerIsUser) => {
    expect(encodeAbiParameters(parseAbiParameters("address,uint256,bool"), ["0x6B175474E89094C44Da98b954EedeAC495271d0F", amount, payerIsUser])).toBe(vectors[name]);
  });
  it.each([["takeOpen", 0n], ["takeEight", 8n]] as const)("matches SDK %s", (name, amount) => {
    expect(encodeAbiParameters(parseAbiParameters("address,address,uint256"), ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount])).toBe(vectors[name]);
  });
  it("a smaller gross output wins when its gas-adjusted output is larger", () => {
    const v3: UniswapRoute = { version: "v3", path: [deployment.weth, key.currency1], fees: [3000], amountOut: 1000n, gasEstimate: 100n };
    const v4 = { ...route(), amountOut: 1010n, gasEstimate: 200n };
    const best = selectUniswapRoute([v3, v4], { gasPriceWei: 1n, outputUnits: 1n, nativeWei: 1n });
    expect(best?.route.version).toBe("v3");
    expect(best?.selectionBasis).toBe("output_net_of_quoted_gas");
    expect(selectUniswapRoute([{ version: "v2", path: v3.path, amountOut: 999n }, v4], null)?.selectionBasis).toBe("gross_output_gas_comparison_unavailable");
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required test fixture or result is missing");
  return value;
}

import { AbiCoder } from "ethers";
it("matches an independent ABI coder for the 2.1.1 nested single-hop tuple", () => {
  const swap = { poolKey: key, zeroForOne: true, amountIn: 100n, amountOutMinimum: 95n, minHopPriceX36: 0n, hookData: "0x" } as const;
  const independent = AbiCoder.defaultAbiCoder().encode([
    "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)",
  ], [swap]);
  expect(encodeAbiParameters(V4_SWAP_PARAMS_211, [swap])).toBe(independent);
});
