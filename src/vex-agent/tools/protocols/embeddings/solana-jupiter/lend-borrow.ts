/**
 * Retrieval metadata for Solana / Jupiter Lend BORROW tools (Agent Scan
 * Phase 3 Batch 5, card B1). Separate from `./lend.ts` (Earn) — a distinct
 * program family with its own vault/position/operate vocabulary.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `solana-jupiter/manifests/lend-borrow.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { SOLANA_CHAINS } from "../../solana-jupiter/discovery-text.js";

export const SOLANA_LEND_BORROW_DISCOVERY = {
  "solana.lend.borrowVaults": {
    embeddingText: embeddingText(
      `Get Jupiter Lend Borrow vault configs on Solana — collateral token, borrow token, max LTV, liquidation `
      + `threshold, available liquidity, minimum borrow size, per vault. Cross-reference solana.lend.borrowOperate's `
      + `vaultId param. Use this when opening or sizing a leveraged/borrow position — different from `
      + `solana.lend.rates, which covers Earn (simple lending) yields, not collateralized Borrow. `
      + `Example queries: which vaults can I borrow against, max LTV for sol collateral, jupiter borrow vaults, `
      + `liquidation threshold for a vault, how much can I borrow, borrow vault list.`,
    ),
    chains: SOLANA_CHAINS,
  },

  "solana.lend.borrowPositions": {
    embeddingText: embeddingText(
      `Get a wallet's open Jupiter Lend Borrow positions on Solana — collateral supplied, debt owed, and `
      + `residual dust debt, per position (NFT). Use this when the user wants to check their borrow positions, `
      + `see how much they owe, review collateral before adding/removing, or find a positionId to operate on. `
      + `Different from solana.lend.positions, which covers Earn (simple lending), not collateralized Borrow. `
      + `Example queries: my borrow positions, how much do I owe, check my collateral, my jupiter borrow debt, `
      + `find my position id, review my leveraged position.`,
    ),
    chains: SOLANA_CHAINS,
  },

  "solana.lend.borrowOperate": {
    embeddingText: embeddingText(
      `Open, adjust, or close a Jupiter Lend Borrow position on Solana — deposit or withdraw collateral, borrow `
      + `or repay debt, in any combination, in one call. Use this when starting to borrow against collateral, `
      + `adding more collateral, borrowing more, repaying some or all debt, or withdrawing some or all collateral. Shows LTV and `
      + `liquidation risk before you approve. Different from solana.lend.deposit/withdraw, which are simple Earn `
      + `lending, not collateralized borrowing. Example queries: borrow usdc against my sol, repay my loan, add `
      + `more collateral, withdraw all my collateral, open a leveraged position, deposit and borrow in one step.`,
    ),
    chains: SOLANA_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(SOLANA_LEND_BORROW_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `SOLANA_LEND_BORROW_DISCOVERY has ${Object.keys(SOLANA_LEND_BORROW_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
