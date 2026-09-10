/** Two independent on-chain allowances, never a Permit2 signature. */
import { encodeFunctionData, type Address, type Chain, type PublicClient, type Transport } from "viem";
import type { UniswapDeployment } from "./deployments.js";
import type { UniswapRoute } from "./types.js";
import type { BuiltSwapTx } from "./execute.js";
import { readUniswapAllowance, validateUniswapSpender } from "./erc20.js";
import { PERMIT2_ABI } from "./v4-abis.js";
import { assertV4Binding, v4Refusal } from "./v4-pool.js";

export const UNISWAP_EXECUTION_WINDOW_SECONDS = 600;
export function tokenSpender(deployment: UniswapDeployment, route: UniswapRoute, router: Address): Address {
  if (route.version !== "v4") return router;
  assertV4Binding(deployment, route.v4);
  return route.v4.permit2;
}
export interface V4AllowanceState { readonly amount: bigint; readonly expiration: number; readonly nonce: number }
export async function readV4Allowance(client: PublicClient<Transport, Chain>, deployment: UniswapDeployment, token: Address, owner: Address): Promise<V4AllowanceState> {
  if (!deployment.v4) throw v4Refusal("Permit2 deployment missing");
  validateUniswapSpender(deployment.v4.permit2, deployment.chainId);
  validateUniswapSpender(deployment.v4.universalRouter, deployment.chainId);
  const result = await client.readContract({ address: deployment.v4.permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [owner, token, deployment.v4.universalRouter] });
  return { amount: result[0], expiration: result[1], nonce: result[2] };
}
export function needsV4Allowance(state: V4AllowanceState | undefined, amount: bigint, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return !state || state.amount < amount || state.expiration < nowSeconds + UNISWAP_EXECUTION_WINDOW_SECONDS;
}
export function buildV4ApproveTx(deployment: UniswapDeployment, token: Address, amount: bigint, expiration: number): BuiltSwapTx {
  const d = deployment.v4;
  if (!d || amount <= 0n || amount >= 1n << 160n) throw v4Refusal("invalid Permit2 grant");
  validateUniswapSpender(d.permit2, deployment.chainId);
  validateUniswapSpender(d.universalRouter, deployment.chainId);
  return { to: d.permit2, value: 0n, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [token, d.universalRouter, amount, expiration] }) };
}
export async function readSwapAllowances(client: PublicClient<Transport, Chain>, input: {
  readonly deployment: UniswapDeployment; readonly route: UniswapRoute; readonly router: Address;
  readonly token: Address; readonly owner: Address; readonly native: boolean;
}): Promise<{ currentAllowance: bigint; permit2Allowance?: V4AllowanceState }> {
  if (input.native) return { currentAllowance: 0n };
  const spender = tokenSpender(input.deployment, input.route, input.router);
  validateUniswapSpender(spender, input.deployment.chainId);
  const currentAllowance = await readUniswapAllowance(client, input.token, input.owner, spender);
  return { currentAllowance, ...(input.route.version === "v4" ? { permit2Allowance: await readV4Allowance(client, input.deployment, input.token, input.owner) } : {}) };
}
