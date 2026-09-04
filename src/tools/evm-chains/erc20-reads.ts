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

import type { Address } from "viem";

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

/**
 * The only client capability these primitives need, stated as a NARROW
 * signature rather than `Pick<PublicClient, "readContract">`.
 *
 * viem's own `readContract` is a generic whose return type is derived from the
 * ABI and function name it is handed. That inference is a gift at a call site
 * and a wall at a seam: no concrete function is assignable to it, so every test
 * double for this client had to be cast, and a cast is exactly the hole rule 04
 * says not to open on a path that gates money. The narrow form takes the
 * parameters these primitives actually send and returns `unknown`, which a real
 * viem client satisfies and a plain fake satisfies too.
 *
 * `unknown` is not a loss: a contract's answer is an EXTERNAL value, and each
 * reader below parses it before returning. That is the boundary parse rule 04
 * asks for, previously supplied by inference over an ABI the node never
 * promised to honour.
 */
export interface Erc20ReadClient {
  readContract(parameters: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: "balanceOf" | "decimals" | "symbol";
    readonly args?: readonly unknown[];
    readonly blockTag?: BalanceBlockTag;
    readonly requestOptions?: { readonly signal: AbortSignal };
  }): Promise<unknown>;
}

/**
 * A uint256 answer, parsed. A contract that answers something else has not
 * answered this question, and the caller's failure policy applies.
 */
function asUint256(value: unknown, call: string): bigint {
  if (typeof value === "bigint") return value;
  throw new Error(`ERC-20 ${call} did not return a uint256`);
}

/**
 * The block a balance is read at.
 *
 * `pending` is the only tag that subtracts the wallet's own in-flight
 * transactions, which is why it is the tag a SPEND is authorized from
 * (contract C2.4, `quote-authority/spendability-contract.ts`). `latest` stays
 * in the union because a `latest` figure is genuine evidence for a person
 * reading a refusal, never because it may authorize one.
 */
export type BalanceBlockTag = "pending" | "latest";

/** Caller-owned cancellation for one direct contract read. */
export interface Erc20ReadOptions {
  readonly signal?: AbortSignal;
  /**
   * The block to read at. OMITTED BY DEFAULT, and that is deliberate: every
   * existing consumer of these primitives keeps viem's own default, so adding
   * this parameter changes nothing on the wire for any of them. A spendability
   * read passes `pending` explicitly.
   */
  readonly blockTag?: BalanceBlockTag;
}

/**
 * Add viem's request-level signal and the explicit block tag without changing
 * the public contract-read parameters. `readContract` forwards unknown call
 * parameters to `call`, whose `requestOptions.signal` is the cancellation seam
 * in the installed viem and whose `blockTag` selects the state that is read.
 */
function requestOptions(options: Erc20ReadOptions): {
  readonly requestOptions?: { readonly signal: AbortSignal };
  readonly blockTag?: BalanceBlockTag;
} {
  return {
    ...(options.signal === undefined ? {} : { requestOptions: { signal: options.signal } }),
    ...(options.blockTag === undefined ? {} : { blockTag: options.blockTag }),
  };
}

/** Raw `balanceOf(owner)`, in the token's smallest unit. Throws on failure. */
export async function readErc20Balance(
  client: Erc20ReadClient,
  token: Address,
  owner: Address,
  options: Erc20ReadOptions = {},
): Promise<bigint> {
  return asUint256(
    await client.readContract({
      address: token,
      abi: ERC20_READ_ABI,
      functionName: "balanceOf",
      args: [owner],
      ...requestOptions(options),
    }),
    "balanceOf",
  );
}

/** The only client capability a native-balance read needs, narrowly stated. */
export interface NativeReadClient {
  getBalance(parameters: {
    readonly address: Address;
    readonly blockTag?: BalanceBlockTag;
  }): Promise<bigint>;
}

/**
 * What a native read can be told. NO cancellation seam, and that absence is
 * measured rather than forgotten: viem 2.54.3's `getBalance` reaches
 * `client.request` directly with no per-request options
 * (`viem/_esm/actions/public/getBalance.js`), so an `AbortSignal` passed here
 * would be silently ignored - and a cancellation nobody honours is worse than
 * one nobody offered. The read is bounded by the transport timeout the client
 * was built with.
 */
export interface NativeReadOptions {
  readonly blockTag?: BalanceBlockTag;
}

/**
 * The chain's NATIVE balance for one address, in wei. Throws on failure.
 *
 * The sibling of `readErc20Balance` and deliberately its twin in shape: the
 * native leg of a swap asks the same question about the same wallet at the same
 * block, and a caller forced to switch idioms between the two is one step from
 * reading them at different blocks. It reads the ACCOUNT balance and is
 * structurally incapable of seeing a token account (contract C4.3).
 */
export async function readNativeBalance(
  client: NativeReadClient,
  owner: Address,
  options: NativeReadOptions = {},
): Promise<bigint> {
  return await client.getBalance(
    options.blockTag === undefined
      ? { address: owner }
      : { address: owner, blockTag: options.blockTag },
  );
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
  if (typeof decimals === "number") return decimals;
  if (typeof decimals === "bigint") return Number(decimals);
  throw new Error("ERC-20 decimals() did not return a number");
}

/** `symbol()` exactly as the token contract returns it. Throws on failure. */
export async function readErc20Symbol(
  client: Erc20ReadClient,
  token: Address,
  options: Erc20ReadOptions = {},
): Promise<string> {
  const symbol = await client.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: "symbol",
    ...requestOptions(options),
  });
  if (typeof symbol !== "string") throw new Error("ERC-20 symbol() did not return a string");
  return symbol;
}
