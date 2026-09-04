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
preconditions appear inside the first 2000 bytes, and an ALWAYS-LOADED
description additionally fits whole inside the 2048 CHARACTERS a client
shows before truncating (measured 2026-09-03;
`ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS`). `vex_ToolDescribe` returns any
tool's whole contract in a RESULT, which no client truncates.

`returns` says whether the tool authored a machine-readable result shape,
and `vex fee` is the fee `vex_ToolDescribe` answers with: the RATE when Vex
charges, `none` for a path authored as free, `none (read)` for a read-only
tool, whose free answer is DERIVED from its action classification rather
than authored, and `-` when nothing is authored on a tool that can spend.
Those last two are DIFFERENT FACTS and are never collapsed: on a spending
tool `vex_ToolDescribe` reports an unauthored fee as unknown, never as
free. Both texts live on the tool
(`ToolDef` and `ProtocolToolManifest`) and are read whole from
`vex_ToolDescribe`, not reproduced here.

## Totals

- exported tools: 170
- internal: 27
- protocol: 143 across 11 namespaces
- always loaded: 27
- read-only: 112
- destructive: 50

## Internal tools

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AgentScan | Review this wallet's recorded activity | internal | yes | no | yes | - | 2046 | yes | none |
| BridgeExecute | Execute a cross-chain bridge | internal | no | yes | yes | - | 2015 | yes | 25 bps |
| BridgeExecuteRelay | Execute a Relay bridge | internal | no | yes | yes | - | 1937 | yes | 25 bps |
| BridgeQuote | Quote a cross-chain bridge | internal | yes | no | yes | - | 1889 | yes | none |
| BridgeQuoteRelay | Quote a Relay bridge | internal | yes | no | yes | - | 1110 | yes | none |
| BridgeStatus | Check a bridge order's status | internal | yes | no | yes | - | 1548 | yes | none |
| ChainRead | Read raw EVM chain data | internal | yes | no | yes | - | 1326 | yes | none |
| SwapExecute | Execute a token swap | internal | no | yes | yes | - | 2047 | yes | 25 bps |
| SwapExecuteUniswap | Execute a Uniswap swap | internal | no | yes | yes | - | 2046 | yes | 25 bps |
| SwapQuote | Quote a token swap | internal | yes | no | yes | - | 2047 | yes | none |
| SwapQuoteUniswap | Quote a Uniswap swap | internal | yes | no | yes | - | 2017 | yes | none |
| TokenCheck | Check an EVM token for honeypot and tax | internal | yes | no | yes | - | 953 | yes | none |
| TokenFind | Find a token's address and decimals | internal | yes | no | yes | - | 1956 | yes | none |
| TwitterAccount | Read Twitter accounts and posts | internal | yes | no | yes | RETTIWT_API_KEY | 2039 | yes | none |
| UnitsConvert | Convert token amounts and units | internal | yes | no | yes | - | 1393 | yes | none |
| WalletBalances | Read wallet balances across chains | internal | yes | no | yes | - | 2032 | yes | none |
| WalletEvmTransactionConfirm | Broadcast a prepared EVM transaction | internal | no | yes | yes | - | 2030 | yes | 25 bps |
| WalletEvmTransactionPrepare | Prepare an EVM transaction | internal | no | no | yes | - | 1945 | yes | 25 bps |
| WalletSendConfirm | Broadcast a prepared wallet transfer | internal | no | yes | yes | - | 1900 | yes | none |
| WalletSendPrepare | Prepare a wallet transfer | internal | no | no | yes | - | 1680 | yes | none |
| WalletSolanaTransactionConfirm | Broadcast a prepared Solana transaction | internal | no | yes | yes | - | 1815 | yes | none |
| WalletSolanaTransactionPrepare | Prepare a Solana transaction | internal | no | no | yes | - | 1898 | yes | none |
| WalletTrackToken | Track a token in the local wallet view | internal | no | no | yes | - | 1044 | yes | none |
| WalletWrapConfirm | Broadcast a prepared wrap or unwrap | internal | no | yes | yes | - | 2023 | yes | none |
| WalletWrapPrepare | Prepare a native / wrapped-native conversion | internal | no | no | yes | - | 2022 | yes | none |
| vex_ToolDescribe | Read one tool's whole contract | internal | yes | no | yes | - | 1812 | yes | none |
| vex_ToolSearch | Search the protocol tool catalog | internal | yes | no | yes | - | 1500 | yes | none |

## Protocol tools

### dexscreener

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dexscreener__candles_list | Read a pair's OHLCV candles | protocol | yes | no | no | - | 5291 | - | none (read) |
| dexscreener__chains_list | List DEX Screener chains | protocol | yes | no | no | - | 2946 | - | none (read) |
| dexscreener__gainers_list | List top-gaining DEX pairs | protocol | yes | no | no | - | 2711 | - | none (read) |
| dexscreener__launchpad_pairs_list | List launchpad pairs by stage | protocol | yes | no | no | - | 3122 | - | none (read) |
| dexscreener__losers_list | List top-losing DEX pairs | protocol | yes | no | no | - | 2329 | - | none (read) |
| dexscreener__narratives_list | List trending DEX Screener narratives | protocol | yes | no | no | - | 2231 | - | none (read) |
| dexscreener__pair_details_get | Read a pair's safety report | protocol | yes | no | no | - | 4668 | - | none (read) |
| dexscreener__pair_get | Read one pair's live state | protocol | yes | no | no | - | 3707 | - | none (read) |
| dexscreener__pairs_batch_get | Batch-read pairs or tokens | protocol | yes | no | no | - | 2623 | - | none (read) |
| dexscreener__pairs_new_list | List newest DEX pairs | protocol | yes | no | no | - | 2352 | - | none (read) |
| dexscreener__pairs_search | Search DEX pairs | protocol | yes | no | no | - | 2417 | - | none (read) |
| dexscreener__pairs_top_list | Rank DEX pairs by a metric | protocol | yes | no | no | - | 2470 | - | none (read) |
| dexscreener__pairs_trending_list | List trending DEX pairs | protocol | yes | no | no | - | 2189 | - | none (read) |
| dexscreener__spotlight_get | Read the DEX Screener spotlight feeds | protocol | yes | no | no | - | 2808 | - | none (read) |
| dexscreener__token_pairs_list | List a token's DEX pools | protocol | yes | no | no | - | 3038 | - | none (read) |
| dexscreener__tokens_screen | Screen tokens across chains | protocol | yes | no | no | - | 1994 | - | none (read) |
| dexscreener__top_traders_list | Rank a pair's top wallets | protocol | yes | no | no | - | 6552 | - | none (read) |
| dexscreener__trades_list | List a pair's trades | protocol | yes | no | no | - | 4171 | - | none (read) |

### khalani

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| khalani__bridge_execute | Execute a Khalani bridge | protocol | no | yes | no | - | 3471 | - | - |
| khalani__bridge_quote_get | Quote a Khalani bridge | protocol | yes | no | no | - | 2304 | - | none (read) |
| khalani__chains_list | List Khalani bridge chains | protocol | yes | no | no | - | 850 | - | none (read) |
| khalani__order_get | Read one Khalani bridge order | protocol | yes | no | no | - | 990 | - | none (read) |
| khalani__orders_list | List Khalani bridge orders | protocol | yes | no | no | - | 1066 | - | none (read) |
| khalani__token_balances_get | Read Khalani-chain wallet balances | protocol | yes | no | no | - | 4836 | - | none (read) |
| khalani__tokens_autocomplete | Parse a token phrase into Khalani tokens | protocol | yes | no | no | - | 964 | - | none (read) |
| khalani__tokens_search | Search Khalani tokens | protocol | yes | no | no | - | 1060 | - | none (read) |
| khalani__tokens_top_list | List top bridged tokens on Khalani | protocol | yes | no | no | - | 794 | - | none (read) |

### kyberswap

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kyberswap__chains_list | List KyberSwap chains | protocol | yes | no | no | - | 776 | - | none (read) |
| kyberswap__swap_execute | Execute a KyberSwap swap | protocol | no | yes | no | - | 3718 | yes | 25 bps |
| kyberswap__swap_quote | Quote a KyberSwap swap | protocol | yes | no | no | - | 3591 | - | none (read) |
| kyberswap__token_safety_check | Audit an EVM token with KyberSwap | protocol | yes | no | no | - | 1138 | - | none (read) |

### morpho

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| morpho__market_borrow | Borrow from a Morpho market | protocol | no | yes | no | - | 2892 | - | - |
| morpho__market_get | Read one Morpho Blue market | protocol | yes | no | no | - | 2042 | - | none (read) |
| morpho__market_quote | Quote a Morpho Blue market operation | protocol | yes | no | no | - | 2425 | - | none (read) |
| morpho__market_repay | Repay debt on a Morpho market | protocol | no | yes | no | - | 3455 | - | - |
| morpho__market_supply | Supply the loan asset to a Morpho market | protocol | no | yes | no | - | 3959 | - | - |
| morpho__market_supply_collateral | Supply collateral to a Morpho market | protocol | no | yes | no | - | 2862 | - | - |
| morpho__market_withdraw | Withdraw a supply from a Morpho market | protocol | no | yes | no | - | 3270 | - | - |
| morpho__market_withdraw_collateral | Withdraw collateral from a Morpho market | protocol | no | yes | no | - | 2894 | - | - |
| morpho__markets_activity_list | Read Morpho market activity | protocol | yes | no | no | - | 3263 | - | none (read) |
| morpho__markets_discover | Screen Morpho Blue lending markets | protocol | yes | no | no | - | 2961 | - | none (read) |
| morpho__positions_get | Read a wallet's Morpho positions | protocol | yes | no | no | - | 4446 | - | none (read) |
| morpho__rewards_claim | Claim earned Morpho rewards | protocol | no | yes | no | - | 2695 | - | - |
| morpho__rewards_get | Read claimable Morpho rewards | protocol | yes | no | no | - | 3189 | - | none (read) |
| morpho__vault_deposit | Deposit into a Morpho vault | protocol | no | yes | no | - | 3288 | - | - |
| morpho__vault_get | Read one Morpho vault | protocol | yes | no | no | - | 3338 | - | none (read) |
| morpho__vault_quote | Quote a Morpho vault deposit or withdrawal | protocol | yes | no | no | - | 4758 | - | none (read) |
| morpho__vault_withdraw | Withdraw from a Morpho vault | protocol | no | yes | no | - | 2844 | - | - |
| morpho__vaults_discover | Screen Morpho vaults | protocol | yes | no | no | - | 6470 | - | none (read) |
| morpho__wallet_balance_get | Read on-chain balances for Morpho tokens | protocol | yes | no | no | - | 3149 | - | none (read) |

### pendle

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pendle__asset_prices_get | Read Pendle asset prices | protocol | yes | no | no | - | 1249 | - | none (read) |
| pendle__lp_add | Add single-token Pendle liquidity | protocol | no | yes | no | - | 1755 | - | - |
| pendle__lp_add_keep_yt | Add Pendle liquidity and keep the YT | protocol | no | yes | no | - | 1271 | - | - |
| pendle__lp_quote | Quote a Pendle liquidity add or remove | protocol | yes | no | no | - | 971 | - | none (read) |
| pendle__lp_remove | Remove Pendle liquidity to one token | protocol | no | yes | no | - | 1747 | - | - |
| pendle__lp_remove_dual | Remove Pendle liquidity to two tokens | protocol | no | yes | no | - | 1304 | - | - |
| pendle__lp_to_pt | Convert Pendle liquidity into PT | protocol | no | yes | no | - | 1927 | - | - |
| pendle__lp_transfer | Move Pendle liquidity between markets | protocol | no | yes | no | - | 1314 | - | - |
| pendle__market_candles_get | Read Pendle asset price candles | protocol | yes | no | no | - | 1079 | - | none (read) |
| pendle__market_get | Read one Pendle market | protocol | yes | no | no | - | 1057 | - | none (read) |
| pendle__market_history_get | Read a Pendle market's history | protocol | yes | no | no | - | 735 | - | none (read) |
| pendle__market_orderbook_get | Read Pendle limit-order depth | protocol | yes | no | no | - | 1732 | - | none (read) |
| pendle__markets_discover | Screen Pendle yield markets | protocol | yes | no | no | - | 2097 | - | none (read) |
| pendle__merkle_rewards_list | List claimable Pendle merkle rewards | protocol | yes | no | no | - | 1664 | - | none (read) |
| pendle__positions_get | Value this wallet's Pendle positions | protocol | yes | no | no | - | 1675 | - | none (read) |
| pendle__pt_buy | Buy a Pendle principal token | protocol | no | yes | no | - | 1677 | - | - |
| pendle__pt_quote | Quote a Pendle PT trade | protocol | yes | no | no | - | 1011 | - | none (read) |
| pendle__pt_redeem | Redeem a matured Pendle principal token | protocol | no | yes | no | - | 1969 | - | - |
| pendle__pt_rollover | Roll a Pendle PT into a later expiry | protocol | no | yes | no | - | 1306 | - | - |
| pendle__pt_sell | Sell a Pendle principal token | protocol | no | yes | no | - | 1729 | - | - |
| pendle__py_mint | Mint a Pendle PT and YT pair | protocol | no | yes | no | - | 1824 | - | - |
| pendle__py_quote | Quote a Pendle PT/YT mint or redeem | protocol | yes | no | no | - | 992 | - | none (read) |
| pendle__py_redeem | Redeem a Pendle PT and YT pair early | protocol | no | yes | no | - | 1706 | - | - |
| pendle__rewards_claim | Claim accrued Pendle rewards | protocol | no | yes | no | - | 2296 | - | - |
| pendle__sy_mint | Wrap a token into Pendle SY | protocol | no | yes | no | - | 1003 | - | - |
| pendle__sy_redeem | Unwrap Pendle SY back to a token | protocol | no | yes | no | - | 1063 | - | - |
| pendle__yt_buy | Buy a Pendle yield token | protocol | no | yes | no | - | 1857 | - | - |
| pendle__yt_quote | Quote a Pendle YT trade | protocol | yes | no | no | - | 1083 | - | none (read) |
| pendle__yt_sell | Sell a Pendle yield token | protocol | no | yes | no | - | 1784 | - | - |

### pools

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pools__fees_claim | Claim pools.fun creator fees | protocol | no | yes | no | - | 1619 | - | - |
| pools__holder_rewards_get | Read pools.fun holder rewards | protocol | yes | no | no | - | 2100 | - | none (read) |
| pools__launch_assets_list | List pools.fun launchable stocks | protocol | yes | no | no | - | 1698 | - | none (read) |
| pools__launch_execute | Launch a token on pools.fun | protocol | no | yes | no | - | 2801 | - | - |
| pools__launch_preview | Price a pools.fun launch | protocol | no | no | no | - | 998 | - | - |
| pools__launch_request_form | Ask the user to confirm a pools.fun launch | protocol | no | no | no | - | 902 | - | - |
| pools__my_launches_list | List this wallet's pools.fun launches | protocol | yes | no | no | - | 1371 | - | none (read) |
| pools__token_candles_list | Read pools.fun token candles | protocol | yes | no | no | - | 1006 | - | none (read) |
| pools__token_get | Read one pools.fun token | protocol | yes | no | no | - | 1411 | - | none (read) |
| pools__tokens_discover | Screen pools.fun tokens | protocol | yes | no | no | - | 2552 | - | none (read) |
| pools__tokens_search | Search pools.fun tokens | protocol | yes | no | no | - | 1313 | - | none (read) |

### relay

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| relay__bridge_execute | Execute a Relay cross-chain bridge | protocol | no | yes | no | - | 2478 | yes | 25 bps |
| relay__bridge_quote_get | Quote a Relay cross-chain bridge | protocol | yes | no | no | - | 2094 | - | none (read) |

### solana

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| solana__lend_borrow_operate | Adjust a Jupiter Lend borrow position | protocol | no | yes | no | JUPITER_API_KEY | 1980 | - | - |
| solana__lend_borrow_positions_list | List Jupiter Lend borrow positions | protocol | yes | no | no | JUPITER_API_KEY | 1107 | - | none (read) |
| solana__lend_borrow_vaults_list | Screen Jupiter Lend borrow vaults | protocol | yes | no | no | JUPITER_API_KEY | 1325 | - | none (read) |
| solana__lend_earn_deposit | Deposit into a Jupiter Lend earn vault | protocol | no | yes | no | JUPITER_API_KEY | 955 | - | - |
| solana__lend_earn_positions_list | List Jupiter Lend earn positions | protocol | yes | no | no | JUPITER_API_KEY | 702 | - | none (read) |
| solana__lend_earn_rates_list | Screen Jupiter Lend earn markets | protocol | yes | no | no | JUPITER_API_KEY | 952 | - | none (read) |
| solana__lend_earn_withdraw | Withdraw from a Jupiter Lend earn vault | protocol | no | yes | no | JUPITER_API_KEY | 1336 | - | - |
| solana__predict_buy | Buy Jupiter prediction shares | protocol | no | yes | no | JUPITER_API_KEY | 976 | - | - |
| solana__predict_claim | Claim a resolved Jupiter prediction payout | protocol | no | yes | no | JUPITER_API_KEY | 936 | - | - |
| solana__predict_close_all | Close every Jupiter prediction position | protocol | no | yes | no | JUPITER_API_KEY | 870 | - | - |
| solana__predict_event_get | Read one Jupiter prediction event | protocol | yes | no | no | JUPITER_API_KEY | 684 | - | none (read) |
| solana__predict_events_discover | Browse Jupiter prediction events | protocol | yes | no | no | JUPITER_API_KEY | 1104 | - | none (read) |
| solana__predict_events_search | Search Jupiter prediction events | protocol | yes | no | no | JUPITER_API_KEY | 1152 | - | none (read) |
| solana__predict_leaderboard_list | Rank Jupiter prediction traders | protocol | yes | no | no | JUPITER_API_KEY | 885 | - | none (read) |
| solana__predict_market_get | Read one Jupiter prediction market | protocol | yes | no | no | JUPITER_API_KEY | 685 | - | none (read) |
| solana__predict_order_get | Read one live Jupiter prediction order | protocol | yes | no | no | JUPITER_API_KEY | 627 | - | none (read) |
| solana__predict_order_status_get | Read a Jupiter prediction order's fill status | protocol | yes | no | no | JUPITER_API_KEY | 505 | - | none (read) |
| solana__predict_orderbook_get | Read Jupiter prediction order-book depth | protocol | yes | no | no | JUPITER_API_KEY | 708 | - | none (read) |
| solana__predict_orders_list | List Jupiter prediction orders | protocol | yes | no | no | JUPITER_API_KEY | 1041 | - | none (read) |
| solana__predict_pnl_history_get | Read Jupiter prediction realized-PnL history | protocol | yes | no | no | JUPITER_API_KEY | 883 | - | none (read) |
| solana__predict_position_get | Read one Jupiter prediction position | protocol | yes | no | no | JUPITER_API_KEY | 625 | - | none (read) |
| solana__predict_positions_list | List open Jupiter prediction positions | protocol | yes | no | no | JUPITER_API_KEY | 1018 | - | none (read) |
| solana__predict_profile_get | Read a Jupiter prediction trader profile | protocol | yes | no | no | JUPITER_API_KEY | 708 | - | none (read) |
| solana__predict_sell | Sell a Jupiter prediction position | protocol | no | yes | no | JUPITER_API_KEY | 1112 | - | - |
| solana__predict_suggested_events_list | Suggest Jupiter prediction events for a wallet | protocol | yes | no | no | JUPITER_API_KEY | 723 | - | none (read) |
| solana__predict_trade_history_list | Read Jupiter prediction trade history | protocol | yes | no | no | JUPITER_API_KEY | 1009 | - | none (read) |
| solana__predict_trades_list | Browse the global Jupiter prediction trade feed | protocol | yes | no | no | JUPITER_API_KEY | 906 | - | none (read) |
| solana__predict_trading_status_get | Check Jupiter prediction trading status | protocol | yes | no | no | JUPITER_API_KEY | 604 | - | none (read) |
| solana__predict_vault_get | Read the Jupiter prediction protocol vault | protocol | yes | no | no | JUPITER_API_KEY | 578 | - | none (read) |
| solana__swap_execute | Execute a Jupiter swap | protocol | no | yes | no | JUPITER_API_KEY | 1222 | - | 25 bps |
| solana__swap_quote | Quote a Jupiter swap | protocol | yes | no | no | JUPITER_API_KEY | 3052 | - | none (read) |
| solana__token_prices_get | Read Solana token prices | protocol | yes | no | no | JUPITER_API_KEY | 637 | - | none (read) |
| solana__tokens_discover | Discover new and trending Solana tokens | protocol | yes | no | no | JUPITER_API_KEY | 1123 | - | none (read) |
| solana__tokens_search | Search Solana tokens by name | protocol | yes | no | no | JUPITER_API_KEY | 835 | - | none (read) |

### trench

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trench__images_list | List Trench image-locker images | protocol | yes | no | no | - | 1034 | - | none (read) |
| trench__launch_execute | Launch a token on Trench Express | protocol | no | yes | no | - | 2400 | - | - |
| trench__launch_preview | Dry-run a Trench Express launch | protocol | yes | no | no | - | 1704 | - | none (read) |
| trench__launch_request_form | Ask the user to confirm a Trench launch | protocol | no | no | no | - | 959 | - | - |
| trench__my_launches_list | List this wallet's Trench launches | protocol | yes | no | no | - | 884 | - | none (read) |
| trench__token_trades_list | Read a Trench Express token's trade tape | protocol | yes | no | no | - | 950 | - | none (read) |
| trench__tokens_discover | Screen Trench Express tokens | protocol | yes | no | no | - | 2293 | - | none (read) |
| trench__tokens_search | Search Trench Express tokens | protocol | yes | no | no | - | 729 | - | none (read) |
| trench__trade_execute | Trade a Trench Express token | protocol | no | yes | no | - | 1593 | - | - |
| trench__trade_quote | Quote a Trench Express trade | protocol | yes | no | no | - | 659 | - | none (read) |

### uniswap

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| uniswap__swap_execute | Execute a Uniswap V2/V3 swap | protocol | no | yes | no | - | 1442 | yes | 25 bps |
| uniswap__swap_quote | Quote a Uniswap V2/V3 route | protocol | yes | no | no | - | 1790 | - | none (read) |

### virtuals

| name | title | lane | read only | destructive | always load | requires env | description bytes | returns | vex fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| virtuals__agent_candles_list | Read a Virtuals agent's price candles | protocol | yes | no | no | - | 1611 | - | none (read) |
| virtuals__agent_get | Read one Virtuals agent token | protocol | yes | no | no | - | 1365 | - | none (read) |
| virtuals__agent_trades_list | Read a Virtuals agent's curve trade tape | protocol | yes | no | no | - | 1331 | - | none (read) |
| virtuals__agents_discover | Screen Virtuals agent tokens | protocol | yes | no | no | - | 2039 | - | none (read) |
| virtuals__creator_fees_get | Read a Virtuals agent creator's fee status | protocol | yes | no | no | - | 2347 | - | none (read) |
| virtuals__genesis_launches_list | Browse the Virtuals Genesis calendar | protocol | yes | no | no | - | 1767 | - | none (read) |
| virtuals__graduations_list | List recent Virtuals graduations | protocol | yes | no | no | - | 938 | - | none (read) |
