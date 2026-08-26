/**
 * ONE valid `BoardSpecV1` for every app-side suite that needs a board.
 *
 * Not a test file (no `*.test.ts` suffix, so vitest does not collect it). It is
 * built through the CANONICAL schema's own types rather than hand-typed
 * `unknown`, so a contract change in `src/lib/board/` breaks this builder at
 * compile time instead of letting the persistence suites keep asserting against
 * a shape the engine no longer writes.
 */

import type { BoardSpecV1 } from "@vex-lib/board/index.js";

/** Fixed clocks: the two hydration timestamps are distinct on purpose. */
export const BOARD_ANALYSIS_AT = 1_756_000_000_000;
export const BOARD_MARKET_DATA_AT = 1_756_000_060_000;

export function boardSpecFixture(
  overrides: Partial<BoardSpecV1> = {},
): BoardSpecV1 {
  return {
    version: 1,
    title: "SOL liquidity check",
    pools: [
      {
        chain: "solana",
        pairAddress: "AbC123pairAddress",
        caption: "deepest pool",
      },
    ],
    notes: ["Liquidity thinned out after the 14:00 candle."],
    hydration: {
      rows: [
        {
          baseTokenSymbol: "SOL",
          baseTokenName: "Solana",
          quoteTokenSymbol: "USDC",
          chainId: "solana",
          dexId: "raydium",
          // Current writers always emit iconId (null when the provider has no
          // profile). Legacy rows lacking the key entirely are exercised by the
          // dedicated normalization test in messages-mapper-board.test.ts.
          iconId: null,
          priceUsd: "184.2213",
          priceChange: { h1: "-0.42", h24: "3.10" },
          liquidityUsd: "8421330.55",
          volumeH24Usd: "19233110.02",
          txns: { buys: 4821, sells: 3907 },
          pairAgeSeconds: 90_000,
        },
      ],
      candles: null,
      unmatchedMarkerAtMs: null,
      analysisCreatedAt: BOARD_ANALYSIS_AT,
      marketDataFetchedAt: BOARD_MARKET_DATA_AT,
      provenance: {
        transport: "dexscreener-public",
        sourceObservation: "pairs-batch read at compose time",
      },
      staleAfterMs: 60_000,
    },
    ...overrides,
  };
}
