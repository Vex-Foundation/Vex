import type { ProtocolNamespaceNavigation } from "../types.js";

export const PENDLE_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "pendle",
  advertised: true,
  groupId: "evm-trading",
  groupLabel: "EVM Trading",
  summary:
    "Where Vex trades TERM yield on 11 EVM chains: Pendle splits a yield-bearing asset into a principal token (PT), whose rate is FIXED until a maturity date, and a yield token (YT), whose yield is VARIABLE and decays to zero at that same expiry. Every position here has an expiry, and that date is what decides which action is possible on it.",
  whenToUse:
    "Use when the user wants a rate LOCKED to a date rather than one that floats: find or inspect a market and its implied APY, lock or exit a fixed rate with PT, take or exit variable yield with YT, mint or unwind the PT+YT pair, provide or move single-token liquidity, roll a position into a later maturity, wrap or unwrap SY, value what they already hold, or claim accrued income. Also use it whenever a Pendle position is nearing or past its expiry, because a matured position can only be redeemed or removed. The PT/YT/LP/SY rules - including quote-first and dryRun-first - live in the Fixed Yield (Pendle) doctrine below.",
  preferInstead:
    "Pendle is specifically for a FIXED rate locked to a maturity date: use `morpho` when the user wants a VARIABLE rate that floats with utilization and has no expiry, and `kyberswap` for an ordinary spot swap with no yield term at all.",
  exampleQueries: [
    'ToolSearch(query="pendle fixed yield", namespace="pendle")',
    'ToolSearch(query="buy YT variable yield", namespace="pendle")',
    'ToolSearch(query="claim pendle rewards", namespace="pendle")',
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
};
