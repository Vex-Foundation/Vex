import type { ProtocolNamespaceNavigation } from "./types.js";

export const MARKET_PROTOCOL_NAVIGATION: readonly ProtocolNamespaceNavigation[] = [
  {
    namespace: "khalani",
    advertised: true,
    groupId: "cross-chain",
    groupLabel: "Cross-chain",
    summary: "Cross-chain bridge, token resolver, balances, quotes, and order tracking across EVM + Solana chains.",
    whenToUse:
      "Use when the task crosses chains or needs a canonical multi-chain token resolver, wallet balances, bridge quote, or bridge execution flow.",
    preferInstead:
      "Use `kyberswap` for EVM-only swaps/limit orders and `solana` for Solana-only swaps.",
    exampleQueries: [
      'discover_tools(query="token search", namespace="khalani")',
      'discover_tools(query="bridge quote", namespace="khalani")',
      'discover_tools(query="cross-chain order status", namespace="khalani")',
    ],
    aliases: ["bridge", "cross chain", "hyperstream", "multi chain token resolver"],
    discoveryHints: [
      "bridge quote",
      "cross-chain transfer",
      "token resolver",
      "balances across chains",
      "bridge order status",
    ],
    facets: [
      {
        label: "Chains and token resolution",
        summary: "List supported chains and resolve/search token metadata before any multi-chain or EVM mutation.",
        toolPrefixes: ["khalani.chains", "khalani.tokens"],
        hints: ["supported chains", "token search", "token autocomplete", "wallet balances"],
      },
      {
        label: "Bridge quotes and orders",
        summary: "Quote/execute cross-chain transfers and inspect bridge order lifecycle.",
        toolPrefixes: ["khalani.quote", "khalani.orders", "khalani.bridge"],
        hints: ["bridge quote", "bridge usdc", "order status", "cross-chain bridge"],
      },
    ],
  },
  {
    namespace: "relay",
    advertised: true,
    groupId: "cross-chain",
    groupLabel: "Cross-chain",
    summary: "Keyless cross-chain bridge (Relay) — the ONLY bridge to/from Robinhood Chain (4663); also bridges across its wider chain registry.",
    whenToUse:
      "Use to bridge funds to or from Robinhood Chain (Khalani does not cover 4663): bridge ETH/USDG/VIRTUAL in to fund trading, or bridge back out, then swap on-chain via uniswap.",
    preferInstead:
      "Use `khalani` for bridges between its supported chains; use `relay` whenever either side is Robinhood Chain (or Khalani lacks the route).",
    exampleQueries: [
      'discover_tools(query="bridge to robinhood", namespace="relay")',
      'discover_tools(query="bridge quote relay", namespace="relay")',
      'discover_tools(query="bridge out of robinhood", namespace="relay")',
    ],
    aliases: ["relay", "bridge to robinhood", "bridge from robinhood", "fund robinhood"],
    discoveryHints: ["bridge to robinhood", "bridge from robinhood", "relay bridge quote", "fund robinhood wallet"],
    facets: [
      {
        label: "Bridge quotes and execution",
        summary: "Quote/execute keyless cross-chain bridges to and from Robinhood Chain and Relay's other chains.",
        toolPrefixes: ["relay.quote", "relay.bridge"],
        hints: ["bridge quote", "bridge to robinhood", "bridge eth", "cross-chain transfer"],
      },
    ],
  },
  {
    namespace: "kyberswap",
    advertised: true,
    groupId: "evm-trading",
    groupLabel: "EVM Trading",
    summary: "EVM-only swaps, limit orders, zap liquidity, and token safety checks across KyberSwap routes.",
    whenToUse:
      "Use when the user wants EVM execution on an existing chain: swap, place/fill/cancel limit orders, zap into liquidity, or run honeypot/FOT checks.",
    preferInstead:
      "Use `khalani` to resolve cross-chain token addresses first, `solana` for Solana trading, and `dexscreener` for read-only research.",
    exampleQueries: [
      'discover_tools(query="swap on base", namespace="kyberswap")',
      'discover_tools(query="limit order", namespace="kyberswap")',
      'discover_tools(query="zap liquidity", namespace="kyberswap")',
    ],
    aliases: ["kyber", "evm swap", "limit order", "zap liquidity"],
    discoveryHints: ["swap on ethereum", "limit order", "fill order", "zap liquidity", "honeypot check"],
    facets: [
      {
        label: "Chains and token safety",
        summary: "Inspect supported chains, search token metadata, and run honeypot/FOT safety checks.",
        toolPrefixes: ["kyberswap.chains", "kyberswap.tokens"],
        hints: ["supported evm chains", "token search", "honeypot", "fee on transfer"],
      },
      {
        label: "Swaps",
        summary: "Quote or execute routed swaps on EVM chains after token resolution.",
        toolPrefixes: ["kyberswap.swap"],
        hints: ["swap quote", "sell token", "buy token", "route build"],
      },
      {
        label: "Limit orders",
        summary: "Create, list, cancel, hard-cancel, or fill gasless limit orders.",
        toolPrefixes: ["kyberswap.limitOrder"],
        hints: ["limit order", "cancel order", "fill order", "active making amount"],
      },
      {
        label: "Zaps and LP",
        summary: "Search pools and zap in/out/migrate concentrated-liquidity positions.",
        toolPrefixes: ["kyberswap.zap"],
        hints: ["zap liquidity", "lp position", "migrate lp", "pool search"],
      },
    ],
  },
  {
    namespace: "uniswap",
    advertised: true,
    groupId: "evm-trading",
    groupLabel: "EVM Trading",
    summary: "Keyless on-chain Uniswap V2/V3 swaps (best route). An all-EVM fallback for KyberSwap, including on Robinhood Chain (4663) — where $VEX and Virtuals agent tokens trade against VIRTUAL.",
    whenToUse:
      "Use as a fallback on any EVM chain when KyberSwap is unavailable or lacks a route, including Robinhood Chain (quote/sell/buy against VIRTUAL/ETH). Pass token contract ADDRESSES (no symbol search).",
    preferInstead:
      "Prefer `kyberswap` on the chains it supports (aggregated pricing + token safety flags), incl. Robinhood Chain; use `uniswap` when Kyber lacks the chain/route.",
    exampleQueries: [
      'discover_tools(query="swap on robinhood", namespace="uniswap")',
      'discover_tools(query="uniswap quote", namespace="uniswap")',
      'discover_tools(query="buy vex with virtual", namespace="uniswap")',
    ],
    aliases: ["uniswap", "robinhood swap", "v2 v3 swap", "uniswap fallback"],
    discoveryHints: ["swap on robinhood", "uniswap quote", "buy on robinhood", "sell on robinhood", "virtual to vex"],
    facets: [
      {
        label: "Swaps",
        summary: "Quote or execute best-route V2/V3 swaps after resolving token addresses.",
        toolPrefixes: ["uniswap.swap"],
        hints: ["swap quote", "sell token", "buy token", "robinhood swap", "best route v2 v3"],
      },
    ],
  },
  {
    namespace: "pendle",
    advertised: true,
    groupId: "evm-trading",
    groupLabel: "EVM Trading",
    summary:
      "Pendle yield trading across 11 chains (Ethereum, Arbitrum, Base, BSC, and more) — principal tokens (PT) lock a FIXED rate until expiry; yield tokens (YT) are VARIABLE, leveraged yield that DECAYS to zero at expiry. Discover markets, value positions, buy / sell / redeem PT, buy / sell YT, mint / redeem the PT+YT pair, add / remove single-token liquidity (LP), and claim accrued income through the pinned Pendle Router.",
    whenToUse:
      "Use when the user wants Pendle yield on any of its 11 chains: find markets by liquidity or implied APY, value holdings, buy a PT to lock a fixed rate, sell a PT early (market-priced), redeem a matured PT (~1:1), buy a YT for variable/leveraged yield (worth zero at expiry), sell a YT early, add or remove single-token liquidity (LP earns swap fees until expiry, not a fixed lock), or claim accrued interest and rewards. Preview PT/YT/LP actions with pendle.pt.quote / pendle.yt.quote / pendle.lp.quote first.",
    preferInstead:
      "Use `kyberswap`/`uniswap` for ordinary spot swaps; Pendle is specifically for term yield. A PT is fixed yield; a YT is variable and can lose money. Points programs are NOT a guaranteed yield.",
    exampleQueries: [
      'discover_tools(query="pendle fixed yield", namespace="pendle")',
      'discover_tools(query="buy YT variable yield", namespace="pendle")',
      'discover_tools(query="claim pendle rewards", namespace="pendle")',
    ],
    aliases: ["pendle", "fixed yield", "variable yield", "principal token", "yield token", "PT", "YT"],
    discoveryHints: ["pendle fixed yield", "buy PT", "buy YT variable yield", "sell YT early", "claim pendle rewards", "implied apy"],
    facets: [
      {
        label: "Yield markets",
        summary: "Browse active Pendle markets ranked by liquidity or implied APY.",
        toolPrefixes: ["pendle.yields"],
        hints: ["fixed yield markets", "implied apy", "pendle liquidity", "PT maturities"],
      },
      {
        label: "PT trading",
        summary: "Quote, buy, early-exit sell, or redeem a Pendle principal token (fixed yield).",
        toolPrefixes: ["pendle.pt"],
        hints: ["quote PT", "buy PT", "sell PT early", "redeem matured PT", "lock fixed yield"],
      },
      {
        label: "YT trading",
        summary: "Quote, buy, or early-exit sell a Pendle yield token (variable yield, decays to zero at expiry).",
        toolPrefixes: ["pendle.yt"],
        hints: ["quote YT", "buy YT", "sell YT early", "variable yield", "leveraged yield"],
      },
      {
        label: "Mint and redeem (PT + YT)",
        summary: "Mint an EQUAL PT+YT pair from one token, or redeem the pair back to a token before expiry.",
        toolPrefixes: ["pendle.py"],
        hints: ["mint PT and YT", "split token into PT and YT", "redeem PT and YT before expiry", "unwind PT YT pair"],
      },
      {
        label: "Liquidity (LP)",
        summary: "Quote, add, or remove single-token Pendle liquidity (earns swap fees until expiry; not a fixed lock).",
        toolPrefixes: ["pendle.lp"],
        hints: ["add pendle liquidity", "provide single-token LP", "remove pendle liquidity", "withdraw pendle LP", "pendle pool fees"],
      },
      {
        label: "Positions and income",
        summary: "Value open positions, see which PT are redeemable, and claim accrued interest and rewards.",
        toolPrefixes: ["pendle.position", "pendle.claim"],
        hints: ["pendle positions", "PT holdings value", "redeemable PT", "claim rewards", "harvest yield"],
      },
    ],
  },
  {
    namespace: "solana",
    advertised: true,
    groupId: "solana",
    groupLabel: "Solana",
    summary: "Jupiter-backed Solana surface for token search, prices, swaps, lending, and prediction markets.",
    whenToUse:
      "Use when the task is Solana-only: resolve mints, fetch Jupiter prices, swap on Solana, inspect lend positions, or trade Jupiter prediction markets.",
    preferInstead:
      "Use `polymarket` for Polygon prediction markets, `khalani` for cross-chain bridging, and `kyberswap` for EVM-only execution.",
    exampleQueries: [
      'discover_tools(query="solana token search", namespace="solana")',
      'discover_tools(query="swap on solana", namespace="solana")',
      'discover_tools(query="solana prediction markets", namespace="solana")',
    ],
    aliases: ["jupiter", "solana swap", "solana lending", "solana prediction"],
    discoveryHints: ["token mint search", "solana swap", "jupiter price", "lend rates", "prediction market"],
    facets: [
      {
        label: "Core token and price lookup",
        summary: "Search Solana mints and fetch prices/trending token metadata.",
        toolPrefixes: ["solana.prices", "solana.tokens"],
        hints: ["token search", "token mint", "trending tokens", "price lookup"],
      },
      {
        label: "Swaps and lending",
        summary: "Quote/execute swaps and inspect deposit/withdraw lend positions.",
        toolPrefixes: ["solana.swap", "solana.lend"],
        hints: ["swap quote", "swap execute", "lend rates", "lend positions"],
      },
      {
        label: "Prediction markets",
        summary: "Browse, analyze, and trade Jupiter prediction markets on Solana.",
        toolPrefixes: ["solana.predict"],
        hints: ["prediction market", "buy yes", "sell shares", "market history"],
      },
    ],
  },
  {
    namespace: "polymarket",
    advertised: true,
    groupId: "prediction-markets",
    groupLabel: "Prediction Markets",
    summary: "Polymarket prediction-market surface for discovery, orderbook trading, positions, bridge flows, and rewards.",
    whenToUse:
      "Use when the user wants Polymarket on Polygon: browse markets/events, inspect the orderbook, place/cancel trades, read positions/activity, bridge funds, or inspect rewards.",
    preferInstead:
      "Use `solana` for Jupiter prediction markets and `dexscreener` for non-prediction token research.",
    exampleQueries: [
      'discover_tools(query="prediction market orderbook", namespace="polymarket")',
      'discover_tools(query="polymarket positions", namespace="polymarket")',
      'discover_tools(query="bridge funds to polymarket", namespace="polymarket")',
    ],
    aliases: ["prediction market", "orderbook market", "clob", "gamma", "polymarket"],
    discoveryHints: [
      "prediction market orderbook",
      "yes no market",
      "gamma market discovery",
      "positions and pnl",
      "bridge to polymarket",
      "rewards earnings",
    ],
    facets: [
      {
        label: "Gamma discovery",
        summary: "Browse/search events, markets, tags, comments, profiles, and sports metadata.",
        toolPrefixes: ["polymarket.gamma"],
        hints: ["gamma", "market discovery", "event search", "tag search", "sports metadata"],
      },
      {
        label: "CLOB trading",
        summary: "Read orderbooks/prices and place, cancel, or inspect orders and trades.",
        toolPrefixes: ["polymarket.clob"],
        hints: ["orderbook", "clob", "buy yes", "sell no", "cancel order", "price history"],
      },
      {
        label: "Portfolio and analytics",
        summary: "Read positions, activity, holders, open interest, and leaderboard data.",
        toolPrefixes: ["polymarket.data"],
        hints: ["positions", "activity", "holders", "open interest", "leaderboard", "pnl"],
      },
      {
        label: "Bridge",
        summary: "Inspect supported assets, bridge quote/status, deposit, and withdraw flows.",
        toolPrefixes: ["polymarket.bridge"],
        hints: ["bridge funds", "supported assets", "deposit address", "withdraw quote"],
      },
      {
        label: "Rewards",
        summary: "Inspect market/user rewards, earnings, and percentage snapshots.",
        toolPrefixes: ["polymarket.rewards"],
        hints: ["rewards", "earnings", "active rewards", "user markets"],
      },
    ],
  },
  {
    namespace: "dexscreener",
    advertised: true,
    groupId: "market-research",
    groupLabel: "Market Research",
    summary: "The market-discovery backbone: read-only, multi-chain DEX intelligence — search any token on any chain (chainId filter, including robinhood), resolve token addresses, verify pair liquidity/momentum, and read trending narratives, attention/boost signals, CTO signals, ads, and paid-order verification.",
    whenToUse:
      "Reach for it FIRST on any discovery or research step: search a token on any chain (optionally filtered by chainId such as robinhood, or by minimum liquidity), resolve its address before a trade, and verify the pair's liquidity and momentum. Separate genuine narratives (trending/meta) from paid attention (boost/attention signals), and check profiles, community takeovers, ads, or paid-order verification. Canonical flow: discover → resolve address → verify liquidity → quote.",
    preferInstead:
      "Use `kyberswap`, `solana`, or `khalani` for execution after the discovery step — DexScreener never executes.",
    exampleQueries: [
      'discover_tools(query="trending narratives", namespace="dexscreener")',
      'discover_tools(query="community takeover", namespace="dexscreener")',
      'discover_tools(query="pair liquidity research", namespace="dexscreener")',
    ],
    aliases: ["dex screener", "market research", "trending narratives", "attention signal", "cto"],
    discoveryHints: [
      "token search",
      "pair analytics",
      "trending narratives",
      "attention signal",
      "boosts",
      "community takeover",
      "order verification",
      "ads",
    ],
    facets: [
      {
        label: "Search and pair analytics",
        summary: "Search tokens/pairs (by chain/liquidity) and inspect pair detail or all pools for a token.",
        toolPrefixes: ["dexscreener.search", "dexscreener.pairs", "dexscreener.tokens", "dexscreener.tokenPairs"],
        hints: ["token search", "pair analytics", "price research", "all pools", "liquidity"],
      },
      {
        label: "Trending narratives, attention, and profiles",
        summary: "Browse official trending narratives/themes and their tokens, synthetic attention/boost signals, and token profiles.",
        toolPrefixes: [
          "dexscreener.trending",
          "dexscreener.meta",
          "dexscreener.attention",
          "dexscreener.profiles",
          "dexscreener.profiles.recent",
          "dexscreener.boosts",
          "dexscreener.boosts.top",
        ],
        hints: ["trending narratives", "trending metas", "attention signal", "token profiles", "boosts", "top boosts"],
      },
      {
        label: "Community takeovers and promotion checks",
        summary: "Track CTO signals plus ads and paid-order verification.",
        toolPrefixes: ["dexscreener.communityTakeovers", "dexscreener.orders", "dexscreener.ads"],
        hints: ["community takeover", "cto", "paid orders", "ads", "promotion"],
      },
    ],
  },
  {
    namespace: "hyperliquid",
    advertised: true,
    groupId: "perps",
    groupLabel: "Perpetuals",
    summary: "Hyperliquid Core perpetual and spot trading: market/account research, protected perp orders, leverage and margin controls, funding history, and spot orders.",
    whenToUse: "Use for Hyperliquid Core. Inspect market depth, funding, account margin, and existing stop coverage before any trade. Stop losses reduce risk but are not guaranteed fills during rapid moves or liquidation.",
    preferInstead: "Use EVM/Solana venue tools for on-chain swaps; Hyperliquid uses its own signed exchange actions and risk controls.",
    exampleQueries: [
      'discover_tools(query="my Hyperliquid positions", namespace="hyperliquid")',
      'discover_tools(query="open protected BTC perpetual", namespace="hyperliquid")',
      'discover_tools(query="Hyperliquid funding cost", namespace="hyperliquid")',
    ],
    aliases: ["hyperliquid", "hypercore", "perps", "perpetuals", "HL"],
    discoveryHints: ["perp position", "stop loss", "liquidation", "funding", "Hyperliquid order book"],
    facets: [
      { label: "Markets and account", summary: "Read Core/spot markets, L2 depth, account margin, positions, orders, fills, and funding.", toolPrefixes: ["hyperliquid.perp.markets", "hyperliquid.perp.positions", "hyperliquid.perp.orders", "hyperliquid.perp.fills", "hyperliquid.perp.funding", "hyperliquid.account", "hyperliquid.spot.markets", "hyperliquid.spot.balances", "hyperliquid.market.book"], hints: ["markets", "positions", "funding", "margin", "order book"] },
      { label: "Market analysis and candle scanning", summary: "Watch local candles, read coverage, or scan decimal-safe momentum, volume, moving-average, RSI, and range signals.", toolPrefixes: ["hyperliquid.market.watchCandles", "hyperliquid.market.candles", "hyperliquid.market.scan"], hints: ["watch candles", "RSI", "volume spike", "breakout", "moving average", "candle scan"] },
      { label: "Protected perpetual trading", summary: "Open, close, protect, amend, cancel, leverage, margin, or TWAP a Core perpetual under policy gates.", toolPrefixes: ["hyperliquid.perp.open", "hyperliquid.perp.close", "hyperliquid.perp.setTpsl", "hyperliquid.perp.modifyOrder", "hyperliquid.perp.cancelOrders", "hyperliquid.perp.setLeverage", "hyperliquid.perp.adjustMargin", "hyperliquid.perp.twap"], hints: ["open perp", "stop loss", "close position", "leverage", "TWAP"] },
      { label: "Spot trading", summary: "Place Hyperliquid spot orders after checking market and depth.", toolPrefixes: ["hyperliquid.spot.trade"], hints: ["spot order", "buy HYPE", "sell spot"] },
      { label: "Funding, transfers, and withdrawals", summary: "Deposit native USDC from Arbitrum, move USDC between spot and perp, send assets on HyperCore, or withdraw to Arbitrum — every egress stays approval-gated.", toolPrefixes: ["hyperliquid.deposit", "hyperliquid.transfer", "hyperliquid.withdraw"], hints: ["deposit to Hyperliquid", "move USDC to perp", "withdraw from Hyperliquid", "send USDC", "usd class transfer"] },
      { label: "Earn, staking, and account setup", summary: "Inspect or move funds in vaults incl. HLP, manage HYPE staking and delegation, claim rewards, propose session risk limits, and approve the builder fee.", toolPrefixes: ["hyperliquid.vault", "hyperliquid.staking", "hyperliquid.rewards", "hyperliquid.risk", "hyperliquid.builder"], hints: ["deposit to HLP", "stake HYPE", "claim rewards", "set risk limits", "builder fee"] },
      { label: "Hypervexing workspace", summary: "Enter or leave the focused local Hyperliquid workspace without changing trading state.", toolPrefixes: ["hyperliquid.workspace"], hints: ["Hypervexing", "workspace", "focused Hyperliquid view"] },
    ],
  },
  {
    namespace: "virtuals",
    advertised: true,
    groupId: "market-research",
    groupLabel: "Market Research",
    summary:
      "Read-only Virtuals Protocol agent-token intelligence — screen, inspect, and track agent tokens on Robinhood (chain 4663), Base, Solana, and Ethereum: status (bonding-curve UNDERGRAD vs graduated), holders, market cap in VIRTUAL, the anti-sniper buy-tax window, recent graduations, and the genesis launch calendar.",
    whenToUse:
      "Use to discover or vet a Virtuals agent token before trading it: list/screen agents on a chain, get one agent's full detail (ALWAYS before buying a graduated token — check the anti-sniper window; never buy while it is active), watch the 'what just graduated' feed, or browse the genesis launch calendar. Trades execute via the venue tool named in each result's tradingRoute hint (uniswap on Robinhood, kyberswap on Base/ETH, solana on Solana).",
    preferInstead:
      "Use `dexscreener` for general multi-chain pair/liquidity research and `uniswap`/`kyberswap`/`solana` to execute the trade — Virtuals never executes.",
    exampleQueries: [
      'discover_tools(query="list agent tokens on robinhood", namespace="virtuals")',
      'discover_tools(query="virtuals agent detail anti-sniper", namespace="virtuals")',
      'discover_tools(query="what just graduated", namespace="virtuals")',
    ],
    aliases: ["virtuals", "agent tokens", "virtuals protocol", "anti-sniper window", "agent token graduations"],
    discoveryHints: [
      "agent tokens on robinhood",
      "virtuals agent detail",
      "anti-sniper buy tax window",
      "recent graduations",
      "genesis launch calendar",
    ],
    facets: [
      {
        label: "Agent-token screening and detail",
        summary: "List/screen agent tokens on a chain and pull one agent's full detail, anti-sniper window, and trading route.",
        toolPrefixes: ["virtuals.list", "virtuals.get"],
        hints: ["agent tokens", "virtuals list", "agent detail", "anti-sniper window", "trading route"],
      },
      {
        label: "Graduations and launch calendar",
        summary: "Watch recently graduated agent tokens and browse the genesis launch calendar.",
        toolPrefixes: ["virtuals.graduations", "virtuals.geneses"],
        hints: ["recent graduations", "just graduated", "genesis calendar", "upcoming launches"],
      },
    ],
  },
] as const;
