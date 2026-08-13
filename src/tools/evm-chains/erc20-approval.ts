/**
 * Reading an ERC-20 `approve(spender, amount)` back out of calldata.
 *
 * A leaf with one job, shared rather than re-implemented per venue: the Khalani
 * planner classifies an approval leg by its amount (zero is a RESET), and both
 * bridge confirm sites need the SPENDER - the address a deposit is authorized to
 * pull the input token to, which is one of the recipients a deposit's executed
 * amount may be proven against.
 *
 * Calldata is provider-supplied and untrusted: anything that is not a decodable
 * `approve` returns `null` rather than throwing, so a caller can fail safe.
 */

import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";

const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * ONE approval, as granted: the spender, the ERC-20 contract whose approval
 * granted it, and the amount that approval set.
 *
 * All three travel together because neither of the first two alone authorizes
 * anything. An approval for token B says nothing about where token A may go, and
 * an `approve(spender, 0)` REVOKES rather than grants - a grant list that
 * carried no amount would keep authorizing a spender whose allowance was reset
 * to zero moments later.
 */
export interface ApprovedSpender {
  /** The approval transaction's target: the token contract itself. */
  readonly token: Address;
  readonly spender: Address;
  /** The allowance this approval SET, in atomic units. Zero is a revocation. */
  readonly amountRaw: bigint;
}

export interface Erc20Approval {
  readonly spender: Address;
  readonly amount: bigint;
}

export function decodeErc20Approve(data: string | undefined): Erc20Approval | null {
  if (!data || !data.startsWith("0x")) return null;
  try {
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: data as Hex });
    if (decoded.functionName !== "approve") return null;
    return { spender: getAddress(decoded.args[0]), amount: decoded.args[1] };
  } catch {
    return null;
  }
}

/** The spender an approval grants, or `null` when the calldata is not an `approve`. */
export function decodeApproveSpender(data: string | undefined): Address | null {
  return decodeErc20Approve(data)?.spender ?? null;
}
