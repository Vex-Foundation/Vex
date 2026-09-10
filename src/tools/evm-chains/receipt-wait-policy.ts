/** Interactive receipt waiting hands unresolved hashes to the sync observer. */
import { mainnet, base, optimism, polygon, arbitrum, bsc } from "viem/chains";

const chains = [mainnet, base, optimism, polygon, arbitrum, bsc];
export function receiptWaitDeadlineMs(chainId?: number): number {
  // Twelve advertised block intervals, bounded to 15-120 seconds. A custom
  // chain without published timing uses Ethereum's conservative interval.
  const blockTime = chains.find(chain => chain.id === chainId)?.blockTime ?? mainnet.blockTime;
  return Math.max(15_000, Math.min(120_000, blockTime * 12));
}
export class ReceiptWaitDeadlineError extends Error {
  constructor() {
    super("Transaction was broadcast and is awaiting inclusion. Receipt waiting reached its deadline; reconciliation continues. Do not rebroadcast.");
    this.name = "ReceiptWaitDeadlineError";
  }
}
