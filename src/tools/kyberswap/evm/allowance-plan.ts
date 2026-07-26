/**
 * KyberSwap ERC-20 allowance PLANNING — read-only decision, no broadcast.
 *
 * Agent Scan's staged-broadcast contract (plan §11.1) requires every planned
 * broadcast (an allowance reset, an allowance grant, the swap itself) to have
 * its own `agent_activity` event row created BEFORE anything is signed. That
 * means the execute handler must know, from a plain on-chain READ, whether a
 * reset and/or an approve will be needed — this module owns that read-only
 * decision. The actual reset/approve TRANSACTIONS are then sent through the
 * same staged sign→persist→broadcast primitive (`staged-broadcast.ts`) as the
 * swap itself, via `buildApproveCalldata` below.
 *
 * Same exact-amount doctrine as the allowance logic this replaces
 * (`ensureKyberAllowance`, Etap 4): a short allowance is topped up to EXACTLY
 * `requiredAmount`, never an unlimited `maxUint256`. USDT-style tokens that
 * reject a non-zero→non-zero approve need a reset-to-0 first.
 */

import { encodeFunctionData, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";

import { ERC20_ABI } from "./config.js";

export interface KyberAllowancePlan {
  readonly currentAllowance: bigint;
  readonly needsReset: boolean;
  readonly needsApprove: boolean;
}

/**
 * Read the current on-chain allowance and decide which staged approve
 * transactions (reset, approve) are needed to reach `requiredAmount`. Pure
 * read — never sends a transaction.
 */
export async function planKyberAllowance(
  publicClient: PublicClient<Transport, Chain>,
  token: Address,
  owner: Address,
  spender: Address,
  requiredAmount: bigint,
): Promise<KyberAllowancePlan> {
  const currentAllowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });

  if (currentAllowance >= requiredAmount) {
    return { currentAllowance, needsReset: false, needsApprove: false };
  }

  return {
    currentAllowance,
    // USDT-style: a non-zero allowance must be reset to 0 before a new approve.
    needsReset: currentAllowance > 0n,
    needsApprove: true,
  };
}

/** Encode an ERC-20 `approve(spender, amount)` call for the staged-broadcast primitive. */
export function buildApproveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
  });
}
