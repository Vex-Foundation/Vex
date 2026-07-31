/**
 * Trench Express curve trade calldata builders (pure — no network, no signing).
 *
 * Every builder encodes against the verified `TRENCH_DIAMOND_ABI` /
 * `TRENCH_ERC20_ABI` fragments (recovered from the Blockscout-verified facet and
 * confirmed by 4 funded live transactions). `min` and `deadline` are computed by
 * the caller from OUR fresh quote and a LOCAL clock — never from model input.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import { TRENCH_DIAMOND_ABI, TRENCH_ERC20_ABI } from "../abi.js";

/** `buy(token, min, deadline)` — payable; the ETH principal rides `tx.value`. */
export function buildBuyCalldata(token: Address, minOut: bigint, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: TRENCH_DIAMOND_ABI,
    functionName: "buy",
    args: [token, minOut, deadline],
  });
}

/** `sell(token, amount, min, deadline)` — nonpayable; requires a prior approve. */
export function buildSellCalldata(token: Address, amount: bigint, minOut: bigint, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: TRENCH_DIAMOND_ABI,
    functionName: "sell",
    args: [token, amount, minOut, deadline],
  });
}

/** ERC-20 `approve(spender, amount)` — the sell path grants the Diamond first. */
export function buildApproveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: TRENCH_ERC20_ABI,
    functionName: "approve",
    args: [spender, amount],
  });
}
