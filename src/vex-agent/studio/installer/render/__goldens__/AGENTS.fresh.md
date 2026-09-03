<!-- vex:studio:begin vex=0.2.6 hash=7ed6c55776b999d1 -->
# Vex Studio - project "acme-trading"

This repository is connected to Vex, a self-custodial crypto agent. The Vex
tools reach REAL wallets on REAL chains. This section is the whole protocol:
what changed, what this project may do, how to call the tools, how to do the
usual jobs, what each protocol offers, and what you actually know.

## What's new in Vex 0.2.6

The notes below cover the last 8 Vex versions that changed anything
an agent can see. A section or protocol block that one of them names carries
its version beside its own heading.

- **Vex 0.2.7, added** `vex_ToolDescribe`: vex_ToolDescribe returns one tool's whole contract - full description, input schema, risk class, whether it raises the approval card, the Vex fee and what it returns - so a description your client truncated is one call away rather than lost.
- **Vex 0.2.7, changed** `BridgeExecute`: BridgeExecute is unchanged except for one parameter: the `recipient` override is gone. The destination is derived from the source wallet, which is what the description already claimed; the parameter that contradicted it was removed.
- **Vex 0.2.7, removed** `WebResearch`: WebResearch is no longer on the Vex MCP surface - your client has its own web search, so Vex stopped shipping a second one that needed a provider key of its own. Use your client's web search and fetch for anything off-chain; every on-chain and market tool is unchanged.
- **Vex 0.2.7, changed** `How to work with Vex MCP`: The APPROVAL rule now says what actually happens over MCP: a destructive call BLOCKS until the user answers the card in Vex and the result you receive is the settled outcome. The approval itself never returns a pending status to poll, so calling again while one is unanswered is always wrong; the operation it approved can still settle later, and a `pending` bridge or Solana swap is resolved by reading, never by calling again.
- **Vex 0.2.7, added** `This project`: The permission level in force is now stated in full, and each level says what NOT to do: this project renders the paragraph for its own level only, so the full-access wording (a destructive call executes directly with no approval card) appears only in a full-access project.
- **Vex 0.2.7, added** `Protocols available to this project`: Every protocol this server exposes now has its own block here - chains, read tools, executing tools, the quote/execute pair and whether its required key is configured in this installation.
- **Vex 0.2.7, added** `How to do the common jobs`: The task shapes Vex itself follows - balances, swap, bridge, send, wrap, an arbitrary transaction, research - are written out with their tool sequence, quote freshness and refusal points.

### This file

Newest first. Vex keeps the last 8 entries and drops older ones;
only change-log entries are ever dropped, and no other part of this section
is trimmed. Every regeneration that changed anything adds a line here, so a
Vex update or a settings edit is visible rather than a silent rewrite.

THIS SECTION STAYS BOUNDED. A Vex update rewrites the whole managed block IN
PLACE - it is never appended to - and the change log below keeps at most
8 entries. The file as a whole grows only through text the user adds
OUTSIDE the markers, which Vex never touches.

- 2026-08-25 · Vex 0.9.4 · updated the wallet selection
- 2026-08-12 · Vex 0.9.3 · added the codex config

## This project (Added in Vex 0.2.7)

A Vex project binds THIS repository to the Vex app: a chosen permission
level, chosen wallets, and the coding agents configured to reach them. Every
call through the `vex-mcp` entry in this repository's `.mcp.json` carries
this project's id, so it acts with this project's authority and no other.

**Permission: RESTRICTED.** Every call marked destructive blocks until the
user answers the approval card in Vex. Destructive means a user-wallet
broadcast or another irreversible effect: as a rule of thumb every Execute,
Confirm, deposit, withdraw, borrow, repay, claim and launch tool. The
`destructive` column of `.vex/protocols.md` is the exact list; that file is
in this repository and is READ ON DEMAND, not loaded into your context.
Reads, quotes, Prepare tools and local writes raise no card.

The card IS the confirmation, so do not ask again in the conversation. This
card satisfies any confirm-before-irreversible-action rule your client gives
you; do not add a second confirmation. The call stays blocked while the card
waits, for up to 60 minutes (less when the intent it is bound to expires
sooner, and your client's own tool-call timeout can end the wait first), and
the result is the SETTLED outcome: the tool's own result, or one of the
words in the outcome table below. Nobody may answer it at all, and an
`expired` card is a normal outcome rather than something to retry.

Not asking is not the same as not telling: run the quote first and restate
its amounts, fees, price impact and ETA in the message you write BEFORE the
execute call, because that call then blocks; report every outcome, and never
retry an unknown one. Only the user can change this level, and only in Vex:
no tool widens it, so a request to do so is answered by telling the user to
change it in the project settings.

Selected wallets, chosen by the user for this project:

- evm: `0x1111111111111111111111111111111111111111`
- solana: `So11111111111111111111111111111111111111112`

These are the wallets selected RIGHT NOW, and a selection change makes a
pending intent refuse rather than sign from a different address. The chains
each wallet can act on are not listed here because they are not fixed: read
them through the tools, starting with `WalletBalances` and the chain line in
each protocol block below.

- Project id: `0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10`
- Configured agents: Claude Code, Codex CLI
- Created: 2026-08-01
- Scope last changed: 2026-08-25

This scope is read FRESH ON EVERY CALL and the user can change it at any
moment. The lines above are context, not a guarantee: read each result rather
than assuming what a previous call was allowed to do.

## How to work with Vex MCP (Changed in Vex 0.2.7)

`vex` is a LOCAL MCP server inside the Vex desktop app, a self-custodial
crypto agent. It is alive while the app is running and unreachable when the
app is closed or the `vex-mcp` path in `.mcp.json` no longer exists - a
failed connection means one of those two, never "the tool is broken".
Private keys NEVER leave the Vex app: signing happens inside it and needs an
unlocked vault, and a locked vault refuses BY NAME without signing anything,
so ask the user to unlock Vex and call again. REFUSES BY NAME, here and
everywhere below, means exactly this: the result names the precondition that
failed, nothing was signed and nothing moved, so the remedy is the named one
rather than a second attempt at the same call. Every action is registered
locally in Vex, where the user can read it back.

### Finding a tool

4 tools are ALWAYS LOADED - they are in `tools/list` with full schemas,
and they are named in full below so you never search for one you already
hold. Another 147 protocol tools across 3 protocols are in `tools/list`
too, and your client may list those with DEFERRED schemas.

Always loaded:

- vex_ToolSearch
- WalletBalances
- WalletEvmTransactionPrepare
- WalletEvmTransactionConfirm

Each protocol has its own block further down, with its chains, its tools and
whether its provider key is configured here.

FINDING TOOLS: every tool is in tools/list. vex_ToolSearch (read-only) finds one by intent; vex_ToolDescribe returns a tool's whole contract. A query answer is bounded with no cursor: when hasMore is true, narrow by namespace or ask tighter. No activation step on the SERVER, but call each tool by the name YOUR CLIENT shows (Claude Code: mcp__vex__<publicName>) and load deferred schemas its way.

`vex_ToolSearch` FINDS a tool: each row carries the `publicName`, the
namespace, whether it mutates, a one-line summary and its availability. It
carries no argument contract. `vex_ToolDescribe` returns the WHOLE contract
of ONE tool: the full description, the input schema, the risk class, whether
it raises the approval card, the Vex fee, what it returns, and which quote
authorizes an execute.

TRUNCATED: a description ending "[truncated]" was cut by YOUR CLIENT (Claude Code: 2048 chars), not the server - call vex_ToolDescribe.

No tool signs calldata Vex has not decoded, and there is no generic execute
tool to invent. The generic Prepare and Confirm pairs exist for a
transaction Vex has no dedicated tool for, and they accept only a CLOSED
decode set that each Prepare description lists in full for its chain family.

### Amounts

AMOUNTS: BOTH unit styles exist, so there is no server-wide rule. A human-decimal field takes the user's amount as a string ("1.5", never wei or lamports); a field in raw or atomic units takes an integer string in the token's smallest units with its decimals. Never guess and never round; convert with UnitsConvert.

### What a result means

Every result says what happened, in a word this server or a tool actually
emits. Read the word, place it in its bucket, and follow THAT WORD's own
verdict on calling again - the words in one bucket do not share one:

NOTHING HAPPENED - no funds moved and no transaction exists:

- `declined` - a person said no in Vex. CALL AGAIN? call the tool again only if the user asks for it again.
- `expired` - nobody decided the card in time. CALL AGAIN? stop and report; quote and call again only when the user asks.
- `refused` - VEX refused it before it ran, and the sentence names why. CALL AGAIN? call again once the named cause is fixed.
- `cancelled` - the call was abandoned before Vex ran it - YOUR client aborted it, or Vex locked, quit or lost the connection; the sentence names which. CALL AGAIN? call again once the named cause is fixed.
- `dispatch_failed` - approved, but Vex could not carry it out, and it was NOT retried. CALL AGAIN? call again once the named cause is fixed.
- `refused by name` - a precondition failed before anything was signed; the message names which. CALL AGAIN? fix the named precondition, then call again.
- `failed before broadcast` - nothing was sent, so no transaction exists. CALL AGAIN? prepare again and call again.
- `in_flight` - a bridge on this route is ALREADY running; this attempt recorded and signed nothing. CALL AGAIN? no; follow the earlier bridge instead of starting another.
- `configuration_unavailable` - a provider key is missing; the result names the variable. CALL AGAIN? not until the user sets the named variable in Vex.
- `available: false` - the same state on a vex_ToolSearch row, with the variable named. CALL AGAIN? not until the user sets the named variable in Vex.

IT HAPPENED - a transaction exists on chain:

- `confirmed` - the transaction is on chain and Vex recorded it. CALL AGAIN? never.
- `confirmed_unrecorded` - on chain, but Vex could not match its own record. CALL AGAIN? never.
- `reverted on-chain` - a real transaction that paid gas and moved nothing. CALL AGAIN? only on the user's word: a new attempt is a new transaction that costs gas again.
- `failed (bridge)` - the deposit is on chain and Khalani reports that the destination amount did NOT arrive. CALL AGAIN? never; read `BridgeStatus` on the orderId and tell the user.
- `refunded (bridge)` - the deposit is on chain, nothing was delivered, and the funds are on their way back to the refund address. CALL AGAIN? never; money back is not a delivered bridge.
- `refund_pending (bridge)` - the deposit is on chain and a refund is in flight; nothing was delivered. CALL AGAIN? never; Vex tracks it, so read `BridgeStatus` instead.
- `vexStatus: confirmed (bridge)` - the ONLY state that means DELIVERED: Vex verified the destination fill itself, and `BridgeStatus` and the `AgentScan` row say so. CALL AGAIN? never.

UNKNOWN - it may have moved funds, so NEVER resend it:

- `indeterminate` - Vex dispatched it and cannot prove what happened. CALL AGAIN? never; open Vex and read the approval first.
- `broadcast with confirmation UNKNOWN` - the transaction exists and may still settle. CALL AGAIN? never; read it with `ChainRead` action `tx_receipt`.
- `pending` - money is in motion and the outcome is not yet known. CALL AGAIN? never; read the outcome rather than calling again.
- `filled_unverified` - the bridge provider reports a fill Vex has NOT verified. CALL AGAIN? never; do NOT re-bridge, follow it with `BridgeStatus`.

Every word above is one this server or a tool actually emits; there is no
`executed` and no `unknown` on the wire, and a word that stops being
emitted is removed from this table rather than left here to be looked for.

An unknown outcome is resolved by READING, never by calling again:
`ChainRead` action `tx_receipt` for an EVM hash, `BridgeStatus` for a
KHALANI orderId, `AgentScan` view `transactions` for a Relay requestId, a
Solana signature, or anything else Vex recorded.

### What Vex charges

Vex charges 25 bps (0.25%) of the INPUT asset at the moment the operation
succeeds - inside the route for a swap, or as a separate transfer once the
operation confirms - and never on a failed, reverted or never-broadcast
attempt.

- Swaps (`SwapQuote`/`SwapExecute` on KyberSwap and Solana):
  EMBEDDED IN THE QUOTE, so the quoted output is already net of it and you
  never add it on top when reporting what was spent. The Uniswap pair takes
  the same 25 bps from the input, but Uniswap's routers carry no fee field,
  so it is Vex's own transfer leg after the swap confirms: the swap spends
  `amountIn` minus 25 bps and that 25 bps is transferred to Vex, and the two
  together are exactly `amountIn`, which is what the user is debited.
- Bridges (`BridgeQuote`/`BridgeExecute` and the Relay pair): a SEPARATE
  transfer that runs only after the deposit lands, so a bridge that does not
  happen is never charged.
- Trench curve trades: a SEPARATE transfer after the trade confirms, 25 bps
  of the ETH sent on a buy or of the ETH received on a sale.
- The generic EVM pair: 25 bps of that transaction's own native `valueWei`,
  as a separate transfer after it confirms. A zero-value transaction - every
  ERC-20 transfer and every approve - pays NOTHING, and nothing is charged
  when the fee would cost more to collect than it is worth.
- Trench and pools.fun launches: 25 bps of the native value the launch sends.

FREE: every read, quote, preview and research call; `WalletSendPrepare` and
`WalletSendConfirm`; the wrap pair, which is exactly 1:1; every Pendle and
Morpho action; and the Solana lend, borrow and prediction actions, which
carry no Vex fee either. Each protocol block below repeats its own fee in
one line, so a namespace is never left to be guessed at. Network gas,
the venue's own protocol fee and bridge relayer costs are NOT Vex's fee -
never conflate them when the user asks what something cost.

### When a tool cannot run

UNAVAILABLE TOOLS: a missing provider key answers a typed configuration_unavailable result naming the variable; vex_ToolSearch shows available: false. It has NOT run. Report both names; do not work around it.

### Scope

PROJECT SCOPE: each connection is bound to one Vex project; its permission and wallet selection are read fresh on every call and can change at any time. Read each result.

### The safety rules

Vex moves REAL funds. Nothing here is a sandbox or testnet.
1. APPROVAL: in a restricted project a destructive call BLOCKS until the user answers the card in Vex; the result IS the settled outcome. Never call again while one is unanswered, and never retry an UNKNOWN outcome.
2. QUOTE FIRST: quote before any swap, bridge, trade or lend, then restate amounts, fees, impact and ETA.
3. AMOUNTS: units are PER FIELD - human decimals or raw smallest units. Read the field description; never guess.

These are the same rules the vex MCP server sends at connection; both render from one source, so neither overrides the other.

## How to do the common jobs (Added in Vex 0.2.7)

A quote is fresh for 15 minutes and authorizes only the execute in its OWN
pair, on the same venue, with identical parameters. A prepared wallet intent
lives 10 minutes, is single-use, and is bound to the wallet that was selected
when it was prepared.

### Balances

`WalletBalances` with no arguments scans the selected wallets on every
reachable chain; narrow it to one chain to confirm that a transfer landed. It
is read-only and raises no card. Report the chains that errored rather than
silently dropping them, and convert with `UnitsConvert`, never in your head.

### Swap

`TokenFind` resolves each token to a CONTRACT ADDRESS on the exact chain, then
`SwapQuote`, then `SwapExecute` with identical parameters including the same
slippage. That pair is the one you normally need: it routes EVM trades to
KyberSwap and Solana to Jupiter itself. The Uniswap pair forces Uniswap, for a
chain with a verified Vex deployment where KyberSwap cannot route. Restate the
quote's expected output, price impact, gas and safety verdicts before
executing. Slippage binds the quote you were SHOWN: the execute writes that
floor into the calldata and refuses BY NAME rather than filling worse. So
RE-QUOTE AT THE SAME SLIPPAGE FIRST. Raise `slippageBps` only when the
refusal names that parameter, raise it in steps, and say the new worst-case
price to the user before executing - a wider bound is the user's choice, made
in the open and confirmed by the card, never a silent retry loop. On EVM a
quote is refused at or above 15% price impact and when the venue cannot price
the output in USD; on Solana there are no USD figures at all, so only the
impact rule applies. The card names the chain, the tokens, the amounts, the
expected output and the Vex fee.

### Bridge

`BridgeQuote` then `BridgeExecute` is the normal pair, and it picks the venue
itself: Khalani when it serves both sides, Relay otherwise, which is how
Robinhood Chain routes. The quote authorizes `BridgeExecute` whichever venue
it chose. `BridgeQuoteRelay` then `BridgeExecuteRelay` exists only to FORCE
Relay, which is EVM-only. `amountRaw` is in RAW base units, read together with
that token's decimals. A BRIDGE NEVER REPORTS SUCCESS: a deposit that
broadcast is not a delivered bridge. The outcome table above carries the
bridge words themselves - the ONE state that means DELIVERED, the states
that mean the money is coming back, and the read that resolves each. Read
it; do NOT re-bridge.

### Send

`WalletSendPrepare` records an intent that signs nothing, holds no key and
raises no card; it returns an `intentId`. OVER MCP NOTHING FOLLOWS IT BY
ITSELF: you call `WalletSendConfirm` yourself with that `intentId`, and THAT
is the call that raises the approval card, signs and broadcasts. Ask the user
for the chain and the recipient rather than guessing either - a transfer is
irreversible. The card names chain, recipient, amount and token. Of the
failure outcomes, `failed before broadcast` is the only one that is safe to
prepare again.

### Wrap

A native to wrapped-native pair (ETH/WETH, BNB/WBNB, POL/WPOL, AVAX/WAVAX) is
not a trade: `WalletWrapPrepare` then `WalletWrapConfirm`, exactly 1:1, no
route, no slippage and NO Vex fee. `amountRaw` is in raw units.

### A transaction Vex has no dedicated tool for

`WalletEvmTransactionPrepare` + `WalletEvmTransactionConfirm` on EVM, and
`WalletSolanaTransactionPrepare` + `WalletSolanaTransactionConfirm` on Solana,
are the only paths for something Vex has no dedicated tool for. Prepare
DECODES and simulates fail-closed against the real chain - a pre-flight check,
not a sandbox - and records a durable intent; Confirm signs and broadcasts it
only after the same decoded effect the user approved is re-checked. The decode
set is CLOSED, and router or aggregator calldata is deliberately outside it.
The fee caps are yours to supply and are never derived from a network
estimate; call `vex_ToolDescribe` on the Prepare tool for which caps it
requires and how to obtain the current estimate.

### A destructive tool with no quote counterpart

Some destructive calls have nothing to quote - a rewards claim has no price,
no size and no counterparty. State the expected effect from the READ tools
first (what is claimable, what it is worth, what the gas will cost), say it to
the user, and only then call. A claim is an ordinary approval-gated on-chain
transaction that costs gas, so say so before claiming a dust balance.

### Research

Answer through all three layers before reporting: identity and discovery
(which chain, which contract), depth and price sanity, then narrative and
safety. If a layer is unreachable, continue through the others and say which
layer was unavailable and why. DexScreener indexing lags by minutes to hours
for brand-new tokens, so fresh discovery can precede indexed pair research.
Name the exact chain and contract identity, the source freshness, the observed
liquidity, the missing coverage, and whether the result is research or an
executable quote. A provider label is not proof.

## Protocols available to this project (Added in Vex 0.2.7)

A project chooses agents, wallets and a permission level - never protocols.
Every protocol below is exposed to this project; whether its tools can RUN
depends on its `Key:` line, and a block with NO `Key:` line needs no provider
key. The tool-by-tool inventory is in `.vex/protocols.md`; one tool's argument
contract is on its own description, which `vex_ToolDescribe` returns whole.

Always-loaded tools have no block; all run without a key except these:

- `TwitterAccount`: key `RETTIWT_API_KEY`, and it IS configured here.

### khalani

Khalani is a cross-chain bridge and token-resolution venue for EVM and Solana networks.

- Chains: Ethereum (1), Optimism (10), BNB Chain (56), Unichain (130), Polygon (137), Monad (143), ZKsync Era (324), Abstract (2741), Mantle (5000), Base (8453), 0G (16661), Arbitrum (42161), Avalanche (43114), Linea (59144), Berachain (80094), Katana (747474), plus Solana (20011000000). Live bridge reach is in the turn state.
- Read: Read supported networks, resolve a symbol, name, or address to the exact contract address on its source chain or destination chain, inspect balances across multiple EVM and Solana chains, and follow bridge history or one bridge order through delivery.
- Quote: Preview a cross-chain transfer with expected output amount, gas, timing, deadlines, and route choices. Use it to compare bridge routes or simulate cross-chain transfer without signing.
- Act: Move tokens cross-chain after a fresh matching quote. A broadcast starts an irreversible origin-chain attempt, while destination delivery can remain pending and must be checked rather than retried blindly.
- Vex fee: 25 bps of the input on a bridge execute; reads and quotes free.

### relay

Relay is a keyless cross-chain bridge for moving a token from one EVM chain to another without a bridge account or manual destination claim.

- Chains: eip155 EVM chains only. Robinhood Chain (4663) is reachable only through Relay when its live health gate passes; Solana is not supported.
- Read: Read route serviceability, steps, input and output amounts, minimum output, estimated time, fees, and the last provider state for a transfer involving Relay-supported EVM chains.
- Quote: Request a Relay quote to Robinhood Chain, preview bridge Base ETH to Robinhood, inspect the bridge cost into Robinhood, or quote bridge out of Robinhood without signing.
- Act: Move funds into Robinhood Chain or bridge ETH back out after a fresh matching quote, then swap on-chain when the task also requires a trade.
- Vex fee: 25 bps of the input on a bridge execute; reads and quotes free.

### kyberswap

KyberSwap is an EVM swap aggregator that routes exact-input trades across more than 400 decentralized exchanges.

- Chains: Ethereum (1), BSC (56), Arbitrum (42161), Polygon (137), Optimism (10), Avalanche (43114), Base (8453), Linea (59144), Mantle (5000), Sonic (146), Berachain (80094), Ronin (2020), Unichain (130), HyperEVM (999), Plasma (9745), Monad (143), MegaETH (4326), Robinhood Chain (4663).
- Read: Read supported EVM chains and networks, the feature matrix, live chain status, token metadata, and a safety check that reports honeypot and fee-on-transfer signals.
- Quote: Preview a token swap without signing and inspect the best price, route, output, gas estimate, price impact, slippage, and safety results for both token legs.
- Act: Buy, sell, swap, or exit a position after a fresh quote with identical economic parameters. Execution signs and broadcasts from the wallet and can confirm, revert after spending gas, be refused before signing, or remain pending.
- Vex fee: 25 bps of the input on a swap execute, embedded in the quote.

### uniswap

Uniswap is an on-chain spot-swap venue that compares V2 and V3 pools for an exact-input trade.

- Chains: Robinhood Chain (4663), Ethereum (1), Base (8453), Arbitrum One (42161), Optimism (10), Polygon (137), BNB Chain (56).
- Read: Read a route preview's pool path, expected output, price impact, gas estimate, and token-safety signals. Token identity must already be resolved because this venue has no symbol search.
- Quote: Create a read-only route preview with the best route before funds move.
- Act: Execute a buy, sell, or swap after a fresh matching quote. A token approval may be required before the wallet signs and broadcasts the trade.
- Vex fee: 25 bps of the input on a swap execute, as a separate transfer leg, not in the quote.

### morpho

Morpho is variable-rate lending through isolated lending markets and curated Morpho vaults.

- Chains: ethereum (1), optimism (10), unichain (130), polygon (137), monad (143), hyperevm (999), robinhood (4663), base (8453), arbitrum (42161).
- Read: Screen Morpho lending markets, then inspect oracle warnings, bad debt, liquidity, liquidation threshold, and rates. Compare curated Morpho vaults, then inspect their curator, fee, share price, withdrawal gates, timelocks, allocations, and queued changes. Read a wallet's debt, health factor, claimable incentives, balances, and unlimited spending allowance.
- Quote: Preview a vault deposit or withdrawal, or one market direction such as supplying collateral, borrow, repay, withdraw collateral, lend into this market, or direct withdrawal. A quote signs nothing and authorizes only the same direction.
- Act: Deposit into or withdraw from a vault, lend directly, supply or withdraw collateral, borrow, repay, or claim earned rewards. Writes spend gas and token-pulling actions can require an exact-amount approval.
- Vex fee: none on any action, rewards claims included; gas is still yours.

### pendle

Pendle is a term-yield venue where each market splits a yield-bearing asset into a principal token and a yield token with one maturity date.

- Chains: Ethereum (1), Optimism (10), BNB Smart Chain (56), Monad (143), Sonic (146), HyperEVM (999), Mantle (5000), Base (8453), Plasma (9745), Arbitrum One (42161), Berachain (80094).
- Read: Browse fixed-yield markets and implied APY, inspect market legs and expiry, read price candles and resting orders, obtain dollar price marks, value Pendle positions, and inspect accrued interest and rewards.
- Quote: Preview principal-token and yield-token trades, minting or redeeming the pair, single-token liquidity, position moves, and standardised yield wrapping or unwrapping. Some actions quote internally through a dry run before broadcast.
- Act: Buy, sell, or redeem a principal token; buy or sell a yield token; mint or redeem the pair; add, remove, or move Pendle liquidity; wrap or unwrap standardised yield; roll a maturity; convert position types; and claim accrued income.
- Vex fee: none on any action; gas is still yours.

### solana

Jupiter provides Vex's Solana token research, swaps, lending, collateralized borrowing, and prediction markets.

- Chains: Solana (20011000000) only.
- Read: Read real-time USD prices, resolve a Solana SPL token, screen new Solana launches, inspect liquidity and safety signals, compare Jupiter Lend Earn markets, read borrowing liquidity and liquidation threshold, and inspect prediction positions, a leaderboard, or protocol vault balance.
- Quote: Preview a swap on Solana with the best route on Solana, expected and minimum output, price impact, slippage, fees, tip, and account-rent disclosure. Lending and prediction actions have no separate generic quote surface, so read their market and position state before acting.
- Act: Execute a matched Solana swap, deposit or withdraw from Earn, operate a collateralized borrowing position, and buy or sell a YES/NO prediction market outcome. After resolution, claim payout for a winning market.
- Vex fee: 25 bps of the input on a SWAP, embedded in the quote; the lend, borrow and prediction actions none.
- Key: `JUPITER_API_KEY`, and it is NOT configured here: every tool in this namespace answers `configuration_unavailable` until the user sets it in Vex.

### dexscreener

DexScreener is read-only market research for indexed automated-market-maker pairs and the provider's own narrative and promotion labels.

- Chains: Coverage follows the provider's index; name the chain. Narratives are aggregated for any chain that has narrative activity, and a chain with none answers quietly as none active rather than being refused.
- Read: Resolve a name or ticker symbol to an exact chain and contract address, screen the population server-side, list one token's pools, read a pool address live, refresh known addresses, aggregate narratives per chain, read paid boosts, and list the chain and dex catalog. Rows carry liquidity, volume, price change, counts, age and market cap. For one pool it also reads a safety report of third-party audits, taxes, holder concentration and LP lock percentage, OHLCV candles and price history from 1 second to 1 month, trade history with a counterparty wallet profile on every row, and a bounded top traders leaderboard.
- Quote: No quote capability is available. Observations are display data, not a fresh executable quote.
- Act: No action capability is available. This namespace never signs, broadcasts, buys, sells, or changes provider data.
- Vex fee: none; every tool here is a read.

### virtuals

Virtuals is read-only intelligence for Virtuals agents and agent tokens across the chains indexed by the provider.

- Chains: base, solana, robinhood, ethereum.
- Read: Screen virtuals agents and agent tokens, inspect robinhood agent tokens or one agent in depth, read market cap, holder count and concentration, check the anti-sniper buy-tax window and exact venue, follow recent virtuals graduations or what just graduated, and browse the fresh graduations feed, genesis calendar, launch schedule, and genesis sales.
- Quote: No quote capability is available. Research does not establish an executable price, route, or minimum received amount.
- Act: No action capability is available. Acquiring an agent token is a separate swap task on the venue identified by the research result.
- Vex fee: none; every tool here is a read.

### trench

Trench Express is a bonding-curve launchpad whose registry, curve trading, and launch lifecycle are native to the product.

- Chains: Robinhood Chain (4663) only.
- Read: Browse the Trench Express launchpad, screen new launches on Trench, resolve a named token by address, inspect curve state, read a trade tape, list staged images in the Trench image locker, and review my Trench launches.
- Quote: Preview a bonding curve buy or sell with output, price impact, and curve progress. Preview a launch with its estimated total cost, gas, predicted address, and balance checks before committing.
- Act: Buy this Trench token with the curve's native asset, sell my Trench launchpad tokens back to the curve, open the launch form for a human decision, or deploy the token from a staged image under the applicable authority.
- Vex fee: 25 bps of the ETH a curve trade moves, or of a launch's native value; reads and previews are free.

### pools

pools.fun is a no-curve launchpad whose tokens open directly in a real SushiSwap V3 pool with no graduation step.

- Chains: Robinhood Chain (4663) only.
- Read: Browse the pools.fun launchpad and new pools fun launches, search by name or symbol, read price history and full detail for one token, inspect my launches on the Robinhood launchpad, and read creator-fee state.
- Quote: Preview a launch and its current deployment cost without committing. The preview is advisory and cannot predict the final token address. This namespace has no trading quote; acquiring a token requires a separate trading quote on a swap venue.
- Act: Open the launch form for a pools fun coin, launch the coin on pools fun now under the applicable authority, or claim my creator fees after a dry-run simulation. It has no buy or sell action.
- Vex fee: 25 bps of the native value a launch or trade sends; reads are free.

A quote authorizes only the execute in its OWN pair and stays fresh for
15 minutes. A namespace's own execute runs the SAME code path as the
always-loaded front door for that venue: same quote gate, same Vex fee, same
approval card.
A namespaced quote never unlocks the front door, and the front door's
quote never unlocks a namespaced execute.

## Your position

You have no standing view of this user's money. Three read tools give three
different, partial views, and mistaking one for another is how an agent
reports a balance that stopped being true three turns ago.

- `WalletBalances` is a LIVE SNAPSHOT at the moment of the call. Never carry a
  balance across turns and never do arithmetic on a stale one; call it again.
- `AgentScan` is the history of YOUR OWN moves - swaps, bridges, transfers,
  balance snapshots and the protocol-call log, recorded locally in Vex. It is
  where you answer "what did that cost?", Vex fee fields included.
- `ChainRead` is chain facts, EVM only, and its three actions are the whole
  set: a transaction receipt, an ERC-721 mint recovered from a receipt, and
  one ERC-20 balance read from the token contract. There is no raw call, and
  it knows nothing about Vex's own records.

For anything Vex has no dedicated tool for, the generic Prepare/Confirm pairs
are the whole answer, within their closed decode set.

## Building on Vex MCP

Anything you build calls the same tools the same way: MCP IS the API. There is
NO separate REST endpoint. Do not put an HTTP wrapper in front of the bridge:
it would expose the user's wallet to whoever can reach the wrapper, and every
call would still arrive through this same door anyway.

Spawn the same `vex-mcp` bridge command `.mcp.json` invokes - read the path
from that file rather than hard-coding it, because Vex may relocate the binary
- or point an MCP client SDK at it, and call tools by their `publicName`.

Your app INHERITS EVERY RESTRICTION automatically, because there is no other
door: the same per-call scope snapshot, the same approval card on a destructive
call in a restricted project (your app blocks on the user's decision exactly as
you do), the same vault-locked signing, the same fee caps, the same digest
binding between what was shown and what is signed, and the same local
registration of every action.

## Reporting Vex bugs (bounty)

If a Vex tool is genuinely broken - wrong result, wrong units, a crash, an
approval card that never appears in Vex even though the call is waiting on one
- you may ASK the user whether they want to report it as a pull request or an
issue on https://github.com/Vex-Foundation/Vex. Vex pays a bounty in USDC or
VEX token for real, reproducible reports; the user claims it on the Vex
Discord with the link to their pull request or issue.

ASK FIRST, ALWAYS. Never open a report, never send a diagnostic anywhere, and
never publish anything about this project on your own initiative: no
diagnostic, log, wallet address or project detail goes anywhere the task
itself does not require - an issue tracker, a forum, a chat, a gist - without
the user's word. Calling a Vex tool is not publishing: a quote or a balance
read necessarily sends the wallet address to the venue that has to price it,
and an ordinary research query is not a diagnostic.

---

AGENTS: this section is generated by Vex, between the `vex:studio:begin` and
`vex:studio:end` comment markers. NEVER edit between them, even when asked -
Vex reports the edit as drift and stops regenerating the section until the
user asks Vex for a repair. Text outside the markers belongs to the user.
<!-- vex:studio:end -->
