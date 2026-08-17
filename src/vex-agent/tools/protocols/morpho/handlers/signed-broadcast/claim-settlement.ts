/**
 * What a claim receipt PROVES was credited, decoded from its own logs.
 *
 * The rule this module exists to enforce is rules/90's: a decoder that cannot
 * prove what happened declines rather than reporting the number it hoped for.
 * The claim was built from Merkl's `amount - claimed` arithmetic, and that
 * arithmetic is a PREDICTION. What lands is whatever the distributor actually
 * transferred, which differs the moment another transaction claims the same leaf
 * first or a newer root supersedes the proof mid-flight. So the confirmed row
 * carries transfer amounts read out of the receipt, never the planned figures.
 *
 * A claim's proof is narrow and cheap: the distributor emits one ERC20
 * `Transfer` per claimed token, `to` the wallet in the leaf. Matching on
 * (token, recipient) is enough, and matching on the EXPECTED TOKEN SET as well
 * means an unrelated transfer that happened to land in the same transaction
 * cannot be booked as reward income.
 */

import type { MerklClaimLeaf } from "@tools/merkl/distributor.js";
import { formatUnits } from "viem";

import type { MorphoClaimExecutedCredit } from "./claim-broadcast.js";

/** `Transfer(address,address,uint256)`. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ClaimReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** The low 20 bytes of a 32-byte topic word, as a lower-case address. */
function topicAddress(topic: string | undefined): string | null {
  if (typeof topic !== "string" || topic.length !== 66) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

function logAmount(data: string): bigint | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 3) return null;
  try {
    return BigInt(data.slice(0, 66));
  } catch {
    return null;
  }
}

/**
 * Sum the credits this receipt proves, one entry per token that actually
 * arrived, in the order the claim's leaves were planned.
 *
 * Tokens are SUMMED rather than taken from the first matching log: nothing
 * forbids a distributor from settling one token in more than one transfer, and
 * reporting only the first would understate the credit. A leaf with no matching
 * transfer is simply absent from the result - that is the honest reading of "it
 * credited nothing", and the caller turns an empty result into the `no_credit`
 * outcome rather than a confirmation.
 */
export function provenClaimCredit(
  logs: readonly ClaimReceiptLog[],
  walletAddress: string,
  leaves: readonly MerklClaimLeaf[],
): readonly MorphoClaimExecutedCredit[] {
  const wallet = walletAddress.toLowerCase();
  const expected = new Map(leaves.map((leaf) => [leaf.tokenAddress.toLowerCase(), leaf]));
  const credited = new Map<string, bigint>();

  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const token = log.address.toLowerCase();
    if (!expected.has(token)) continue;
    if (topicAddress(log.topics[2]) !== wallet) continue;
    const amount = logAmount(log.data);
    if (amount === null || amount <= 0n) continue;
    credited.set(token, (credited.get(token) ?? 0n) + amount);
  }

  const credits: MorphoClaimExecutedCredit[] = [];
  for (const leaf of leaves) {
    const amount = credited.get(leaf.tokenAddress.toLowerCase());
    if (amount === undefined) continue;
    credits.push({
      tokenAddress: leaf.tokenAddress,
      tokenSymbol: leaf.tokenSymbol,
      tokenDecimals: leaf.tokenDecimals,
      amountRaw: amount.toString(),
      amountHuman: formatUnits(amount, leaf.tokenDecimals),
    });
  }
  return credits;
}
