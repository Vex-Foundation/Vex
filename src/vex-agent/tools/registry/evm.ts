/**
 * On-chain EVM forensics: transaction receipts, ERC-721 mint detection, and a
 * direct ERC-20 balanceOf read. Chain resolution is inclusive: the khalani chain
 * registry first, the local EVM registry (Robinhood Chain 4663) as fallback.
 * Read-only.
 *
 * Native balances are owned by `WalletBalances`; token symbol/name by
 * `TokenFind` (khalani.tokens.search).
 */

import type { ToolDef } from "../types.js";
import { READ_ONLY_NO_VEX_FEE } from "../vex-fee-notes.js";

export const EVM_TOOLS: readonly ToolDef[] = [
  {
    name: "ChainRead", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: "Raw on-chain EVM forensics - transaction receipts (status, gasUsed, logs), ERC-721 mint detection from receipt logs, and a direct ERC-20 balanceOf read (erc20_balance) for one token and one owner. Resolves chains through the khalani registry first and the local EVM registry as fallback, so local-only chains work too (e.g. chain 'robinhood' / '4663'). Read-only. erc20_balance asks the token contract itself, so it is the way to check whether a confirmed buy actually delivered: WalletBalances reports a scan projection, and receipt Transfer logs are written by the token. Use this when you have a transaction hash and need to know whether it actually succeeded, when a confirmed buy has to be proven against the token contract itself, or when a mint's tokenId must be recovered from a receipt. RETURNS chain and chainId on every action, then per action: tx_receipt adds txHash, status, blockNumber, gasUsed, logsCount, from, to and contractAddress; erc721_mint adds txHash, mintsFound, primaryNftId and mints (contract, tokenId, to); erc20_balance adds tokenAddress, owner, balanceRaw, decimals and balance - balance is null and a decimalsError is present when the contract's decimals could not be read, so a missing balance never reads as a zero one. Native balances are via WalletBalances; token symbol/name via TokenFind.",
    returns: "RETURNS chain and chainId on every action, then per action: tx_receipt adds txHash, status, blockNumber, gasUsed, logsCount, from, to and contractAddress; erc721_mint adds txHash, mintsFound, primaryNftId and mints (contract, tokenId, to); erc20_balance adds tokenAddress, owner, balanceRaw, decimals and balance - balance is null and a decimalsError is present when the contract's decimals could not be read, so a missing balance never reads as a zero one.",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["tx_receipt", "erc721_mint", "erc20_balance"], description: "What to read" },
      // W6a: was `chainId`, a key that said Id over a value that is usually a
      // slug. The old spelling is refused BY NAME in handleChainRead, which
      // names `chain` in the refusal - internal tools have no strict unknown-key
      // gate, so an unrenamed call would otherwise read as "chain is missing".
      chain: { type: "string", description: "Chain slug/alias, or the numeric chain id `TokenFind` returns (e.g. `base` or `8453`). Local-only chains work too: 'robinhood' / '4663'." },
      txHash: { type: "string", description: "Transaction hash (for tx_receipt, erc721_mint)" },
      address: { type: "string", description: "Recipient address - optional mint filter for erc721_mint (only mints to this address are returned)" },
      tokenAddress: { type: "string", description: "ERC-20 contract address (REQUIRED for erc20_balance)" },
      owner: { type: "string", description: "Address to read the ERC-20 balance of (erc20_balance). Omit to read your own selected wallet." },
    }, required: ["action", "chain"] },
  },
];
