import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex, type PublicClient, type Transport, type Chain } from "viem";
import { VexError, ErrorCodes } from "../../errors.js";
import type { UniswapDeployment } from "./deployments.js";
import { V4_POOL_KEY_PARAMS, V4_POSITION_MANAGER_ABI, V4_STATE_VIEW_ABI } from "./v4-abis.js";
import { v4PoolKeySchema, v4RouteBindingSchema, type V4PoolKey, type V4RouteBinding } from "./v4-types.js";

export function v4PoolId(key: V4PoolKey): Hex {
  return keccak256(encodeAbiParameters(V4_POOL_KEY_PARAMS, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}
export class UniswapV4Refusal extends VexError {
  constructor(reason: string) {
    super(ErrorCodes.SWAP_FAILED, `Uniswap v4 refused: ${reason}.`, "Request a fresh uniswap__swap_quote. Nothing was changed to fit the prior approval.");
  }
}
export function v4Refusal(reason: string): UniswapV4Refusal {
  return new UniswapV4Refusal(reason);
}
export function assertV4Binding(deployment: UniswapDeployment, bound: V4RouteBinding): void {
  if (!v4RouteBindingSchema.safeParse(bound).success) throw v4Refusal("unreadable v4 binding");
  const d = deployment.v4;
  if (!d || d.universalRouterVersion !== bound.universalRouterVersion
    || d.universalRouter.toLowerCase() !== bound.universalRouter.toLowerCase()
    || d.permit2.toLowerCase() !== bound.permit2.toLowerCase()) throw v4Refusal("router deployment or version changed");
  if (v4PoolId(bound.poolKey).toLowerCase() !== bound.poolId.toLowerCase()
    || !v4PoolKeySchema.safeParse(bound.poolKey).success
    || BigInt(bound.poolKey.currency0) >= BigInt(bound.poolKey.currency1)
    || (bound.poolKey.fee > 1000000 && bound.poolKey.fee !== 0x800000)
    || bound.hookPermissions !== Number(BigInt(bound.poolKey.hooks) & 0x3fffn)
    || bound.dynamicFee !== (bound.poolKey.fee === 0x800000)) throw v4Refusal("PoolKey or derived hook flags do not match the pool ID");
}
export async function bindV4Pool(
  client: PublicClient<Transport, Chain>, deployment: UniswapDeployment,
  poolId: Hex, currencyIn: Address, currencyOut: Address,
): Promise<V4RouteBinding> {
  if (!deployment.v4 || !/^0x[\da-fA-F]{64}$/.test(poolId)) throw v4Refusal("missing deployment or invalid pool ID");
  // Solidity bytes25(poolId) keeps the leading 25 bytes. This is field extraction.
  const tuple = await client.readContract({ address: deployment.v4.positionManager, abi: V4_POSITION_MANAGER_ABI, functionName: "poolKeys", args: [poolId.slice(0, 52) as Hex] });
  const parsed = v4PoolKeySchema.safeParse({ currency0: tuple[0], currency1: tuple[1], fee: tuple[2], tickSpacing: tuple[3], hooks: tuple[4] });
  if (!parsed.success) throw v4Refusal("unpopulated or invalid PoolKey");
  const key = parsed.data;
  const zeroForOne = currencyIn.toLowerCase() === key.currency0.toLowerCase();
  if ((zeroForOne ? key.currency1 : key.currency0).toLowerCase() !== currencyOut.toLowerCase()
    || (zeroForOne ? key.currency0 : key.currency1).toLowerCase() !== currencyIn.toLowerCase()) throw v4Refusal("pool currencies do not match the requested pair");
  const slot = await client.readContract({ address: deployment.v4.stateView, abi: V4_STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] });
  if (slot[0] === 0n) throw v4Refusal("pool is not initialized");
  const binding: V4RouteBinding = {
    poolId, poolKey: key, zeroForOne, hookPermissions: Number(BigInt(key.hooks) & 0x3fffn),
    dynamicFee: key.fee === 0x800000, observedLpFee: slot[3],
    universalRouter: deployment.v4.universalRouter, universalRouterVersion: deployment.v4.universalRouterVersion, permit2: deployment.v4.permit2,
  };
  assertV4Binding(deployment, binding);
  return binding;
}
export function describeV4Route(bound: V4RouteBinding): string {
  const key = bound.poolKey;
  const hook = key.hooks === zeroAddress ? "no hook" : `hook ${key.hooks}${(bound.hookPermissions & 12) !== 0 ? " : this hook can change the output after the swap" : ""}`;
  return `Uniswap v4 pool ${bound.poolId}, fee ${bound.dynamicFee ? `dynamic, currently ${bound.observedLpFee}` : key.fee} (millionths), tick spacing ${key.tickSpacing}, ${hook}`;
}
export function v4QuoteWarning(bound: V4RouteBinding): string {
  return bound.poolKey.hooks === zeroAddress
    ? "The quote is an estimate; amountOutMinimum is the only output floor."
    : "The quote is not a guarantee for this hooked pool: the hook sees the quoter as sender during quoting and the router during execution. amountOutMinimum is the only output floor.";
}
