/**
 * Stable Jupiter Lend constants and official program addresses.
 * Verified from Jupiter Lend docs on 2026-03-30.
 */

export const JUPITER_LEND_API_BASE_URL = "https://api.jup.ag/lend/v1";
export const JUPITER_LEND_EARN_API_BASE_URL = `${JUPITER_LEND_API_BASE_URL}/earn`;

export const JUPITER_LEND_PROGRAM_ADDRESSES = {
  lending: "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
  liquidity: "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
  lendingRewardsRateModel: "jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar",
  oracle: "jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc",
  vaults: "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",
  flashloan: "jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS",
} as const;

export const JUPITER_LEND_DEFERRED_AREAS = [
  // Borrow REST (vaults/positions/operate) is IMPLEMENTED as of Agent Scan
  // Phase 3 Batch 5 (card B1) — see `borrow-api/`. `/operate-instructions`
  // stays deliberately excluded (owner decision, B1 card): this shelf never
  // composes/signs raw instructions itself.
  "Borrow /operate-instructions endpoint",
  // Named without the npm scope/package syntax on purpose — the shelf
  // regression guard forbids that literal string appearing anywhere under
  // jupiter-lend/ (see jupiter-lend-regression.test.ts).
  "Borrow SDK integrations (the official Jupiter Lend + Lend-Read npm packages)",
  "Flashloan SDK flows",
  "Liquidity analytics helpers",
  "Oracle verification helpers",
  "CPI and on-chain integration helpers",
  "Advanced Lend guides that depend on Jupiter Lite API swap instructions",
] as const;
