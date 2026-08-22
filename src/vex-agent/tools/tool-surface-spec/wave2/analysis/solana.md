# Solana namespace analysis

## Packet and scope

The namespace exposes Jupiter-backed Solana token research, swap routing, Earn lending, collateralized Borrow, and prediction markets. Every active manifest is gated by `JUPITER_API_KEY`. The runtime chain source is `SOLANA_SYNTHETIC_CHAIN_ID` in `src/constants/solana-chain.ts`, whose value is `20011000000`. The packet supports Solana only for this namespace. It supplies no request-rate-limit contract, so the declaration must not invent one.

## Outcomes

- Read: resolve and price named SPL tokens; discover fresh, trending, traded, verified, liquid-staking, or tokenized-stock listings; inspect token safety and liquidity; compare Earn rates and balances; inspect Borrow vault limits, positions, debt, collateral, and liquidation risk; browse and search prediction events; inspect markets, order-book depth, venue status, positions, orders, trade history, trader statistics, rankings, recommendations, and protocol-vault state.
- Quote: preview a wallet-scoped swap with resolved token decimals, route allocation, price impact, minimum output, slippage, fees, tip, and account-rent disclosure. Borrow has no separate preview in an autonomous session; the caller must read vault and position data and calculate post-operation LTV before acting.
- Act: execute a previously matched swap; deposit to or withdraw from Earn; open, adjust, or close a Borrow position; buy or sell prediction shares; claim a resolved winner; or close all prediction positions as independent operations.

## Retrieval terms

Each intended term below occurs verbatim in at least one frozen `embeddingText` after case and whitespace normalization only.

| Term | Frozen source entry |
| --- | --- |
| `real-time USD prices` | `solana.prices` |
| `Solana SPL token` | `solana.prices` |
| `new Solana launches` | `solana.tokens.trending` |
| `swap on Solana` | `solana.swap.execute` |
| `best route on Solana` | `solana.swap.execute` |
| `Jupiter Lend Earn` | `solana.lend.rates` |
| `earn yield on Solana` | `solana.lend.rates` |
| `collateralized borrowing` | `solana.lend.borrowOperate` |
| `liquidation threshold` | `solana.lend.borrowVaults` |
| `prediction market` | `solana.predict.events` |
| `YES/NO` | `solana.predict.events` |
| `market depth` | `solana.predict.orderbook` |
| `order book` | `solana.predict.orderbook` |
| `prediction positions` | `solana.predict.positions` |
| `claim payout` | `solana.predict.claim` |
| `leaderboard` | `solana.predict.leaderboards` |
| `vault balance` | `solana.predict.vaultInfo` |

Dropped from the recon shortlist because it is not present as an exact phrase in an `embeddingText`: `jupiter/solana price lookup`, `spl token search`, `resolve solana mint`, `jupiter quote`, `outcome shares`, and `open positions`. Those phrases remain frozen elsewhere but should not be declared as coupling terms.

## Characteristics and limits

- Fresh-token evidence is dated 2026-08-17: a live recent-mints sample contained 30 rows aged 10 to 175 seconds. `createdAt` is optional; a missing value means unknown age, not freshness. The discovery response is explicitly windowed and reports trimming.
- Named-token search accepts one name or symbol, or up to 100 comma-separated mint addresses, and has no continuation. Price lookup requires exactly one of a mint list or a query list.
- Swap execution requires economically identical parameters from the prior wallet-scoped quote. A successful submission is pending, not confirmed. The quote exposes fee, tip, and associated-token-account rent. The namespace does not bridge and does not execute on EVM chains.
- Earn and Borrow are distinct families. Earn amounts and Borrow legs use raw token units with their respective decimals. Borrow risk is unknown when vault data or thresholds are missing, and native SOL must already be wrapped for relevant Borrow operations.
- Prediction reads commonly cap pages at 100. Keyword search is locally limited because the provider returns at most 10 rows. Order-book depth has no upstream or local depth cap. Personalized recommendations have no caller-controlled result window.
- Prediction PnL history has returned provider 404 responses for every tested wallet since 2026-07-24; the lifetime profile is the available fallback. Leaderboard `winRatePct` has an unverified scale. Sells and claims settle later in JupUSD rather than immediately delivering USDC.

## Chain coverage

`SOLANA_SYNTHETIC_CHAIN_ID` is `20011000000`. This is the only chain identifier the declaration should render for this namespace. Source: `src/constants/solana-chain.ts`. No retrieval chain-name list was used.

## Facet coverage

| Navigation facet | Declaration prose that represents it |
| --- | --- |
| `Core token and price lookup` | "Read real-time USD prices, resolve a Solana SPL token by name, symbol, or mint, and screen new Solana launches." |
| `Swaps and lending` | "Quote a swap on Solana, inspect the best route on Solana, then execute the matched trade; compare Jupiter Lend Earn rates and positions or manage collateralized borrowing after reading the liquidation threshold." |
| `Prediction markets` | "For a prediction market, discover an event, read its YES/NO market and order book or market depth, then buy or sell, monitor prediction positions, and claim payout after resolution." |

## Doctrine judgment

| Existing sentence or clause | Verdict | Evidence and destination |
| --- | --- | --- |
| "Jupiter's whole Solana surface: token identity and prices, swaps routed by Jupiter, Earn lending and collateralized Borrow, and Jupiter prediction markets." | DUPLICATED | Distributed across descriptions: `solana.prices`, "Get real-time USD prices"; `solana.swap.quote`, "Preview a Solana token swap via Jupiter's Router"; `solana.lend.rates`, "Screen Jupiter Lend EARN markets"; `solana.lend.borrowVaults`, "Screen Jupiter Lend BORROW vaults"; and `solana.predict.events`, "Browse Jupiter prediction-market EVENTS". Delete the capsule sentence after the declaration lands. |
| "It is both the FRESHEST token feed Vex has - a recent-mints read measured rows 10 to 175 seconds old, each with its own createdAt - and the only namespace that can execute on Solana." | JUDGMENT | The freshness measurement is carried by `solana.tokens.trending`, "THE fastest fresh-token surface on Solana" and "ages 10-175 SECONDS since mint". Namespace-level execution exclusivity is not carried by one description. Destination: declaration as a local capability and freshness limit. |
| "Use when the chain is Solana: resolve a mint, price a token, find freshly launched or trending tokens, quote and then execute a swap, read or move an Earn or Borrow position, or browse and trade prediction markets." | DUPLICATED | The individual outcomes are carried by `solana.tokens.search`, "Look up SPECIFIC Solana tokens"; `solana.tokens.trending`, "Discover Solana tokens"; `solana.swap.quote`, "Call this FIRST"; `solana.swap.execute`, "Execute a token swap"; the Earn and Borrow descriptions; and the prediction read and action descriptions. Delete after the declaration represents the same local outcomes. |
| "Use `khalani` to bridge onto or off Solana, and `kyberswap` for EVM execution." | JUDGMENT | Cross-namespace routing is not a Solana-local description fact. Destination: Bridge task shape for bridging and Swap task shape for EVM execution. It must not create preference text in this declaration. |
| "and Solana lending/earn is `solana__lend_*`" | JUDGMENT | This is the Solana clause embedded in the Fixed Yield family arbiter. Destination: Yield task shape, which distinguishes Solana variable-rate Earn and Borrow from EVM fixed-yield and lending families. The local capability itself is independently supported by the Earn and Borrow manifests. |

## D4 and routing note

The declaration is venue-neutral. The existing cross-namespace `preferInstead` sentence moves to the Bridge and Swap task shapes. No preference between swap or bridge venues is stated here.

## Declaration draft

### Solana via Jupiter

Use this namespace for Solana-only token research, trading, lending, borrowing, and prediction markets. Runtime activity uses Solana synthetic chain id 20011000000. It cannot bridge assets or execute on EVM chains.

Read real-time USD prices, resolve a Solana SPL token by name, symbol, or mint, and screen new Solana launches, trending tokens, liquidity, holders, organic activity, and safety flags. The recent feed was measured on 2026-08-17 with 30 rows aged 10 to 175 seconds, but a missing creation time means unknown age, not fresh. Named-token results and discovery windows have explicit bounds and no continuation.

Quote a swap on Solana before acting. The wallet-scoped quote shows the best route on Solana, route allocation, token decimals, expected and minimum output, price impact, slippage, fees, tip, and account rent. Execution must reuse the economically identical quote parameters and returns a pending broadcast, not confirmation.

For yield, compare Jupiter Lend Earn markets to earn yield on Solana, read supplied balances and earnings, then deposit or withdraw. Keep Earn separate from collateralized borrowing. Before opening, adjusting, or closing a Borrow position, read vault liquidity, token decimals, debt, collateral, maximum LTV, and liquidation threshold, then calculate post-operation risk. Missing vault risk data means unknown, never healthy. Relevant native SOL legs require wrapped SOL already in the wallet.

For a prediction market, first discover or search an event, then read its specific YES/NO market. Inspect trading status, top prices, and the order book or market depth before sizing. Buy or sell only after that read, monitor orders and prediction positions, and claim payout only after a winning market resolves. A bulk close is a set of independent actions, not an atomic batch. Sells and claims settle later in JupUSD. Reads also cover trade history, lifetime performance, the leaderboard, recommendations, and protocol vault balance. PnL history has returned provider 404 responses since 2026-07-24, and leaderboard win-rate scale is unverified.

All capabilities require the Jupiter API credential. The packet states no request-rate-limit contract. Read and quote operations do not execute. Actions submit wallet transactions and their successful immediate result is pending.
