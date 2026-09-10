import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbiParameters, zeroAddress, type Address } from "viem";
import { getUniswapDeployment, listUniswapDeployments, UNISWAP_KNOWN_SPENDERS } from "@tools/uniswap/deployments.js";
import { validateUniswapSpender } from "@tools/uniswap/erc20.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import { buildSwapTx } from "@tools/uniswap/execute.js";
import { UNIVERSAL_ROUTER_ABI, V4_ACTIONS_PARAMS, V4_SWAP_PARAMS_211 } from "@tools/uniswap/v4-abis.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { resolveUniswapChainId } from "@tools/uniswap/chains.js";
import { resolveUniswapToken } from "@vex-agent/tools/protocols/uniswap/handlers/swap/token-resolution.js";
import type { V4PoolKey, V4RouteBinding } from "@tools/uniswap/v4-types.js";
import provenance from "./fixtures/v4-deployment-provenance.json" with { type: "json" };

const chainIds = [1, 10, 56, 137, 4663, 8453, 42161];
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required deployment evidence missing");
  return value;
}
describe("verified Uniswap v4 on every direct venue chain", () => {
  it("covers exactly the seven registered chains with code and identity evidence", () => {
    expect(listUniswapDeployments().map(d => d.chainId).sort((a,b) => a-b)).toEqual(chainIds);
    expect(provenance.map(p => p.chainId).sort((a,b) => a-b)).toEqual(chainIds);
  });
  for (const chainId of chainIds) it(`pins chain ${chainId} identities, router domain and both spenders`, () => {
    const deployment = required(getUniswapDeployment(chainId));
    const v4 = required(deployment.v4);
    const row = required(provenance.find(p => p.chainId === chainId));
    const expectedCodeBytes: Record<string, number> = { poolManager: 24009, quoter: chainId === 4663 ? 6118 : 5820, stateView: 3531, positionManager: 23877, router: 24546, permit2: 9152 };
    const contracts = { poolManager: v4.poolManager, quoter: v4.quoter, stateView: v4.stateView, positionManager: v4.positionManager, router: v4.universalRouter, permit2: v4.permit2 };
    for (const [name,address] of Object.entries(contracts)) {
      const fact = required(row.contracts.find(c => c.name === name));
      expect(fact.address.toLowerCase()).toBe(address.toLowerCase());
      expect(fact.codeBytes).toBe(expectedCodeBytes[name]);
      expect(fact.codeHash).toMatch(/^0x[\da-f]{64}$/);
      if (["quoter", "stateView", "positionManager", "router"].includes(name)) expect(fact.poolManager?.toLowerCase()).toBe(v4.poolManager.toLowerCase());
      if (name === "permit2") expect(fact.codeBytes).toBe(9152);
    }
    expect(row.routerDomain).toMatchObject({ name: "UniversalRouter", version: "2", chainId: String(chainId) });
    expect(row.routerDomain.verifyingContract.toLowerCase()).toBe(v4.universalRouter.toLowerCase());
    expect(v4.universalRouterVersion).toBe("2.1.1");
    for (const spender of [v4.permit2, v4.universalRouter]) {
      expect(UNISWAP_KNOWN_SPENDERS.has(spender.toLowerCase())).toBe(true);
      expect(() => validateUniswapSpender(spender, chainId)).not.toThrow();
    }
    if (row.legacyRouter) {
      expect(row.legacyRouter.domainReverted).toBe(true);
      expect(row.legacyRouter.address.toLowerCase()).not.toBe(v4.universalRouter.toLowerCase());
      expect(required(row.contracts.find(c => c.name === "wrappedNative")).address.toLowerCase()).toBe(deployment.weth.toLowerCase());
      const sample = required(row.pools?.[0]);
      const key: V4PoolKey = { currency0: zeroAddress, currency1: required(deployment.connectors[0]), fee: 500, tickSpacing: 10, hooks: zeroAddress };
      expect(sample.key).toEqual([key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
      expect(v4PoolId(key)).toBe(sample.id);
      expect(sample.boundHash).toBe(sample.id);
      expect(BigInt(required(sample.sqrtPriceX96))).toBeGreaterThan(0n);
      expect(BigInt(required(sample.amountOut))).toBeGreaterThan(0n);
    }
  });
});

const RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
describe.each([
  [137, "polygon", "POL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"],
  [56, "bsc", "BNB", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"],
] as const)("native handling on %s", (chainId, slug, symbol, wrapper) => {
  const deployment = required(getUniswapDeployment(chainId));
  const v4 = required(deployment.v4);
  const usd = required(deployment.connectors[0]);
  function route(poolKey: V4PoolKey, zeroForOne: boolean) {
    const binding: V4RouteBinding = { poolId: v4PoolId(poolKey), poolKey, zeroForOne, hookPermissions: 0, dynamicFee: false, observedLpFee: 500, universalRouter: v4.universalRouter, universalRouterVersion: v4.universalRouterVersion, permit2: v4.permit2 };
    return { version: "v4" as const, path: zeroForOne ? [poolKey.currency0,poolKey.currency1] : [poolKey.currency1,poolKey.currency0], v4: binding, amountOut: 1000n };
  }
  const directKey: V4PoolKey = { currency0: zeroAddress, currency1: usd, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const wrappedKey: V4PoolKey = { ...directKey, currency0: BigInt(wrapper) < BigInt(usd) ? getAddress(wrapper) : usd, currency1: BigInt(wrapper) < BigInt(usd) ? usd : getAddress(wrapper) };
  it("resolves native amounts and client metadata as the chain's real currency", async () => {
    expect(resolveUniswapChainId(slug)).toBe(chainId);
    expect(await resolveUniswapToken(deployment, "native")).toEqual({ address: getAddress(wrapper), symbol, decimals: 18, isNative: true });
    expect(getUniswapPublicClient(deployment).chain.nativeCurrency.symbol).toBe(symbol);
    expect(deployment.weth).toBe(wrapper);
  });
  it.each([false,true])("encodes native input with wrapped pool=%s", wrapped => {
    const poolKey = wrapped ? wrappedKey : directKey;
    const input = wrapped ? wrapper : zeroAddress;
    const tx = buildSwapTx({ deployment, route: route(poolKey,poolKey.currency0.toLowerCase() === input.toLowerCase()), amountIn: 100n, minAmountOut: 90n, recipient: RECIPIENT, deadline: 1900000000n, tokenInIsNative: true, tokenOutIsNative: false });
    const outer = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data });
    expect(tx.value).toBe(100n);
    expect(outer.args[0]).toBe(wrapped ? "0x0b100c04" : "0x1004");
    const [,params] = decodeAbiParameters(V4_ACTIONS_PARAMS, required(outer.args[1][wrapped ? 1 : 0]));
    expect(decodeAbiParameters(V4_SWAP_PARAMS_211, required(params[0]))[0].poolKey).toEqual(poolKey);
  });
  it("pulls the deployment's wrapper through Permit2 when unwrapping token input", () => {
    const tx = buildSwapTx({ deployment, route: route(directKey,true), amountIn: 100n, minAmountOut: 90n, recipient: RECIPIENT, deadline: 1900000000n, tokenInIsNative: false, tokenOutIsNative: false });
    const outer = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data });
    expect(tx.value).toBe(0n);
    expect(outer.args[0]).toBe("0x020c100b04");
    expect(decodeAbiParameters(parseAbiParameters("address,address,uint160"), required(outer.args[1][0]))[0]).toBe(getAddress(wrapper));
  });
  it.each([false,true])("takes native output with wrapped pool=%s", wrapped => {
    const poolKey = wrapped ? wrappedKey : directKey;
    const tx = buildSwapTx({ deployment, route: route(poolKey,poolKey.currency0.toLowerCase() === usd.toLowerCase()), amountIn: 100n, minAmountOut: 90n, recipient: RECIPIENT, deadline: 1900000000n, tokenInIsNative: false, tokenOutIsNative: true });
    expect(tx.value).toBe(0n);
    expect(decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: tx.data }).args[0]).toBe(wrapped ? "0x100c04" : "0x1004");
  });
  it.each(["input", "output"] as const)("refuses an Ethereum wrapper on the native %s leg", side => {
    const foreign = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    const poolKey = { ...directKey, currency0: BigInt(foreign) < BigInt(usd) ? foreign : usd, currency1: BigInt(foreign) < BigInt(usd) ? usd : foreign };
    const input = side === "input" ? foreign : usd;
    expect(() => buildSwapTx({ deployment, route: route(poolKey, poolKey.currency0 === input), amountIn: 100n, minAmountOut: 90n, recipient: RECIPIENT, deadline: 1900000000n, tokenInIsNative: side === "input", tokenOutIsNative: side === "output" })).toThrow(/canonical wrapper/);
  });

});
