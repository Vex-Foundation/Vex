import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, getAddress, zeroAddress, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { canonicalV4PoolKeys, V4_CANONICAL_FEE_TIERS } from "@tools/uniswap/v4-canonical-pools.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { V4_POSITION_MANAGER_ABI, V4_STATE_VIEW_ABI, V4_QUOTER_ABI } from "@tools/uniswap/v4-abis.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { quoteV4Candidates } from "@tools/uniswap/v4-quote.js";
import { selectUniswapRoute } from "@tools/uniswap/route-ranking.js";
import type { V4PoolKey } from "@tools/uniswap/v4-types.js";
import type { UniswapRoute } from "@tools/uniswap/types.js";

const readTokenPools = vi.hoisted(() => vi.fn());
vi.mock("@tools/dexscreener/price-read.js", () => ({ readTokenPools }));
const deployment = getUniswapDeployment(1);
if (!deployment?.v4) throw new Error("missing v4 fixture deployment");
const d = deployment.v4;
const native = { address: deployment.weth, symbol: "ETH", decimals: 18, isNative: true };
const token = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, isNative: false } as const;
const keys = canonicalV4PoolKeys(native, token);
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("missing fixture"); return value; }
const medium = required(keys[1]);
function provider(initialized: readonly V4PoolKey[], options: { unbound?: boolean; stateUnavailable?: boolean } = {}) {
  const quoted: Hex[] = [];
  const stateReads: Hex[] = [];
  const client = createPublicClient({ chain: mainnet, transport: custom({ request: async ({ method, params }) => {
    if (method !== "eth_call") throw new Error("only read-only contract calls are permitted");
    const tx = (params as [{ to: string; data: Hex }])[0];
    if (tx.to.toLowerCase() === d.stateView.toLowerCase()) {
      const call = decodeFunctionData({ abi: V4_STATE_VIEW_ABI, data: tx.data });
      stateReads.push(call.args[0]);
      if (options.stateUnavailable) throw new Error("state unavailable");
      const k = initialized.find(key => v4PoolId(key) === call.args[0]);
      return encodeFunctionResult({ abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", result: [k ? 1n << 96n : 0n, 0, 0, k?.fee ?? 0] });
    }
    if (tx.to.toLowerCase() === d.positionManager.toLowerCase()) {
      const call = decodeFunctionData({ abi: V4_POSITION_MANAGER_ABI, data: tx.data });
      const k = options.unbound ? undefined : initialized.find(key => v4PoolId(key).slice(0,52) === call.args[0]);
      return encodeFunctionResult({ abi: V4_POSITION_MANAGER_ABI, functionName: "poolKeys", result: k
        ? [k.currency0,k.currency1,k.fee,k.tickSpacing,k.hooks] : [zeroAddress,zeroAddress,0,0,zeroAddress] });
    }
    if (tx.to.toLowerCase() === d.quoter.toLowerCase()) {
      const call = decodeFunctionData({ abi: V4_QUOTER_ABI, data: tx.data });
      const id = v4PoolId(call.args[0].poolKey);
      quoted.push(id);
      return encodeFunctionResult({ abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", result: [1000n,40000n] });
    }
    throw new Error("unexpected contract");
  } }, { retryCount: 0 }) });
  return { client, quoted, stateReads };
}
function pair(key: V4PoolKey) {
  return { chainId: "ethereum", dexId: "uniswap", labels: ["v4"], pairAddress: v4PoolId(key), baseToken: { address: key.currency1 }, quoteToken: { address: key.currency0 }, liquidity: { usd: 10000 } };
}
beforeEach(() => { readTokenPools.mockReset(); readTokenPools.mockResolvedValue([]); });

describe("canonical hookless v4 discovery", () => {
  it("enumerates exactly the four fee/spacing pairs, sorts currencies and uses zero for native", () => {
    expect(V4_CANONICAL_FEE_TIERS).toEqual([{ fee:100,tickSpacing:1 },{ fee:500,tickSpacing:10 },{ fee:3000,tickSpacing:60 },{ fee:10000,tickSpacing:200 }]);
    expect(keys.map(k => [k.currency0,k.currency1,k.hooks])).toEqual(Array.from({ length:4 }, () => [zeroAddress,token.address,zeroAddress]));
    expect(canonicalV4PoolKeys(token,native)).toEqual(keys);
    expect(canonicalV4PoolKeys({ ...native, isNative:false },token).every(k => k.currency0 !== zeroAddress)).toBe(true);
    expect(canonicalV4PoolKeys(token,token)).toEqual([]);
  });
  it.each(["empty", "unavailable"] as const)("quotes initialized canonical pools when DexScreener is %s", async state => {
    if (state === "unavailable") readTokenPools.mockRejectedValue(new Error("DexScreener unavailable"));
    const p = provider(keys);
    const result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(result.routes).toHaveLength(4);
    expect(new Set(p.quoted)).toEqual(new Set(keys.map(v4PoolId)));
    expect(result.discovery.canonical).toEqual({ probed:4, initialized:4, failed:0 });
    expect(result.discovery.considered).toBe(4);
    expect(result.discovery.dexscreenerUnavailable).toBe(state === "unavailable" ? true : undefined);
  });
  it("skips uninitialized keys before calling PositionManager or the quoter", async () => {
    const p = provider([]);
    const result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(p.stateReads).toEqual(keys.map(v4PoolId));
    expect(p.quoted).toEqual([]);
    expect(result.discovery).toMatchObject({ considered:0, refused:0, canonical:{probed:4,initialized:0,failed:0} });
  });
  it("deduplicates a pool indexed by DexScreener and found by a canonical key", async () => {
    readTokenPools.mockResolvedValue([pair(medium),pair(medium)]);
    const p = provider([medium]);
    const result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(p.quoted).toEqual([v4PoolId(medium)]);
    expect(result.discovery).toMatchObject({ considered:1, matching:1, canonical:{probed:3,initialized:0,failed:0} });
  });
  it("still refuses an initialized pool with no bound PositionManager key", async () => {
    const p = provider([medium], { unbound:true });
    const result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(p.quoted).toEqual([]);
    expect(result.discovery).toMatchObject({ considered:1, refused:1, canonical:{probed:4,initialized:1,failed:0} });
  });
  it("distinguishes unavailable state reads from absent pools", async () => {
    const p = provider([], { stateUnavailable:true });
    const result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(result.discovery.canonical).toEqual({ probed:4, initialized:0, failed:4 });
    expect(p.quoted).toEqual([]);
  });
  it("discovers hooks only from DexScreener and keeps canonical discovery alongside them", async () => {
    const hooked = { ...medium, hooks:"0x0000000000000000000000000000000000000044" } as const;
    const p = provider([medium,hooked]);
    let result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(result.routes).toHaveLength(1);
    expect(p.quoted).not.toContain(v4PoolId(hooked));
    readTokenPools.mockResolvedValue([pair(hooked)]);
    result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(result.routes).toHaveLength(2);
    expect(p.quoted).toContain(v4PoolId(hooked));
  });
  it("keeps all four canonical probes beside the three deepest DexScreener candidates", async () => {
    const hooked = Array.from({ length:4 }, (_,index) => ({ ...medium,
      hooks: getAddress(`0x${BigInt(68 + (index + 1) * 16384).toString(16).padStart(40,"0")}`),
    }));
    readTokenPools.mockResolvedValue(hooked.map((key,index) => ({ ...pair(key), liquidity:{ usd:40000-index*10000 } })));
    const p = provider([...keys,...hooked]);
    const result = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    expect(result.routes).toHaveLength(7);
    expect(new Set(p.quoted).size).toBe(7);
    expect(p.quoted).not.toContain(v4PoolId(required(hooked[3])));
    expect(result.discovery).toMatchObject({ matching:4, considered:7, canonical:{probed:4,initialized:4,failed:0} });
  });
  it("lets a discovered v4 route win when gas savings exceed its smaller gross output", async () => {
    const p = provider([medium]);
    const { routes } = await quoteV4Candidates(p.client, { deployment, tokenIn:native, tokenOut:token, amountIn:100n });
    const v3: UniswapRoute = { version:"v3", path:[native.address,token.address], amountOut:1100n, gasEstimate:70000n, fees:[500] };
    const selected = selectUniswapRoute([v3,...routes], { gasPriceWei:1n, outputUnits:1n, nativeWei:100n });
    expect(selected?.route.version).toBe("v4");
    expect(selected?.selectionBasis).toBe("output_net_of_quoted_gas");
  });
});
