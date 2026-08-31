/**
 * The single-token ERC-20 read primitives shared by every EVM path that needs
 * to ask ONE contract a direct question: the router debit guard
 * (`erc20-balance-guard.ts`), post-buy delivery verification
 * (`post-buy-delivery.ts`), and the agent-facing `ChainRead` erc20_balance
 * action.
 *
 * This module OWNS the ERC-20 read ABI. It used to live in `balances.ts`, whose
 * job is the Multicall3 batch scan; the guard imported the scanner's ABI, which
 * inverted the ownership between a shared primitive and one of its consumers.
 * The batch scan keeps its own Multicall3 shape and imports the ABI from here.
 *
 * Every function here THROWS on an RPC or contract failure. Failure policy is
 * the caller's: the guard propagates, the delivery check fails soft, the scan
 * records a per-token read failure.
 */

import type { Address, PublicClient } from "viem";

export const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

/** The only client capability these primitives need. */
export type Erc20ReadClient = Pick<PublicClient, "readContract">;

/** Caller-owned cancellation for one direct contract read. */
export interface Erc20ReadOptions {
  readonly signal?: AbortSignal;
}

/**
 * Add viem's request-level signal without changing the public contract-read
 * parameters. `readContract` forwards unknown call parameters to `call`, whose
 * `requestOptions.signal` is the cancellation seam in the installed viem.
 */
function requestOptions(options: Erc20ReadOptions): {
  readonly requestOptions?: { readonly signal: AbortSignal };
} {
  return options.signal === undefined
    ? {}
    : { requestOptions: { signal: options.signal } };
}

/** Raw `balanceOf(owner)`, in the token's smallest unit. Throws on failure. */
export async function readErc20Balance(
  client: Erc20ReadClient,
  token: Address,
  owner: Address,
  options: Erc20ReadOptions = {},
): Promise<bigint> {
  return await client.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: "balanceOf",
    args: [owner],
    ...requestOptions(options),
  });
}

/**
 * `decimals()`. Throws on failure, including for a token that does not
 * implement the optional call: a raw amount whose scale is unknown must never
 * be presented as a human amount.
 */
export async function readErc20Decimals(
  client: Erc20ReadClient,
  token: Address,
  options: Erc20ReadOptions = {},
): Promise<number> {
  const decimals = await client.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: "decimals",
    ...requestOptions(options),
  });
  return Number(decimals);
}

/** `symbol()` exactly as the token contract returns it. Throws on failure. */
export async function readErc20Symbol(
  client: Erc20ReadClient,
  token: Address,
  options: Erc20ReadOptions = {},
): Promise<string> {
  return await client.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: "symbol",
    ...requestOptions(options),
  });
}
