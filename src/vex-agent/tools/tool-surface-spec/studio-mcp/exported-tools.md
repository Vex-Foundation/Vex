# Vex Studio MCP - exported tools

GENERATED FILE. Do not edit by hand.

Regenerate with `pnpm generate:studio-tools-doc`; CI runs the same command
with `--check` and fails when this file and the live inventory disagree.

Source of truth: `src/vex-agent/mcp/inventory/` (order, annotations,
always-load), `src/vex-agent/mcp/export-scope.ts` (which tools export) and
`src/vex-agent/mcp/inventory/titles.ts` (the authored titles).

The order below IS the `tools/list` order: internal tools byte-wise by name,
then protocol tools byte-wise by (namespace, name). It is identical for every
project, every client and every environment.

`read only` and `destructive` are the two MCP annotations Vex emits, pinned to
owner decision O7. `idempotentHint` and `openWorldHint` are deliberately
omitted rather than defaulted. `always load` is
`_meta["anthropic/alwaysLoad"]`. `requires env` travels on the wire as
`_meta["vex/requiresEnv"]`, an array of variable NAMES and never values. It
is metadata only: the list never varies by environment, and an unmet
variable is answered at call time with a typed `configuration_unavailable`
result naming the variable and the remedy.

`description bytes` is the length of the WHOLE description the tool exports.
Nothing is cut at the source; the budget lint asserts the risk class and the
preconditions appear inside the first 2000 bytes.

## Totals

- exported tools: 159
- internal: 25
- protocol: 134 across 11 namespaces
- always loaded: 25
- read-only: 103
- destructive: 49

## Internal tools

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AgentScan | Review this wallet's recorded activity | internal | yes | no | yes | - | 3661 |
| BridgeExecute | Execute a cross-chain bridge | internal | no | yes | yes | - | 1926 |
| BridgeExecuteRelay | Execute a Relay bridge | internal | no | yes | yes | - | 723 |
| BridgeQuote | Quote a cross-chain bridge | internal | yes | no | yes | - | 1260 |
| BridgeQuoteRelay | Quote a Relay bridge | internal | yes | no | yes | - | 578 |
| BridgeStatus | Check a bridge order's status | internal | yes | no | yes | - | 1297 |
| ChainRead | Read raw EVM chain data | internal | yes | no | yes | - | 1326 |
| SwapExecute | Execute a token swap | internal | no | yes | yes | - | 1630 |
| SwapExecuteUniswap | Execute a Uniswap swap | internal | no | yes | yes | - | 701 |
| SwapQuote | Quote a token swap | internal | yes | no | yes | - | 1321 |
| SwapQuoteUniswap | Quote a Uniswap swap | internal | yes | no | yes | - | 656 |
| TokenCheck | Check an EVM token for honeypot and tax | internal | yes | no | yes | - | 553 |
| TokenFind | Find a token's address and decimals | internal | yes | no | yes | - | 1051 |
| TwitterAccount | Read Twitter accounts and posts | internal | yes | no | yes | RETTIWT_API_KEY | 2803 |
| UnitsConvert | Convert token amounts and units | internal | yes | no | yes | - | 1397 |
| WalletBalances | Read wallet balances across chains | internal | yes | no | yes | - | 1576 |
| WalletEvmTransactionConfirm | Broadcast a prepared EVM transaction | internal | no | yes | yes | - | 1804 |
| WalletEvmTransactionPrepare | Prepare an EVM transaction | internal | no | no | yes | - | 2288 |
| WalletSendConfirm | Broadcast a prepared wallet transfer | internal | no | yes | yes | - | 1503 |
| WalletSendPrepare | Prepare a wallet transfer | internal | no | no | yes | - | 1252 |
| WalletSolanaTransactionConfirm | Broadcast a prepared Solana transaction | internal | no | yes | yes | - | 1273 |
| WalletSolanaTransactionPrepare | Prepare a Solana transaction | internal | no | no | yes | - | 1505 |
| WalletTrackToken | Track a token in the local wallet view | internal | no | no | yes | - | 971 |
| WebResearch | Search and read the web | internal | yes | no | yes | TAVILY_API_KEY | 2057 |
| vex_ToolSearch | Search the protocol tool catalog | internal | yes | no | yes | - | 1107 |

## Protocol tools

### dexscreener

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dexscreener__ads_list | List DEX Screener ad placements | protocol | yes | no | no | - | 1651 |
| dexscreener__attention_list | Rank tokens by DEX Screener attention | protocol | yes | no | no | - | 1973 |
| dexscreener__boosts_list | Read DEX Screener paid boosts | protocol | yes | no | no | - | 1990 |
| dexscreener__community_takeovers_list | List community-takeover tokens | protocol | yes | no | no | - | 2087 |
| dexscreener__narrative_get | Read one trending narrative | protocol | yes | no | no | - | 1529 |
| dexscreener__narratives_list | List trending DEX Screener narratives | protocol | yes | no | no | - | 2161 |
| dexscreener__pairs_get | Read one DEX pair | protocol | yes | no | no | - | 1271 |
| dexscreener__pairs_search | Search DEX pairs | protocol | yes | no | no | - | 1941 |
| dexscreener__profiles_list | Read DEX Screener token profiles | protocol | yes | no | no | - | 2338 |
| dexscreener__token_orders_list | List a token's paid promotion orders | protocol | yes | no | no | - | 1594 |
| dexscreener__token_pairs_list | List a token's DEX pools | protocol | yes | no | no | - | 2000 |
| dexscreener__tokens_get | Batch-price tokens on one chain | protocol | yes | no | no | - | 2418 |

### khalani

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| khalani__bridge_execute | Execute a Khalani bridge | protocol | no | yes | no | - | 2556 |
| khalani__bridge_quote_get | Quote a Khalani bridge | protocol | yes | no | no | - | 1844 |
| khalani__chains_list | List Khalani bridge chains | protocol | yes | no | no | - | 850 |
| khalani__order_get | Read one Khalani bridge order | protocol | yes | no | no | - | 990 |
| khalani__orders_list | List Khalani bridge orders | protocol | yes | no | no | - | 1066 |
| khalani__token_balances_get | Read Khalani-chain wallet balances | protocol | yes | no | no | - | 1109 |
| khalani__tokens_autocomplete | Parse a token phrase into Khalani tokens | protocol | yes | no | no | - | 964 |
| khalani__tokens_search | Search Khalani tokens | protocol | yes | no | no | - | 1253 |
| khalani__tokens_top_list | List top bridged tokens on Khalani | protocol | yes | no | no | - | 794 |

### kyberswap

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kyberswap__chains_list | List KyberSwap chains | protocol | yes | no | no | - | 776 |
| kyberswap__swap_execute | Execute a KyberSwap swap | protocol | no | yes | no | - | 2534 |
| kyberswap__swap_quote | Quote a KyberSwap swap | protocol | yes | no | no | - | 1675 |
| kyberswap__token_safety_check | Audit an EVM token with KyberSwap | protocol | yes | no | no | - | 1138 |

### morpho

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| morpho__market_borrow | Borrow from a Morpho market | protocol | no | yes | no | - | 2892 |
| morpho__market_get | Read one Morpho Blue market | protocol | yes | no | no | - | 2042 |
| morpho__market_quote | Quote a Morpho Blue market operation | protocol | yes | no | no | - | 2425 |
| morpho__market_repay | Repay debt on a Morpho market | protocol | no | yes | no | - | 3455 |
| morpho__market_supply | Supply the loan asset to a Morpho market | protocol | no | yes | no | - | 3959 |
| morpho__market_supply_collateral | Supply collateral to a Morpho market | protocol | no | yes | no | - | 2862 |
| morpho__market_withdraw | Withdraw a supply from a Morpho market | protocol | no | yes | no | - | 3270 |
| morpho__market_withdraw_collateral | Withdraw collateral from a Morpho market | protocol | no | yes | no | - | 2894 |
| morpho__markets_activity_list | Read Morpho market activity | protocol | yes | no | no | - | 3263 |
| morpho__markets_discover | Screen Morpho Blue lending markets | protocol | yes | no | no | - | 2961 |
| morpho__positions_get | Read a wallet's Morpho positions | protocol | yes | no | no | - | 4446 |
| morpho__rewards_claim | Claim earned Morpho rewards | protocol | no | yes | no | - | 2695 |
| morpho__rewards_get | Read claimable Morpho rewards | protocol | yes | no | no | - | 3189 |
| morpho__vault_deposit | Deposit into a Morpho vault | protocol | no | yes | no | - | 3288 |
| morpho__vault_get | Read one Morpho vault | protocol | yes | no | no | - | 3338 |
| morpho__vault_quote | Quote a Morpho vault deposit or withdrawal | protocol | yes | no | no | - | 4758 |
| morpho__vault_withdraw | Withdraw from a Morpho vault | protocol | no | yes | no | - | 2844 |
| morpho__vaults_discover | Screen Morpho vaults | protocol | yes | no | no | - | 6470 |
| morpho__wallet_balance_get | Read on-chain balances for Morpho tokens | protocol | yes | no | no | - | 3149 |

### pendle

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pendle__asset_prices_get | Read Pendle asset prices | protocol | yes | no | no | - | 1251 |
| pendle__lp_add | Add single-token Pendle liquidity | protocol | no | yes | no | - | 1755 |
| pendle__lp_add_keep_yt | Add Pendle liquidity and keep the YT | protocol | no | yes | no | - | 1271 |
| pendle__lp_quote | Quote a Pendle liquidity add or remove | protocol | yes | no | no | - | 971 |
| pendle__lp_remove | Remove Pendle liquidity to one token | protocol | no | yes | no | - | 1747 |
| pendle__lp_remove_dual | Remove Pendle liquidity to two tokens | protocol | no | yes | no | - | 1304 |
| pendle__lp_to_pt | Convert Pendle liquidity into PT | protocol | no | yes | no | - | 1927 |
| pendle__lp_transfer | Move Pendle liquidity between markets | protocol | no | yes | no | - | 1314 |
| pendle__market_candles_get | Read Pendle asset price candles | protocol | yes | no | no | - | 1083 |
| pendle__market_get | Read one Pendle market | protocol | yes | no | no | - | 1063 |
| pendle__market_history_get | Read a Pendle market's history | protocol | yes | no | no | - | 739 |
| pendle__market_orderbook_get | Read Pendle limit-order depth | protocol | yes | no | no | - | 1734 |
| pendle__markets_discover | Screen Pendle yield markets | protocol | yes | no | no | - | 2097 |
| pendle__merkle_rewards_list | List claimable Pendle merkle rewards | protocol | yes | no | no | - | 1668 |
| pendle__positions_get | Value this wallet's Pendle positions | protocol | yes | no | no | - | 1675 |
| pendle__pt_buy | Buy a Pendle principal token | protocol | no | yes | no | - | 1677 |
| pendle__pt_quote | Quote a Pendle PT trade | protocol | yes | no | no | - | 1011 |
| pendle__pt_redeem | Redeem a matured Pendle principal token | protocol | no | yes | no | - | 1969 |
| pendle__pt_rollover | Roll a Pendle PT into a later expiry | protocol | no | yes | no | - | 1306 |
| pendle__pt_sell | Sell a Pendle principal token | protocol | no | yes | no | - | 1729 |
| pendle__py_mint | Mint a Pendle PT and YT pair | protocol | no | yes | no | - | 1824 |
| pendle__py_quote | Quote a Pendle PT/YT mint or redeem | protocol | yes | no | no | - | 992 |
| pendle__py_redeem | Redeem a Pendle PT and YT pair early | protocol | no | yes | no | - | 1706 |
| pendle__rewards_claim | Claim accrued Pendle rewards | protocol | no | yes | no | - | 2296 |
| pendle__sy_mint | Wrap a token into Pendle SY | protocol | no | yes | no | - | 1003 |
| pendle__sy_redeem | Unwrap Pendle SY back to a token | protocol | no | yes | no | - | 1063 |
| pendle__yt_buy | Buy a Pendle yield token | protocol | no | yes | no | - | 1857 |
| pendle__yt_quote | Quote a Pendle YT trade | protocol | yes | no | no | - | 1083 |
| pendle__yt_sell | Sell a Pendle yield token | protocol | no | yes | no | - | 1784 |

### pools

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pools__fees_claim | Claim pools.fun creator fees | protocol | no | yes | no | - | 1619 |
| pools__launch_execute | Launch a token on pools.fun | protocol | no | yes | no | - | 2801 |
| pools__launch_preview | Price a pools.fun launch | protocol | no | no | no | - | 884 |
| pools__launch_request_form | Ask the user to confirm a pools.fun launch | protocol | no | no | no | - | 688 |
| pools__my_launches_list | List this wallet's pools.fun launches | protocol | yes | no | no | - | 1371 |
| pools__token_candles_list | Read pools.fun token candles | protocol | yes | no | no | - | 1006 |
| pools__token_get | Read one pools.fun token | protocol | yes | no | no | - | 1075 |
| pools__tokens_discover | Screen pools.fun tokens | protocol | yes | no | no | - | 1549 |
| pools__tokens_search | Search pools.fun tokens | protocol | yes | no | no | - | 928 |

### relay

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| relay__bridge_execute | Execute a Relay cross-chain bridge | protocol | no | yes | no | - | 1782 |
| relay__bridge_quote_get | Quote a Relay cross-chain bridge | protocol | yes | no | no | - | 1477 |

### solana

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| solana__lend_borrow_operate | Adjust a Jupiter Lend borrow position | protocol | no | yes | no | JUPITER_API_KEY | 1980 |
| solana__lend_borrow_positions_list | List Jupiter Lend borrow positions | protocol | yes | no | no | JUPITER_API_KEY | 1107 |
| solana__lend_borrow_vaults_list | Screen Jupiter Lend borrow vaults | protocol | yes | no | no | JUPITER_API_KEY | 1325 |
| solana__lend_earn_deposit | Deposit into a Jupiter Lend earn vault | protocol | no | yes | no | JUPITER_API_KEY | 955 |
| solana__lend_earn_positions_list | List Jupiter Lend earn positions | protocol | yes | no | no | JUPITER_API_KEY | 702 |
| solana__lend_earn_rates_list | Screen Jupiter Lend earn markets | protocol | yes | no | no | JUPITER_API_KEY | 952 |
| solana__lend_earn_withdraw | Withdraw from a Jupiter Lend earn vault | protocol | no | yes | no | JUPITER_API_KEY | 1336 |
| solana__predict_buy | Buy Jupiter prediction shares | protocol | no | yes | no | JUPITER_API_KEY | 976 |
| solana__predict_claim | Claim a resolved Jupiter prediction payout | protocol | no | yes | no | JUPITER_API_KEY | 936 |
| solana__predict_close_all | Close every Jupiter prediction position | protocol | no | yes | no | JUPITER_API_KEY | 870 |
| solana__predict_event_get | Read one Jupiter prediction event | protocol | yes | no | no | JUPITER_API_KEY | 684 |
| solana__predict_events_discover | Browse Jupiter prediction events | protocol | yes | no | no | JUPITER_API_KEY | 1104 |
| solana__predict_events_search | Search Jupiter prediction events | protocol | yes | no | no | JUPITER_API_KEY | 1152 |
| solana__predict_leaderboard_list | Rank Jupiter prediction traders | protocol | yes | no | no | JUPITER_API_KEY | 885 |
| solana__predict_market_get | Read one Jupiter prediction market | protocol | yes | no | no | JUPITER_API_KEY | 685 |
| solana__predict_order_get | Read one live Jupiter prediction order | protocol | yes | no | no | JUPITER_API_KEY | 627 |
| solana__predict_order_status_get | Read a Jupiter prediction order's fill status | protocol | yes | no | no | JUPITER_API_KEY | 505 |
| solana__predict_orderbook_get | Read Jupiter prediction order-book depth | protocol | yes | no | no | JUPITER_API_KEY | 708 |
| solana__predict_orders_list | List Jupiter prediction orders | protocol | yes | no | no | JUPITER_API_KEY | 1041 |
| solana__predict_pnl_history_get | Read Jupiter prediction realized-PnL history | protocol | yes | no | no | JUPITER_API_KEY | 883 |
| solana__predict_position_get | Read one Jupiter prediction position | protocol | yes | no | no | JUPITER_API_KEY | 625 |
| solana__predict_positions_list | List open Jupiter prediction positions | protocol | yes | no | no | JUPITER_API_KEY | 1018 |
| solana__predict_profile_get | Read a Jupiter prediction trader profile | protocol | yes | no | no | JUPITER_API_KEY | 708 |
| solana__predict_sell | Sell a Jupiter prediction position | protocol | no | yes | no | JUPITER_API_KEY | 1112 |
| solana__predict_suggested_events_list | Suggest Jupiter prediction events for a wallet | protocol | yes | no | no | JUPITER_API_KEY | 723 |
| solana__predict_trade_history_list | Read Jupiter prediction trade history | protocol | yes | no | no | JUPITER_API_KEY | 1009 |
| solana__predict_trades_list | Browse the global Jupiter prediction trade feed | protocol | yes | no | no | JUPITER_API_KEY | 906 |
| solana__predict_trading_status_get | Check Jupiter prediction trading status | protocol | yes | no | no | JUPITER_API_KEY | 604 |
| solana__predict_vault_get | Read the Jupiter prediction protocol vault | protocol | yes | no | no | JUPITER_API_KEY | 578 |
| solana__swap_execute | Execute a Jupiter swap | protocol | no | yes | no | JUPITER_API_KEY | 526 |
| solana__swap_quote | Quote a Jupiter swap | protocol | yes | no | no | JUPITER_API_KEY | 1189 |
| solana__token_prices_get | Read Solana token prices | protocol | yes | no | no | JUPITER_API_KEY | 637 |
| solana__tokens_discover | Discover new and trending Solana tokens | protocol | yes | no | no | JUPITER_API_KEY | 1123 |
| solana__tokens_search | Search Solana tokens by name | protocol | yes | no | no | JUPITER_API_KEY | 835 |

### trench

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| trench__images_list | List Trench image-locker images | protocol | yes | no | no | - | 1034 |
| trench__launch_execute | Launch a token on Trench Express | protocol | no | yes | no | - | 2406 |
| trench__launch_preview | Dry-run a Trench Express launch | protocol | yes | no | no | - | 1612 |
| trench__launch_request_form | Ask the user to confirm a Trench launch | protocol | no | no | no | - | 963 |
| trench__my_launches_list | List this wallet's Trench launches | protocol | yes | no | no | - | 884 |
| trench__token_trades_list | Read a Trench Express token's trade tape | protocol | yes | no | no | - | 950 |
| trench__tokens_discover | Screen Trench Express tokens | protocol | yes | no | no | - | 2293 |
| trench__tokens_search | Search Trench Express tokens | protocol | yes | no | no | - | 729 |
| trench__trade_execute | Trade a Trench Express token | protocol | no | yes | no | - | 1593 |
| trench__trade_quote | Quote a Trench Express trade | protocol | yes | no | no | - | 659 |

### uniswap

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| uniswap__swap_execute | Execute a Uniswap V2/V3 swap | protocol | no | yes | no | - | 1059 |
| uniswap__swap_quote | Quote a Uniswap V2/V3 route | protocol | yes | no | no | - | 696 |

### virtuals

| name | title | lane | read only | destructive | always load | requires env | description bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| virtuals__agent_get | Read one Virtuals agent token | protocol | yes | no | no | - | 556 |
| virtuals__agents_discover | Screen Virtuals agent tokens | protocol | yes | no | no | - | 1889 |
| virtuals__genesis_launches_list | Browse the Virtuals Genesis calendar | protocol | yes | no | no | - | 1655 |
| virtuals__graduations_list | List recent Virtuals graduations | protocol | yes | no | no | - | 1247 |
