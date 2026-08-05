/**
 * On-chain EVM forensics — transaction receipts + ERC-721 mint detection.
 * Chain resolution is inclusive: the khalani chain registry first, the local EVM
 * registry (Robinhood Chain 4663) as fallback. Read-only.
 *
 * Native balances are owned by `wallet_balances`; token metadata
 * (decimals/symbol/name) by `token_find` (khalani.tokens.search).
 */

import type { ToolDef } from "../types.js";

export const EVM_TOOLS: readonly ToolDef[] = [
  {
    name: "chain_read", kind: "internal", mutating: false, pressureSafety: "read_only", actionKind: "read",
    description: "Raw on-chain EVM forensics — transaction receipts (status, gasUsed, logs) and ERC-721 mint detection from receipt logs. Resolves chains through the khalani registry first and the local EVM registry as fallback, so local-only chains work too (e.g. chain 'robinhood' / '4663'). Read-only. Native balances are via wallet_balances; token metadata (decimals/symbol/name) via token_find.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["tx_receipt", "erc721_mint"], description: "What to read" },
      // W6a: was `chainId`, a key that said Id over a value that is usually a
      // slug. The old spelling is refused BY NAME in handleChainRead, which
      // names `chain` in the refusal — internal tools have no strict unknown-key
      // gate, so an unrenamed call would otherwise read as "chain is missing".
      chain: { type: "string", description: "Chain slug/alias, or the numeric chain id `token_find` returns (e.g. `base` or `8453`). Local-only chains work too: 'robinhood' / '4663'." },
      txHash: { type: "string", description: "Transaction hash (for tx_receipt, erc721_mint)" },
      address: { type: "string", description: "Recipient address — optional mint filter for erc721_mint (only mints to this address are returned)" },
    }, required: ["action", "chain"] },
  },
];
