/**
 * Post-buy delivery verification: after a swap that ACQUIRED an ERC-20 confirms
 * on-chain, ask the token itself what the wallet holds.
 *
 * Live incident 2026-08-10 (Robinhood Chain 4663): a confirmed buy of 43,932
 * TOM emitted a Transfer log to the wallet, the settlement decoder read that
 * log, and `balanceOf(wallet)` was zero. Receipt logs are contract-authored, so
 * a fake-transfer token can produce a perfectly decodable settlement while
 * delivering nothing. The agent read the transfer as truth and burned five
 * minutes of blind sell retries.
 *
 * Deliberately narrow: ONE read, and a claim only on an exact zero. The verdict
 * is phrased as an observation plus the pattern it matches, never as proof of
 * intent, because one zero read is all the evidence there is. A non-zero
 * balance adds nothing (there is no "materially short" tolerance here), and a
 * failed read is logged and stays out of agent-facing text entirely.
 *
 * Never allowed to fail the swap: the funds already moved.
 */

import type { Address } from "viem";

import { readErc20Balance, type Erc20ReadClient } from "./erc20-reads.js";
import logger from "../../utils/logger.js";

export interface PostBuyDeliveryRequest {
  readonly client: Erc20ReadClient;
  /** The ACQUIRED (token-out) ERC-20. Native legs never reach here. */
  readonly tokenAddress: Address;
  readonly owner: Address;
  /** Chain slug or id, for the fail-soft log only. */
  readonly chainLabel: string;
  readonly txHash: string;
}

const ZERO_DELIVERY_VERDICT =
  "Delivery check: balanceOf returned zero immediately after the confirmed buy; "
  + "this matches a fake-transfer/honeypot delivery failure; "
  + "do not retry the sale on this evidence.";

/**
 * The agent-facing verdict when the buy delivered nothing, or `null` when the
 * wallet holds the token or the read could not be made.
 */
export async function verifyPostBuyDelivery(
  request: PostBuyDeliveryRequest,
): Promise<string | null> {
  let balance: bigint;
  try {
    balance = await readErc20Balance(request.client, request.tokenAddress, request.owner);
  } catch (err) {
    // SECURITY: a raw provider error can carry the RPC URL or a response body,
    // so only the bounded error CLASS is logged, and nothing is said to the
    // agent - an unread balance is not evidence of anything.
    logger.warn("evm_chains.post_buy_delivery.read_failed", {
      chain: request.chainLabel,
      token: request.tokenAddress,
      txHash: request.txHash,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
  return balance === 0n ? ZERO_DELIVERY_VERDICT : null;
}
