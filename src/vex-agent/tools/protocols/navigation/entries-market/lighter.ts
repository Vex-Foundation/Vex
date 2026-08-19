import type { ProtocolNamespaceNavigation } from "../types.js";

export const LIGHTER_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "lighter",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Managed Lighter onboarding, trading, and secure withdrawals for everyday users, plus Core and Robinhood Chain market data and account reads.",
  whenToUse:
    "Use when the user asks Vex to set up Lighter, trade Lighter perps, inspect markets or their account, place an order, or withdraw Core USDC or RHC USDG to their selected wallet. Managed onboarding and withdrawals resolve wallet, account, credential, nonce, and fixed destination internally. Fund movement is always approval-gated.",
  preferInstead:
    "Use `dexscreener` for broad multi-chain DEX pair research. Lighter order execution never happens directly from a chat request: it requires a fresh preview, an approval preparation, and the user approving the card in the host UI.",
  exampleQueries: [
    'discover_tools(query="set up my lighter account", namespace="lighter")',
    'discover_tools(query="I want to trade perps on lighter", namespace="lighter")',
    'discover_tools(query="withdraw USDG from lighter rhc", namespace="lighter")',
    'discover_tools(query="rhc order book depth", namespace="lighter")',
  ],
  aliases: ["lighter", "rhc lighter", "lighter core", "lighter market data", "lighter order book"],
  discoveryHints: [
    "lighter markets",
    "lighter market id",
    "rhc order book",
    "lighter recent trades",
    "lighter candles",
    "lighter system status",
    "set up my lighter account",
    "get me ready for lighter perps",
    "withdraw from lighter",
  ],
  facets: [
    {
      label: "Get ready to trade",
      summary:
        "Inspect the selected wallet, ask only for the desired USDC deposit, then prepare the approval-gated deposit and managed local trading credential setup.",
      toolPrefixes: ["lighter.account.onboarding", "lighter.deposit", "lighter.key.register"],
      hints: [
        "set up my lighter account",
        "get me ready to trade on lighter",
        "I want to trade perps on lighter",
        "fund my lighter account",
        "finish lighter setup",
      ],
    },
    {
      label: "Markets and system",
      summary: "Check Lighter environment status/config and list or inspect public markets.",
      toolPrefixes: ["lighter.system", "lighter.markets", "lighter.market"],
      hints: ["lighter status", "lighter markets", "market id", "core config", "rhc config"],
    },
    {
      label: "Depth and trade tape",
      summary: "Read public order book depth and recent trades for one Lighter market.",
      toolPrefixes: ["lighter.orderbook", "lighter.recentTrades"],
      hints: ["order book", "bid ask depth", "recent trades", "latest fills", "trade tape"],
    },
    {
      label: "Candles",
      summary: "Read OHLCV candle history for one Lighter market using epoch-millisecond windows.",
      toolPrefixes: ["lighter.candles"],
      hints: ["candles", "ohlcv", "price history", "chart", "volatility"],
    },
    {
      label: "Accounts and positions",
      summary:
        "Read public Lighter account state, positions, and API-key metadata by account index or owning wallet address.",
      toolPrefixes: ["lighter.account", "lighter.positions", "lighter.apiKeys"],
      hints: [
        "lighter account",
        "lighter positions",
        "account collateral",
        "account by wallet address",
        "api key metadata",
      ],
    },
    {
      label: "My orders and fills",
      summary:
        "Read authenticated open orders, order history, and account trade fills using the configured read-only token.",
      toolPrefixes: ["lighter.openOrders", "lighter.orderHistory", "lighter.trades"],
      hints: [
        "my open orders",
        "lighter order history",
        "my fills",
        "account trades",
        "resting orders",
      ],
    },
    {
      label: "Order preview and approval-gated create",
      summary:
        "Preview an exact Lighter order from live data, then prepare and place it only through the user-approved card.",
      toolPrefixes: ["lighter.order"],
      hints: [
        "preview lighter order",
        "limit buy on lighter",
        "place lighter order",
        "prepare trade approval",
        "approval gated order",
      ],
    },
    {
      label: "Secure withdrawals and claims",
      summary:
        "Prepare, execute, and reconcile approval-gated Core USDC or RHC USDG withdrawals, including a separately approved gateway claim only when required.",
      toolPrefixes: ["lighter.withdraw"],
      hints: [
        "withdraw from lighter",
        "cash out lighter collateral",
        "withdraw rhc usdg",
        "check lighter withdrawal",
        "claim pending lighter withdrawal",
      ],
    },
  ],
};
