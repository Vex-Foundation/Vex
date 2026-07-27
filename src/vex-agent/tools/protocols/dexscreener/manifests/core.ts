import type { ProtocolToolManifest } from "../../types.js";
import { DEXSCREENER_CORE_DISCOVERY } from "../../embeddings/dexscreener/core.js";
import {
  PAIR_BATCH_PARAMS,
  PAIR_LIST_PARAMS,
  PAIR_LOOKUP_PARAMS,
  SEARCH_CHAIN_FILTER_PARAM,
} from "./pair-list-params.js";

// Chain slugs are DexScreener string ids: ethereum, base, solana, bsc,
// arbitrum, polygon, avalanche, optimism, robinhood (chainId 4663), and more.
// Typical research flow: search → tokenPairs (pick deepest pool) → pairs (deep
// stats on that pool).
//
// All four tools share the param vocabulary in `./pair-list-params.ts` and the
// output contract in `../pair-list/`. The tool-level `description` strings below
// predate that work and are owned by a separate description card — the param
// text is where the honest constraints live for now.

export const CORE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.search",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Search DEX pairs across every chain by token name, symbol, or contract address. Start here when you have a name/ticker/address but not a specific pool. Returns concise pairs (price, priceChange h1/h24, liquidity, volume h24, FDV, market cap, txns h24) sorted by liquidity. Optional filters: chainId (e.g. ethereum, base, solana, bsc, arbitrum, robinhood), minLiquidityUsd, limit. Then use dexscreener.tokenPairs to pick the deepest pool.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "query",
        type: "string",
        required: true,
        description:
          "What to match, minimum 2 characters (DexScreener answers 1 character with an HTTP 400 "
          + "it does not explain). Matches a token name (spaces are fine), a symbol, a token "
          + "address, pair notation like SOL/USDC, and a venue name such as raydium — which acts "
          + "as a de-facto venue filter. A POOL address returns exactly that one pool, with no "
          + "chainId needed, which makes this the cheapest way to identify an address of unknown "
          + "provenance. TRAP: matching is purely textual and never against the chain field, so "
          + "q=arbitrum returns the ARB token on Solana, not pools on Arbitrum — use `chainIds` "
          + "for that.",
      },
      SEARCH_CHAIN_FILTER_PARAM,
      ...PAIR_LIST_PARAMS,
    ],
    exampleParams: { query: "PEPE", chainIds: "base", minTurnoverRatio: 0.05 },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.search"],
  },
  {
    toolId: "dexscreener.pairs",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get concise stats for one specific DEX pool by chain + pair address — price, priceChange (h1/h24), liquidity, volume (h24), txns (h24 buys/sells), FDV, market cap, pair age. Use when you already have a pool address (e.g. from dexscreener.tokenPairs) and want its numbers.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainId", type: "string", required: true, description: "Chain slug (e.g. ethereum, base, solana, bsc, arbitrum, robinhood)." },
      {
        key: "pairAddress",
        type: "string",
        required: true,
        description:
          "DEX pool/pair contract address. Comma-separate several to fetch them in ONE call "
          + "(verified live: 2 addresses returned 2 pools) — cheaper against the rate limit than "
          + "one call each. `requestedPairAddresses` and `found` in the reply say what was asked "
          + "for and whether anything came back.",
      },
      ...PAIR_LOOKUP_PARAMS,
    ],
    exampleParams: { chainId: "ethereum", pairAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.pairs"],
  },
  {
    toolId: "dexscreener.tokens",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Batch-price up to 30 token addresses on ONE chain in a single call (comma-separated). Returns the same concise pair rows as search. Use for portfolio pricing or comparing several tokens on the same chain.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainId", type: "string", required: true, description: "Chain slug (e.g. ethereum, base, solana, bsc, arbitrum, robinhood)." },
      {
        key: "tokenAddresses",
        type: "string",
        required: true,
        description:
          "Comma-separated token addresses. DexScreener answers at most 30 and SILENTLY DROPS the "
          + "rest (measured: 40 requested, 30 returned, 10 absent, HTTP 200) — always read "
          + "unresolvedAddresses and addressCapApplied in the reply. Each address yields ONE "
          + "arbitrary pool, often not the deepest; use dexscreener.tokenPairs for depth.",
      },
      ...PAIR_BATCH_PARAMS,
    ],
    exampleParams: { chainId: "ethereum", tokenAddresses: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.tokens"],
  },
  {
    toolId: "dexscreener.tokenPairs",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List every DEX pool for ONE token on a chain, sorted by USD liquidity (deepest first). This is the canonical resolver for 'which pool should I trade / zap into'. Returns concise pair rows including pairAddress — feed that pool address into swap/zap tools or dexscreener.pairs.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainId", type: "string", required: true, description: "Chain slug (e.g. ethereum, base, solana, bsc, arbitrum, robinhood)." },
      { key: "tokenAddress", type: "string", required: true, description: "Token contract address." },
      ...PAIR_LIST_PARAMS,
    ],
    exampleParams: { chainId: "solana", tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.tokenPairs"],
  },
];
