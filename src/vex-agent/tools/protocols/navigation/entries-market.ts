import type { ProtocolNamespaceNavigation } from "./types.js";
import { getKyberChains } from "@tools/kyberswap/chains.js";

/**
 * Swap-supported EVM chain slugs for the kyberswap entry's `summary`,
 * derived from the LIVE registry at module load (owner add-on, 2026-07-23) —
 * never hand-written, so a future chain add/drop in `@tools/kyberswap/chains.ts`
 * flows into the built protocols prompt automatically. Filtered to
 * `aggregator: true` (the feature `kyberswap.swap.execute` actually needs),
 * not just "every registry entry," so a hypothetical future chain added for a
 * different feature without aggregator support is correctly excluded. Kept
 * reveal-consistent (Agent Scan plan v3 §11.2 / C30): this line names ONLY
 * KyberSwap chains — it must never mention Uniswap; the existing "if
 * KyberSwap cannot route, a backup venue is offered automatically in the
 * failure message" wording already covers the off-registry case.
 */
const KYBER_SWAP_EXECUTE_CHAIN_SLUGS: readonly string[] = getKyberChains()
  .filter((chain) => chain.aggregator)
  .map((chain) => chain.slug);

export const MARKET_PROTOCOL_NAVIGATION: readonly ProtocolNamespaceNavigation[] = [
  {
    namespace: "khalani",
    advertised: true,
    groupId: "cross-chain",
    groupLabel: "Cross-chain",
    summary: "Cross-chain bridge, token resolver, balances, quotes, and order tracking across EVM + Solana chains.",
    whenToUse:
      "Use when the task crosses chains or needs multi-chain token resolution, wallet balances, a bridge quote, or a bridge execution flow. Token resolution is exposed as the `token_find` shortcut — prefer it. The full khalani toolset is listable with discover_tools for this namespace.",
    preferInstead:
      "Use `kyberswap` for EVM-only swaps and `solana` for Solana-only swaps.",
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
      "Use to bridge funds to or from Robinhood Chain (Khalani does not cover 4663): bridge ETH/USDG/VIRTUAL in to fund trading, or bridge back out.",
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
    summary: `EVM-only swaps and token safety checks across KyberSwap routes. Swap-supported EVM chains: ${KYBER_SWAP_EXECUTE_CHAIN_SLUGS.join(", ")}.`,
    whenToUse:
      "Use when the user wants EVM execution on an existing chain: swap, or run honeypot/FOT checks.",
    preferInstead:
      "Use `khalani` to resolve cross-chain token addresses first, `solana` for Solana trading, and `dexscreener` for read-only research.",
    exampleQueries: [
      'discover_tools(query="swap on base", namespace="kyberswap")',
      'discover_tools(query="check token honeypot", namespace="kyberswap")',
    ],
    aliases: ["kyber", "evm swap", "honeypot check"],
    discoveryHints: ["swap on ethereum", "honeypot check", "fee on transfer"],
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
    ],
  },
  {
    // Agent Scan plan v3 §11.2 (FIX3-W7, Codex final-review round 2 finding 2
    // / C30): Uniswap is the HIDDEN fallback pair, session-reveal-gated. It
    // must not be statically advertised anywhere — `advertised: false` here
    // is the single source of truth that removes it from
    // `PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST` (catalog.ts derives that list
    // FROM this flag), `buildDiscoverNamespaceDescription()`'s static schema
    // text, `discoverProtocolCapabilities`'s candidate filter (so it never
    // surfaces via discover_tools even for a revealed session — the sanctioned
    // path there is the `swap_quote_uniswap`/`swap_execute_uniswap` internal
    // aliases, not generic discovery), and the built `# Available Protocol
    // Namespaces` prompt section. `executeProtocolTool`'s OWN reveal gate
    // (`REVEAL_GATED_UNISWAP_TOOL_IDS` + `isUniswapPairRevealed`, in
    // `runtime.ts`) is independent of this flag and still allows a revealed
    // session's alias-routed execute_tool dispatch through.
    namespace: "uniswap",
    advertised: false,
    groupId: "evm-trading",
    groupLabel: "EVM Trading",
    summary: "Keyless on-chain Uniswap V2/V3 swaps (best route). An all-EVM fallback for KyberSwap, including on Robinhood Chain (4663) — where $VEX and Virtuals agent tokens trade against VIRTUAL.",
    whenToUse:
      "Use as a fallback on any EVM chain when KyberSwap is unavailable or lacks a route, including Robinhood Chain (quote/execute against VIRTUAL/ETH). Pass token contract ADDRESSES (no symbol search).",
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
      "Pendle term-yield markets across 11 chains (Ethereum, Arbitrum, Base, BSC, and more): discover and inspect markets (rates, APY history, candles, order-book depth), value positions, trade fixed-rate principal tokens (PT) and variable yield tokens (YT), mint/redeem the PT+YT pair, wrap/unwrap SY, provide or move single-token liquidity, roll a PT to a later maturity, and claim accrued income.",
    whenToUse:
      "Use for any Pendle term-yield intent on its 11 chains: find or inspect a market, lock or exit a fixed rate (PT), take variable yield (YT), LP in/out (including the dual-instrument variants), extend or move a term (pendle.pt.rollover / pendle.lp.transfer / pendle.lp.toPt), wrap/unwrap SY, or claim income. The PT/YT/LP/SY rules — including quote-first and dryRun-first — live in the Fixed Yield (Pendle) doctrine below.",
    preferInstead:
      "Use `kyberswap` for ordinary spot swaps; Pendle is specifically for term yield.",
    exampleQueries: [
      'discover_tools(query="pendle fixed yield", namespace="pendle")',
      'discover_tools(query="buy YT variable yield", namespace="pendle")',
      'discover_tools(query="claim pendle rewards", namespace="pendle")',
    ],
    aliases: ["pendle", "fixed yield", "variable yield", "principal token", "yield token", "PT", "YT"],
    discoveryHints: [
      "pendle fixed yield",
      "buy PT",
      "buy YT variable yield",
      "sell YT early",
      "claim pendle rewards",
      "implied apy",
      "roll my PT to a later expiry",
      "extend my fixed rate",
      "move my pendle liquidity",
      "turn my LP into PT",
    ],
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
        summary:
          "Quote, add, or remove single-token Pendle liquidity (earns swap fees until expiry; not a fixed lock). Two-output variants are under Dual-leg liquidity; moving or converting an existing LP is under Move a position.",
        toolPrefixes: ["pendle.lp"],
        hints: ["add pendle liquidity", "provide single-token LP", "remove pendle liquidity", "withdraw pendle LP", "pendle pool fees"],
      },
      {
        label: "Dual-leg liquidity",
        summary:
          "Liquidity actions that produce TWO instruments instead of one: remove into a plain token AND the market's PT, or add with one token and KEEP the YT the deposit produces. Both deposits are still SINGLE-token — Pendle has no two-token add.",
        toolPrefixes: ["pendle.lp.removeDual", "pendle.lp.addKeepYt"],
        hints: [
          "remove pendle liquidity into a token and PT",
          "exit pendle LP but keep the principal token",
          "add pendle liquidity and keep the YT",
          "provide pendle LP without selling the yield token",
        ],
      },
      {
        label: "Move a position (term mobility)",
        summary:
          "Move a Pendle position between maturities or between position types in ONE transaction, without withdrawing to a token first: roll a PT into a later-expiry PT, move LP from one market's pool to another, or convert LP into the SAME market's PT. The source may be matured; the destination may not.",
        toolPrefixes: ["pendle.pt.rollover", "pendle.lp.transfer", "pendle.lp.toPt"],
        hints: [
          "roll my pendle PT into a later expiry",
          "extend my fixed rate",
          "move my pendle liquidity to another market",
          "turn my pendle LP into PT",
          "my pendle position is about to expire",
        ],
      },
      {
        label: "SY wrap and unwrap",
        summary:
          "Wrap a plain token into Pendle SY (the standardised-yield form PT and YT are minted from), or unwrap SY back to a token. This is also the recovery path when a matured PT redeem falls back to paying SY instead of the market's underlying.",
        toolPrefixes: ["pendle.sy"],
        hints: ["wrap into pendle SY", "unwrap pendle SY", "standardised yield token", "my pendle redeem paid SY", "turn SY back into a token"],
      },
      {
        label: "Market detail and history",
        summary:
          "Inspect ONE market — its legs, expiry, accepted tokens and current rates — plus its APY/TVL history and price candles. Resolves MATURED markets, which the trading tools cannot see.",
        toolPrefixes: ["pendle.market"],
        hints: ["pendle market details", "which tokens does this market accept", "implied apy history", "PT price chart", "when does this PT expire"],
      },
      {
        label: "Order-book depth",
        summary:
          "See the resting limit orders on a market. Vex quotes through the automated market maker only, so this is the price quality being forgone, not depth Vex can fill.",
        toolPrefixes: ["pendle.orderbook"],
        hints: ["pendle order book", "pendle depth", "better price than the quote", "resting pendle orders"],
      },
      {
        label: "Asset prices",
        summary: "Dollar price marks for Pendle PT, YT, LP and SY assets on one chain, including ones the wallet does not hold. Display marks, not executable quotes.",
        toolPrefixes: ["pendle.prices"],
        hints: ["what is this PT worth", "price a pendle token", "pendle asset price"],
      },
      {
        label: "Positions and income",
        summary:
          "Value open PT, YT, LP and SY positions, see which are redeemable or removable, claim accrued interest and rewards, and read merkle reward accruals (readable, but claimable only on Pendle's own site).",
        toolPrefixes: ["pendle.position", "pendle.claim", "pendle.rewards"],
        hints: ["pendle positions", "PT holdings value", "redeemable PT", "claim rewards", "harvest yield", "pending pendle rewards", "unclaimed incentives"],
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
      "Use `khalani` for cross-chain bridging and `kyberswap` for EVM-only execution.",
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
    namespace: "dexscreener",
    advertised: true,
    groupId: "market-research",
    groupLabel: "Market Research",
    summary:
      "Vex's read-only market-research backbone and source of truth for DexScreener-indexed AMM "
      + "pairs, including robinhood, and DexScreener's own profile/promotion labels. Research flow: "
      + "discover → resolve the address with `token_find` → verify liquidity → quote on a venue. "
      + "It does not establish contract safety, token identity from a ticker, complete market "
      + "coverage, or an executable price.",
    whenToUse:
      "Route exactly: token address + chain -> `tokenPairs`; name/symbol -> `search`, select the exact chain + contract address, then `tokenPairs`; pool address + chain -> `pairs`; multiple addresses on one chain -> `tokens`; narrative -> `trending`, then `meta`; promotion -> `boosts`/`ads`, then per-token `orders`. Profiles report metadata updates, not token creation; CTO is a provider label, not proof. Trending/meta are live undocumented feeds influenced by engagement and promotion, not organic or genuine rankings.",
    preferInstead:
      "Use a dedicated chain safety tool for contract risk. For execution, always request a fresh quote from `kyberswap`, `solana`, or the chosen venue; never treat a DexScreener price as executable.",
    exampleQueries: [
      'discover_tools(query="trending narratives", namespace="dexscreener")',
      'discover_tools(query="community takeover", namespace="dexscreener")',
      'discover_tools(query="pair liquidity research", namespace="dexscreener")',
    ],
    aliases: ["dex screener", "market research", "trending narratives", "cto"],
    discoveryHints: [
      "token search",
      "pair analytics",
      "trending narratives",
      "boosts",
      "community takeover",
      "order verification",
      "ads",
    ],
    facets: [
      {
        label: "Search and pair analytics",
        summary: "Resolve a name/symbol to an exact chain + address, inspect a known pool, list one token's pools, or batch known addresses.",
        toolPrefixes: ["dexscreener.search", "dexscreener.pairs", "dexscreener.tokens", "dexscreener.tokenPairs"],
        hints: ["token search", "pair analytics", "price research", "all pools", "liquidity"],
      },
      {
        label: "Trending narratives and profiles",
        summary: "Browse live undocumented engagement/promotion-influenced narratives and profile metadata updates. Use attention only for an explicit request for Vex's synthetic profile-plus-boost merge.",
        toolPrefixes: [
          "dexscreener.trending",
          "dexscreener.meta",
          "dexscreener.attention",
          "dexscreener.profiles",
          "dexscreener.profiles.recent",
          "dexscreener.boosts",
          "dexscreener.boosts.top",
        ],
        hints: ["trending narratives", "trending metas", "synthetic profile boost merge", "token profiles", "boosts", "top boosts"],
      },
      {
        label: "Community takeovers and promotion checks",
        summary: "Read DexScreener CTO labels and inspect boosts, ads, and per-token promotion orders without inferring safety or demand.",
        toolPrefixes: ["dexscreener.communityTakeovers", "dexscreener.orders", "dexscreener.ads"],
        hints: ["community takeover", "cto", "paid orders", "ads", "promotion"],
      },
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
      "Use to discover or vet a Virtuals agent token before trading it: list/screen agents on a chain, get one agent's full detail, watch the 'what just graduated' feed, or browse the genesis launch calendar. The trading rules live in the Virtuals Agent Tokens doctrine below.",
    preferInstead:
      "Use `dexscreener` for general multi-chain pair/liquidity research, and `swap_quote`/`swap_execute` (or `solana.*` on Solana) to execute the trade — Virtuals never executes.",
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
  {
    namespace: "trench",
    advertised: true,
    groupId: "evm-trading",
    groupLabel: "EVM Trading",
    summary:
      "Trade, research, and launch Trench Express bonding-curve tokens on Robinhood Chain (4663): buy a token with ETH or sell it back for ETH against the curve (quote first, then execute), browse bonding-curve and graduated tokens, search by name or symbol, read a token's recent trade tape, dry-run a launch to preview the predicted address, creation fee, and gas cost — or launch a real token (user-filled form, or direct execution under mission autonomy) and review your own past launches. A graduated token has left the bonding curve for a WETH-paired DEX pool on Robinhood Chain — its poolId and pool currencies are surfaced on the row. ETH curve only — no token/VEX pair exists on-chain today.",
    whenToUse:
      "Use to trade, vet, or launch Trench Express launchpad tokens: quote and then buy or sell a bonding-curve token, list what just launched or graduated, search for a named token, inspect its trade tape, preview what launching a new token would cost, or actually launch one and review your past launches. Trades and launches spend real ETH and are approval- or autonomy-gated; a launch requires an image the user pre-staged in the app.",
    preferInstead:
      "Use `kyberswap` to trade tokens that already trade in a standard AMM pool, and `dexscreener` for broader pair research. A graduated Trench token trades in a WETH-paired DEX pool on Robinhood Chain; where that pool is indexed, research it with `dexscreener`. `virtuals` is a different launchpad (VIRTUAL-paired agent tokens) — Trench tokens never appear there.",
    exampleQueries: [
      'discover_tools(query="buy a trench bonding curve token with ETH", namespace="trench")',
      'discover_tools(query="new token launches on trench", namespace="trench")',
      'discover_tools(query="preview a token launch cost", namespace="trench")',
    ],
    aliases: ["trench", "trench express", "trench launchpad", "trench token launches", "trench curve trading", "buy trench token"],
    discoveryHints: [
      "buy a trench bonding curve token",
      "sell a trench launchpad token for eth",
      "new token launches on trench",
      "trench bonding curve tokens",
      "trench launchpad trade tape",
      "robinhood launchpad tokens",
    ],
    facets: [
      {
        label: "Trench curve trading (buy/sell)",
        summary: "Quote then buy a Trench bonding-curve token with ETH, or sell it back for ETH, with a Vex-derived minimum-output floor.",
        toolPrefixes: ["trench.trade_quote", "trench.trade_execute"],
        hints: ["buy trench token with eth", "sell trench token for eth", "quote a trench curve trade", "trench bonding curve buy", "trench bonding curve sell"],
      },
      {
        label: "Trench launchpad token browsing and search",
        summary: "List and screen Trench Express bonding-curve and graduated tokens, or look one up by name or symbol.",
        toolPrefixes: ["trench.tokens", "trench.search"],
        hints: ["trench launchpad tokens", "new trench launches", "trench bonding curve", "trench token lookup", "trench token by symbol"],
      },
      {
        label: "Trench trade tape and launch preview",
        summary: "Read a Trench token's recent trade tape and dry-run a Trench token launch to preview address, fee, and gas cost.",
        toolPrefixes: ["trench.trades", "trench.launch_preview"],
        hints: ["trench trade tape", "recent trench trades", "trench launch preview", "create trench token cost", "dry run trench launch"],
      },
      {
        label: "Launching a token on Trench",
        summary:
          "Create a token on the Trench bonding curve, and review the ones already launched. A launch REQUIRES an image the user pre-staged in the app; the agent cannot supply one.",
        toolPrefixes: ["trench.launch_request_form", "trench.launch_execute", "trench.my_launches", "trench.images"],
        hints: [
          "launch a token on trench",
          "create a memecoin",
          "deploy a token",
          "my launched tokens",
          "trench launch images",
          "pick a launch image",
        ],
      },
    ],
  },
] as const;
