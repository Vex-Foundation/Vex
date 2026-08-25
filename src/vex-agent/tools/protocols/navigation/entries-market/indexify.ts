import type { ProtocolNamespaceNavigation } from "../types.js";

/**
 * Indexify — the Solana social-index ("stacks") platform.
 *
 * The custody line below is the one fact the agent must never lose: this venue
 * trades the LINKED INDEXIFY ACCOUNT's custodial USDC via an API key, not the
 * session wallet. It is the tree's first custodial namespace, so nothing else
 * in the catalog teaches that distinction.
 */
export const INDEXIFY_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "indexify",
  advertised: true,
  groupId: "solana",
  groupLabel: "Solana",
  summary:
    "Indexify, the Solana social-index platform: creators bundle tokens into investable USDC-denominated baskets called stacks, indexed from $1.00 at inception. Browse and search stacks, read one stack's full allocation, read creator leaderboards and track records, search the venue's tradable-token catalogue, preview fees, and — on the LINKED INDEXIFY ACCOUNT (a custodial venue account holding deposited USDC, never the Vex session wallet) — read balances, positions, orders and history, buy or sell stacks, resolve partial fills, and create new stacks.",
  whenToUse:
    "Use when the user mentions Indexify or stacks, wants a crypto index basket on Solana, asks who the best stack creators are, or wants to invest the linked Indexify account in a curated basket: browse or search stacks, read a stack's allocation, check creator track records, then trade with USDC or create a stack of their own. Only the trade and the partial-order resolution spend; creation is free but publishes a public stack.",
  preferInstead:
    "Use `dexscreener` for token-level market research — Indexify's token catalogue only answers what a stack can hold. Use `solana` (Jupiter) to swap individual tokens with the session wallet; Indexify trades whole baskets on its own custodial account and cannot swap single tokens. Trench and pools.fun are launchpads for CREATING tokens; Indexify curates baskets of tokens that already exist.",
  declaration: {
    identity:
      "Indexify is a custodial Solana social-index venue where creator-curated token baskets (stacks) trade against the linked account's deposited USDC.",
    read:
      "Browse trending stacks, official stacks, or the whole catalogue with ranking and market-cap filters, find a stack by name, read one stack's full token allocations and web link, search the tradable token catalogue, read the creator leaderboard and one creator's track record, and read the linked account's balances and deposit address, per-stack holdings with PnL, orders with settlement hashes, and transaction history.",
    quote:
      "Preview trading costs before a trade: the venue minimum buy, the creator-fee bounds, and the venue's own fee estimate for a stated USDC amount on a stated stack.",
    act:
      "Buy a stack with the linked account's USDC, sell a percent of a held stack position, resolve a partially filled order by retrying acknowledging or selling all, and create a new stack from named token allocations, public immediately.",
    whenItApplies:
      "Use it for one-click diversified exposure through index baskets on Solana, following or evaluating stack creators, managing the linked Indexify account's stack positions, or publishing a curated basket.",
    characteristicAndLimits:
      "Custodial: trades execute server-side on Indexify against the linked account's USDC, authorized by an API key — no local signing, no session wallet, no cancellation after acceptance. Orders settle asynchronously and can land partial; sells are sized only as a percent of holdings; buys have a venue minimum; fees are 1 percent platform plus up to half a percent creator; per-token balances are not reported. Stack names repeat, so id or slug is identity.",
    retrievalTerms: [
      "trending stacks",
      "stack by name",
      "token allocations",
      "creator leaderboard",
      "track record",
      "buy a stack",
      "partially filled",
      "create a new stack",
      "minimum buy",
      "transaction history",
      "deposit address",
      "index basket",
    ],
    facets: [
      "Stack discovery and detail",
      "Creators and leaderboard",
      "Linked account balances orders and history",
      "Trading and creating stacks",
    ],
  },
  exampleQueries: [
    'ToolSearch(query="trending stacks on indexify", namespace="indexify")',
    'ToolSearch(query="buy a stack with usdc", namespace="indexify")',
    'ToolSearch(query="top stack creators", namespace="indexify")',
  ],
  aliases: ["indexify", "stacks", "index baskets", "social index", "indexify.finance"],
  discoveryHints: [
    "trending stacks on indexify",
    "crypto index funds on solana",
    "what is inside this stack",
    "top stack creators",
    "buy a stack",
    "my indexify balance",
  ],
  facets: [
    {
      label: "Stack discovery and detail",
      summary:
        "Browse trending, official, or all stacks with ranking and market-cap filters, search a stack by name, read one stack's full allocation with weights and web link, and search the venue's tradable-token catalogue.",
      toolPrefixes: ["indexify.stacks", "indexify.search", "indexify.stack", "indexify.tokens"],
      hints: [
        "trending stacks",
        "official indexify stacks",
        "find a stack by name",
        "what tokens are in this stack",
        "can indexify trade this token",
      ],
    },
    {
      label: "Creators and leaderboard",
      summary:
        "Rank stack creators by points, PnL, hit rate, stacks created or trades over a window, or read one creator's public profile joined with their performance metrics.",
      toolPrefixes: ["indexify.creators"],
      hints: [
        "top stack creators",
        "creator leaderboard by pnl",
        "this creator's hit rate",
        "who made this stack",
      ],
    },
    {
      label: "Linked account balances orders and history",
      summary:
        "Read the linked Indexify account's spendable and reserved USDC, total value and deposit address, its position and PnL inside one stack, its orders with per-transaction Solana hashes and partial-fill breakdowns, and its full transaction history with fees.",
      toolPrefixes: ["indexify.portfolio", "indexify.holdings", "indexify.orders", "indexify.history"],
      hints: [
        "indexify account balance",
        "my stack position pnl",
        "did my stack order settle",
        "indexify transaction history",
      ],
    },
    {
      label: "Trading and creating stacks",
      summary:
        "Preview fees, buy a stack with the linked account's USDC, sell a percent of a held position, resolve a partially filled order, or create a new public stack from named token allocations. Trades execute server-side on the venue and settle asynchronously as orders.",
      toolPrefixes: ["indexify.fees", "indexify.trade_execute", "indexify.order_resolve", "indexify.stack_create"],
      hints: [
        "buy 10 dollars of this stack",
        "sell half my stack position",
        "what would this trade cost",
        "retry my partial order",
        "create a stack",
      ],
    },
  ],
};
