import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, zeroAddress, type Hex } from "viem";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { v4PoolId } from "@tools/uniswap/v4-pool.js";
import { V4_SWAP_EVENT } from "@tools/uniswap/v4-settlement.js";
import { TRANSFER_TOPIC0 } from "@tools/uniswap/receipt-decoder.js";
import type { NativeBalanceRpc } from "@tools/uniswap/v4-native-balance.js";
import type { V4PoolKey, V4RouteBinding } from "@tools/uniswap/v4-types.js";

export const nativeWallet = "0x1111111111111111111111111111111111111111";
export const nativeToken = "0x2222222222222222222222222222222222222222";
export const nativeHash = `0x${"99".repeat(32)}` as Hex;
const deployment = getUniswapDeployment(4663);
if (!deployment?.v4) throw new Error("Native balance fixture needs Robinhood v4");
export const nativeDeployment = deployment;
const d = deployment.v4;
export function nativeBinding(hooked = true, zeroForOne = true): V4RouteBinding {
  const poolKey: V4PoolKey = { currency0: zeroAddress, currency1: nativeToken, fee: 0, tickSpacing: 200,
    hooks: hooked ? "0x0000000000000000000000000000000000000040" as const : zeroAddress };
  return { poolKey, poolId: v4PoolId(poolKey), zeroForOne, hookPermissions: hooked ? 64 : 0,
    dynamicFee: false, observedLpFee: 0, universalRouter: d.universalRouter,
    universalRouterVersion: d.universalRouterVersion, permit2: d.permit2 };
}
export function nativeLogs(binding = nativeBinding()) {
  const topic = (a: string): Hex => `0x${a.slice(2).padStart(64, "0")}`;
  const amount0 = binding.zeroForOne ? -100n : 1000n;
  const amount1 = binding.zeroForOne ? 1000n : -100n;
  return [
    { address: d.poolManager, topics: encodeEventTopics({ abi: [V4_SWAP_EVENT], eventName: "Swap",
      args: { id: binding.poolId, sender: d.universalRouter } }).map(t => { if (typeof t !== "string") throw new Error("Concrete topics required"); return t; }),
      data: encodeAbiParameters(parseAbiParameters("int128,int128,uint160,uint128,int24,uint24"), [amount0, amount1, 1n << 96n, 1n, 0, 0]) },
    { address: nativeToken, topics: [TRANSFER_TOPIC0, topic(binding.zeroForOne ? d.poolManager : nativeWallet),
      topic(binding.zeroForOne ? nativeWallet : d.poolManager)], data: encodeAbiParameters([{ type: "uint256" }], [binding.zeroForOne ? 1000n : 100n]) },
  ];
}
export function nativeRpcFixture() {
  const receipt = { transactionHash: nativeHash, blockHash: `0x${"aa".repeat(32)}`, blockNumber: "0x2",
    from: nativeWallet, to: d.universalRouter, status: "0x1", gasUsed: "0xa", effectiveGasPrice: "0x1" };
  const block = { hash: receipt.blockHash, parentHash: `0x${"bb".repeat(32)}`, number: receipt.blockNumber,
    transactions: [{ hash: nativeHash, from: nativeWallet, to: d.universalRouter, value: "0x64", type: "0x2" }] };
  const state = { receipt, block, parentCode: "0x", parentBalance: "0x3e8", minedBalance: "0x384" };
  const rpc: NativeBalanceRpc = { request: async ({ method, params }) => {
    if (method === "eth_getTransactionReceipt") return state.receipt;
    if (method === "eth_getBlockByHash") return state.block;
    if (method === "eth_getCode") return state.parentCode;
    if (method === "eth_call") return "0x0";
    if (method === "eth_getBalance") {
      const tag = params?.[1];
      if (!tag || typeof tag !== "object" || !("blockHash" in tag) || !("requireCanonical" in tag) || tag.requireCanonical !== true) throw new Error("Expected canonical hash-tagged read");
      return tag.blockHash === state.block.parentHash ? state.parentBalance : state.minedBalance;
    }
    throw new Error("Unexpected native evidence RPC method");
  } };
  return { state, rpc, input: { chainId: 4663, txHash: nativeHash, wallet: nativeWallet, router: d.universalRouter } };
}
