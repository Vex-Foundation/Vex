/**
 * AUTHORED display titles for every tool the Vex Studio MCP surface exports
 * (owner decision O6). ONE artifact, reviewed as product copy.
 *
 * A title is what a client shows in a picker, a permission prompt or an
 * approval row, usually with no room for the description underneath it. So each
 * one names THE ACTION and THE RESOURCE in a few words, in the imperative, and
 * is distinct from every other title in this file - a list where four rows all
 * read "Swap tokens" is a list a user cannot choose from.
 *
 * Honest about consequence: a title that broadcasts a signed transaction says
 * so ("Swap tokens on Uniswap" is a preview; "Execute a Uniswap swap" is not).
 * The annotations carry the machine-readable version of the same fact
 * (`inventory/annotations.ts`), and the two must never disagree.
 *
 * COMPLETENESS IS ENFORCED, not trusted: `inventory/index.ts` throws when an
 * exported tool has no entry here, and the lint suite fails on an entry for a
 * tool that is not exported. Adding a tool to the export scope therefore means
 * authoring its title in the same change, which is the review this file exists
 * to force.
 *
 * Keyed by PUBLIC NAME - the name the external agent calls - so a row can be
 * checked against a client transcript without a second lookup.
 */

/** Public tool name -> authored title. */
export const STUDIO_TOOL_TITLES: Readonly<Record<string, string>> = {
  // ── Internal tools ────────────────────────────────────────────────────────
  vex_ToolSearch: "Search the protocol tool catalog",
  vex_ToolDescribe: "Read one tool's whole contract",
  TokenFind: "Find a token's address and decimals",
  SwapQuote: "Quote a token swap",
  SwapExecute: "Execute a token swap",
  SwapQuoteUniswap: "Quote a Uniswap swap",
  SwapExecuteUniswap: "Execute a Uniswap swap",
  BridgeExecute: "Execute a cross-chain bridge",
  TokenCheck: "Check an EVM token for honeypot and tax",
  BridgeStatus: "Check a bridge order's status",
  BridgeQuote: "Quote a cross-chain bridge",
  BridgeQuoteRelay: "Quote a Relay bridge",
  BridgeExecuteRelay: "Execute a Relay bridge",
  TwitterAccount: "Read Twitter accounts and posts",
  AgentScan: "Review this wallet's recorded activity",
  ChainRead: "Read raw EVM chain data",
  WalletBalances: "Read wallet balances across chains",
  WalletTrackToken: "Track a token in the local wallet view",
  WalletSendPrepare: "Prepare a wallet transfer",
  WalletSendConfirm: "Broadcast a prepared wallet transfer",
  WalletEvmTransactionPrepare: "Prepare an EVM transaction",
  WalletEvmTransactionConfirm: "Broadcast a prepared EVM transaction",
  WalletSolanaTransactionPrepare: "Prepare a Solana transaction",
  WalletSolanaTransactionConfirm: "Broadcast a prepared Solana transaction",
  WalletWrapPrepare: "Prepare a native / wrapped-native conversion",
  WalletWrapConfirm: "Broadcast a prepared wrap or unwrap",
  UnitsConvert: "Convert token amounts and units",

  // ── khalani ───────────────────────────────────────────────────────────────
  khalani__chains_list: "List Khalani bridge chains",
  khalani__tokens_top_list: "List top bridged tokens on Khalani",
  khalani__tokens_search: "Search Khalani tokens",
  khalani__tokens_autocomplete: "Parse a token phrase into Khalani tokens",
  khalani__token_balances_get: "Read Khalani-chain wallet balances",
  khalani__bridge_quote_get: "Quote a Khalani bridge",
  khalani__orders_list: "List Khalani bridge orders",
  khalani__order_get: "Read one Khalani bridge order",
  khalani__bridge_execute: "Execute a Khalani bridge",

  // ── solana ────────────────────────────────────────────────────────────────
  solana__token_prices_get: "Read Solana token prices",
  solana__tokens_search: "Search Solana tokens by name",
  solana__tokens_discover: "Discover new and trending Solana tokens",
  solana__swap_quote: "Quote a Jupiter swap",
  solana__swap_execute: "Execute a Jupiter swap",
  solana__predict_events_discover: "Browse Jupiter prediction events",
  solana__predict_events_search: "Search Jupiter prediction events",
  solana__predict_market_get: "Read one Jupiter prediction market",
  solana__predict_positions_list: "List open Jupiter prediction positions",
  solana__predict_trade_history_list: "Read Jupiter prediction trade history",
  solana__predict_buy: "Buy Jupiter prediction shares",
  solana__predict_sell: "Sell a Jupiter prediction position",
  solana__predict_claim: "Claim a resolved Jupiter prediction payout",
  solana__predict_close_all: "Close every Jupiter prediction position",
  solana__predict_event_get: "Read one Jupiter prediction event",
  solana__predict_position_get: "Read one Jupiter prediction position",
  solana__predict_orderbook_get: "Read Jupiter prediction order-book depth",
  solana__predict_trading_status_get: "Check Jupiter prediction trading status",
  solana__predict_orders_list: "List Jupiter prediction orders",
  solana__predict_order_get: "Read one live Jupiter prediction order",
  solana__predict_order_status_get: "Read a Jupiter prediction order's fill status",
  solana__predict_trades_list: "Browse the global Jupiter prediction trade feed",
  solana__predict_profile_get: "Read a Jupiter prediction trader profile",
  solana__predict_pnl_history_get: "Read Jupiter prediction realized-PnL history",
  solana__predict_leaderboard_list: "Rank Jupiter prediction traders",
  solana__predict_vault_get: "Read the Jupiter prediction protocol vault",
  solana__predict_suggested_events_list: "Suggest Jupiter prediction events for a wallet",
  solana__lend_earn_rates_list: "Screen Jupiter Lend earn markets",
  solana__lend_earn_positions_list: "List Jupiter Lend earn positions",
  solana__lend_earn_deposit: "Deposit into a Jupiter Lend earn vault",
  solana__lend_earn_withdraw: "Withdraw from a Jupiter Lend earn vault",
  solana__lend_borrow_vaults_list: "Screen Jupiter Lend borrow vaults",
  solana__lend_borrow_positions_list: "List Jupiter Lend borrow positions",
  solana__lend_borrow_operate: "Adjust a Jupiter Lend borrow position",

  // ── kyberswap ─────────────────────────────────────────────────────────────
  kyberswap__chains_list: "List KyberSwap chains",
  kyberswap__token_safety_check: "Audit an EVM token with KyberSwap",
  kyberswap__swap_quote: "Quote a KyberSwap swap",
  kyberswap__swap_execute: "Execute a KyberSwap swap",

  // ── uniswap ───────────────────────────────────────────────────────────────
  uniswap__swap_quote: "Quote a Uniswap V2/V3 route",
  uniswap__swap_execute: "Execute a Uniswap V2/V3 swap",

  // ── relay ─────────────────────────────────────────────────────────────────
  relay__bridge_quote_get: "Quote a Relay cross-chain bridge",
  relay__bridge_execute: "Execute a Relay cross-chain bridge",

  // ── dexscreener ───────────────────────────────────────────────────────────
  dexscreener__pairs_search: "Search DEX pairs",
  dexscreener__token_pairs_list: "List a token's DEX pools",
  dexscreener__narratives_list: "List trending DEX Screener narratives",
  dexscreener__pairs_trending_list: "List trending DEX pairs",
  dexscreener__pairs_top_list: "Rank DEX pairs by a metric",
  dexscreener__gainers_list: "List top-gaining DEX pairs",
  dexscreener__losers_list: "List top-losing DEX pairs",
  dexscreener__pairs_new_list: "List newest DEX pairs",
  dexscreener__launchpad_pairs_list: "List launchpad pairs by stage",
  dexscreener__chains_list: "List DEX Screener chains",
  dexscreener__tokens_screen: "Screen tokens across chains",
  dexscreener__pair_get: "Read one pair's live state",
  dexscreener__spotlight_get: "Read the DEX Screener spotlight feeds",
  dexscreener__pairs_batch_get: "Batch-read pairs or tokens",
  dexscreener__pair_details_get: "Read a pair's safety report",
  dexscreener__candles_list: "Read a pair's OHLCV candles",
  dexscreener__trades_list: "List a pair's trades",
  dexscreener__top_traders_list: "Rank a pair's top wallets",

  // ── virtuals ──────────────────────────────────────────────────────────────
  virtuals__agents_discover: "Screen Virtuals agent tokens",
  virtuals__agent_get: "Read one Virtuals agent token",
  virtuals__graduations_list: "List recent Virtuals graduations",
  virtuals__genesis_launches_list: "Browse the Virtuals Genesis calendar",
  virtuals__agent_trades_list: "Read a Virtuals agent's curve trade tape",
  virtuals__agent_candles_list: "Read a Virtuals agent's price candles",
  virtuals__creator_fees_get: "Read a Virtuals agent creator's fee status",
  virtuals__agent_trade_quote: "Price a Virtuals bonding-curve trade",
  virtuals__agent_trade_execute: "Trade a Virtuals agent on its bonding curve",
  virtuals__agent_launch_preview: "Plan a Virtuals agent launch",
  virtuals__agent_launch_execute: "Launch a Virtuals agent",
  virtuals__agent_launch_status: "Check a Virtuals agent launch",
  virtuals__agent_launch_cancel: "Cancel a Virtuals agent launch",

  // ── pendle ────────────────────────────────────────────────────────────────
  pendle__markets_discover: "Screen Pendle yield markets",
  pendle__positions_get: "Value this wallet's Pendle positions",
  pendle__market_get: "Read one Pendle market",
  pendle__market_history_get: "Read a Pendle market's history",
  pendle__market_candles_get: "Read Pendle asset price candles",
  pendle__market_orderbook_get: "Read Pendle limit-order depth",
  pendle__merkle_rewards_list: "List claimable Pendle merkle rewards",
  pendle__asset_prices_get: "Read Pendle asset prices",
  pendle__pt_quote: "Quote a Pendle PT trade",
  pendle__pt_buy: "Buy a Pendle principal token",
  pendle__pt_sell: "Sell a Pendle principal token",
  pendle__pt_redeem: "Redeem a matured Pendle principal token",
  pendle__yt_quote: "Quote a Pendle YT trade",
  pendle__yt_buy: "Buy a Pendle yield token",
  pendle__yt_sell: "Sell a Pendle yield token",
  pendle__rewards_claim: "Claim accrued Pendle rewards",
  pendle__py_quote: "Quote a Pendle PT/YT mint or redeem",
  pendle__py_mint: "Mint a Pendle PT and YT pair",
  pendle__py_redeem: "Redeem a Pendle PT and YT pair early",
  pendle__lp_quote: "Quote a Pendle liquidity add or remove",
  pendle__lp_add: "Add single-token Pendle liquidity",
  pendle__lp_remove: "Remove Pendle liquidity to one token",
  pendle__sy_mint: "Wrap a token into Pendle SY",
  pendle__sy_redeem: "Unwrap Pendle SY back to a token",
  pendle__lp_remove_dual: "Remove Pendle liquidity to two tokens",
  pendle__lp_add_keep_yt: "Add Pendle liquidity and keep the YT",
  pendle__pt_rollover: "Roll a Pendle PT into a later expiry",
  pendle__lp_transfer: "Move Pendle liquidity between markets",
  pendle__lp_to_pt: "Convert Pendle liquidity into PT",

  // ── morpho ────────────────────────────────────────────────────────────────
  morpho__markets_discover: "Screen Morpho Blue lending markets",
  morpho__market_get: "Read one Morpho Blue market",
  morpho__vaults_discover: "Screen Morpho vaults",
  morpho__vault_get: "Read one Morpho vault",
  morpho__positions_get: "Read a wallet's Morpho positions",
  morpho__markets_activity_list: "Read Morpho market activity",
  morpho__rewards_get: "Read claimable Morpho rewards",
  morpho__wallet_balance_get: "Read on-chain balances for Morpho tokens",
  morpho__vault_quote: "Quote a Morpho vault deposit or withdrawal",
  morpho__vault_deposit: "Deposit into a Morpho vault",
  morpho__vault_withdraw: "Withdraw from a Morpho vault",
  morpho__market_quote: "Quote a Morpho Blue market operation",
  morpho__market_supply_collateral: "Supply collateral to a Morpho market",
  morpho__market_withdraw_collateral: "Withdraw collateral from a Morpho market",
  morpho__market_borrow: "Borrow from a Morpho market",
  morpho__market_repay: "Repay debt on a Morpho market",
  morpho__market_supply: "Supply the loan asset to a Morpho market",
  morpho__market_withdraw: "Withdraw a supply from a Morpho market",
  morpho__rewards_claim: "Claim earned Morpho rewards",


  // ── pools ─────────────────────────────────────────────────────────────────
  pools__tokens_discover: "Screen pools.fun tokens",
  pools__tokens_search: "Search pools.fun tokens",
  pools__token_candles_list: "Read pools.fun token candles",
  pools__token_get: "Read one pools.fun token",
  pools__my_launches_list: "List this wallet's pools.fun launches",
  pools__launch_preview: "Price a pools.fun launch",
  pools__launch_request_form: "Ask the user to confirm a pools.fun launch",
  pools__launch_execute: "Launch a token on pools.fun",
  pools__fees_claim: "Claim pools.fun creator fees",
  pools__launch_assets_list: "List pools.fun launchable stocks",
  pools__holder_rewards_get: "Read pools.fun holder rewards",
  pools__holder_rewards_claim: "Claim pools.fun holder rewards",
  pools__holder_rewards_distribute: "Distribute pools.fun holder rewards",
};
