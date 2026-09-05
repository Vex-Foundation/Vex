/**
 * Indexify discovery manifests — the public read surface (no API key needed).
 *
 * Stacks are creator-curated baskets of Solana tokens, indexed from $1.00 at
 * inception. Raw provider rows are ~3.6 KB each (measured 2026-08-26), so every
 * handler projects to compact rows and the limits here are hard caps, not
 * suggestions.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { INDEXIFY_DISCOVER_DISCOVERY } from "../../embeddings/indexify/discover.js";
import {
  INDEXIFY_API_KEY_ENV,
  INDEXIFY_LIST_LIMIT_CAP,
  INDEXIFY_LIST_LIMIT_DEFAULT,
  INDEXIFY_STACK_FEEDS,
  INDEXIFY_STACK_SORTS,
} from "@tools/indexify/constants.js";

export const INDEXIFY_DISCOVER_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "indexify.stacks",
    publicName: "indexify__stacks_discover",
    namespace: "indexify",
    lifecycle: "active",
    description:
      "Browse the stacks on Indexify, the Solana social-index platform where creators bundle tokens into investable USDC-denominated baskets. Use this when the user wants trending stacks, official Indexify stacks, or the catalogue ranked by performance, market cap, price, or age. Returns compact rows: stack id, slug, name, category, price (every stack is indexed from $1.00 at inception, so price IS lifetime performance), 24h/7d/30d/all-time changes, weighted market cap, creator fee, creator username, token count with top symbols, and investor-relevant flags. Resolve a specific stack the user names with indexify__stacks_search instead, and read one stack's full allocation with indexify__stack_get. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "feed",
        type: "string",
        enum: [...INDEXIFY_STACK_FEEDS],
        description:
          "Which provider feed fills the rows: all (default; the whole sortable catalogue), trending (Indexify's own trending ranking), or official (Indexify-curated stacks).",
      },
      {
        key: "sort",
        type: "string",
        enum: [...INDEXIFY_STACK_SORTS],
        description:
          "Ranking key for the all feed: a change window (change4H/change1D/change1W/change1M/changeAll), newest, oldest, price, or mcap. Ignored by trending and official, which carry their own order.",
      },
      {
        key: "order",
        type: "string",
        enum: ["asc", "desc"],
        description:
          "Ranking direction for the all feed, asc or desc. Defaults to desc, which puts the best performer or the largest first.",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Maximum rows returned, 1-${INDEXIFY_LIST_LIMIT_CAP}. Defaults to ${INDEXIFY_LIST_LIMIT_DEFAULT}. Raw provider rows are large, so the cap is a hard output-budget bound.`,
      },
      {
        key: "offset",
        type: "number",
        description:
          "Row offset for paging, 0-based. Pass the previous call's offset plus its returned row count to read the next page.",
      },
      {
        key: "minMarketCapUsd",
        type: "number",
        description:
          "Floor on the stack's weighted market capitalisation, in USD. Filters out micro-cap baskets before ranking.",
      },
      {
        key: "maxMarketCapUsd",
        type: "number",
        description:
          "Ceiling on the stack's weighted market capitalisation, in USD. Pairs with minMarketCapUsd to band the screen.",
      },
    ],
    exampleParams: { feed: "trending", limit: 10 },
    discovery: INDEXIFY_DISCOVER_DISCOVERY["indexify.stacks"],
  },
  {
    toolId: "indexify.search",
    publicName: "indexify__stacks_search",
    namespace: "indexify",
    lifecycle: "active",
    description:
      "Find a stack on Indexify by its name. Use this when the user names a stack and you need its numeric id or slug before reading detail, quoting fees, checking holdings, or trading it. Returns matching rows with stack name, numeric stack id, slug, and a truncated description. Stack names are NOT unique on Indexify, so when several rows match, confirm which one the user means by its id or slug before acting on it. Matching is the provider's own name search; it does not search descriptions or creators. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "query",
        type: "string",
        required: true,
        description:
          "The stack name or name fragment to look for, 1 to 64 characters. Matched by the provider against stack names only.",
      },
    ],
    exampleParams: { query: "solana defi" },
    discovery: INDEXIFY_DISCOVER_DISCOVERY["indexify.search"],
  },
  {
    toolId: "indexify.stack",
    publicName: "indexify__stack_get",
    namespace: "indexify",
    lifecycle: "active",
    // The docs call `stack_info action=fetch` optional-auth; the LIVE API
    // 401s it keyless (measured 2026-08-26), so this read is honestly gated.
    requiresEnv: INDEXIFY_API_KEY_ENV,
    description:
      "Read ONE Indexify stack in full. Use this after a browse or search resolved the stack, and before quoting fees or trading it. Returns the stack's identity (id, slug, name, category, creator, the shareable web link), its price and change windows, weighted market cap, TVL, investor count, creator fee, allocation version, and the complete token list with each token's symbol, mint address, and integer percent weight. Also states whether the stack is closed or archived — a closed stack cannot be bought. Provide the slug OR the numeric stackId, exactly one of the two. Read-only.",
    mutating: false,
    actionKind: "read",
    exclusiveParamGroups: [["slug", "stackId"]],
    params: [
      {
        key: "slug",
        type: "string",
        description:
          "The stack's URL slug, as returned by discovery and search rows (for example solana-top-5-defi-index).",
      },
      {
        key: "stackId",
        type: "number",
        description:
          "The stack's own numeric id, as returned by discovery and search rows. Give either slug or stackId, never both.",
      },
    ],
    exampleParams: { slug: "solana-top-5-defi-index" },
    discovery: INDEXIFY_DISCOVER_DISCOVERY["indexify.stack"],
  },
  {
    toolId: "indexify.tokens",
    publicName: "indexify__tokens_search",
    namespace: "indexify",
    lifecycle: "active",
    description:
      "Search Indexify's own catalogue of tradable Solana tokens by name or symbol. Use this before creating a stack (allocations need the exact mint addresses Indexify knows) or when checking whether Indexify can trade a token at all. Returns token name, symbol, mint address, and the provider's verification flag. This is Indexify's internal catalogue, not a market-data source — keep using DexScreener for price research and pair analytics; a token absent here simply cannot go into a stack. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "query",
        type: "string",
        required: true,
        description:
          "Token name or symbol fragment to look for, 1 to 64 characters, matched by the provider across its catalogue.",
      },
    ],
    exampleParams: { query: "jupiter" },
    discovery: INDEXIFY_DISCOVER_DISCOVERY["indexify.tokens"],
  },
];
