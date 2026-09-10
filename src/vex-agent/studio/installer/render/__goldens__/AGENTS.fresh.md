<!-- vex:studio:begin vex=0.2.6 hash=078137c8a0dab213 -->
# Vex Studio - project "acme-trading"

This repository is connected to Vex, a self-custodial crypto agent whose tools
reach REAL wallets on REAL chains. This section covers project scope, tool
use, outcomes and common jobs. The map gives discovery facts; read the
companion guide for protocol details before acting.

## Protocol map

- khalani: cross-chain bridge/token-resolution; Ethereum,Optimism,BNB Chain,Unichain,Polygon,Monad,ZKsync Era,Abstract,Mantle,Base,0G,Arbitrum,Avalanche,Linea,Berachain,Katana,Solana; live reach; fee 25 bps origin input; key not required; `khalani__`.
- relay: cross-chain bridge; EVM only; Robinhood Chain needs live health gate; fee 25 bps origin input; key not required; `relay__`.
- kyberswap: EVM swap aggregator; Ethereum,BSC,Arbitrum,Polygon,Optimism,Avalanche,Base,Linea,Mantle,Sonic,Berachain,Ronin,Unichain,HyperEVM,Plasma,Monad,MegaETH,Robinhood Chain; fee 25 bps swap input; key not required; `kyberswap__`.
- uniswap: spot-swap; Robinhood Chain,Ethereum,Base,Arbitrum One,Optimism,Polygon,BNB Chain; fee 25 bps swap input; key not required; `uniswap__`.
- morpho: variable-rate lending/Morpho vaults; ethereum,optimism,unichain,polygon,monad,hyperevm,robinhood,base,arbitrum; fee none; key not required; `morpho__`.
- pendle: term-yield; Ethereum,Optimism,BNB Smart Chain,Monad,Sonic,HyperEVM,Mantle,Base,Plasma,Arbitrum One,Berachain; fee none; key not required; `pendle__`.
- solana: swaps/lending/borrowing/prediction markets; Solana; fee 25 bps swap input; lend/predict free; key JUPITER_API_KEY missing; `solana__`.
- dexscreener: read-only market research; provider-indexed chains; fee none; key not required; `dexscreener__`.
- lighter: perp-trading/onboarding; Lighter Core and Lighter on Robinhood Chain; fee 10 bps perps; 25 bps spot; key not required; `lighter__`.
- virtuals: agent tokens/bonding-curve trading; base, solana, robinhood, ethereum; buy/sell/launch base and robinhood only; fee 25 bps VIRTUAL buy/launch input or proven sell proceeds; late launch waived; key not required; `virtuals__`.
- pools: no-curve launchpad; Robinhood Chain; fee 25 bps native value; key not required; `pools__`.
- launchpads: image locker/public content-addressed host; chain-agnostic; fee none; key not required; `launchpads__`.

## Read these on start (Changed in Vex 0.2.7)

Two files in this repository carry the rest of the Vex protocol. Open the
relevant sections with your file-reading tool unless already in context.

- `.vex/vex-guide.md` - read the relevant section before using a protocol.
  What changed in Vex and what Vex last changed in this project,
  every protocol available here with its chains, its fee and whether its
  provider key is configured on this machine, what an app you build on Vex
  inherits, and how a Vex bug is reported.
- `.vex/protocols.md` - READ IT ON DEMAND: the tool-by-tool inventory, with
  each tool's read-only and destructive hints and the key it needs.

Claude Code imports the guide through `CLAUDE.md`. Other clients do not load
it automatically; the map above is what they have until they open the guide.
Read the relevant protocol section before using it unless already in context.

## This project (Added in Vex 0.2.7)

A Vex project binds THIS repository to the Vex app: a chosen permission
level, chosen wallets, and the coding agents configured to reach them. Every
call through this project's configured `vex-mcp` bridge carries
this project's id, so it acts with this project's authority and no other.

**Permission: RESTRICTED.** A destructive call that passes its preconditions
blocks until the user answers the approval card in Vex. Destructive means a
user-wallet broadcast or another irreversible effect: usually Execute,
Confirm, deposit, withdraw, borrow, repay, claim and launch tools. The
`destructive` column of `.vex/protocols.md` is the exact list; read it on demand.
The card is Vex's confirmation. While it waits, the call stays blocked for up
to 60 minutes (less if its intent expires or your client's tool-call
timeout ends the wait first). Read the settled result in the outcome table
below; expiry is a normal outcome to report, never an automatic retry.

Ordinary reads, quotes and local writes require no card. Wallet Prepare tools
return an intent for a separate Confirm call; some protocol Prepare tools
automatically hand off to an approval card, including Lighter flows.
Vex's permission controls Vex's own execution gate. Follow additional binding
client policy; avoid duplicate confirmation where that policy already accepts
standing authority or Vex's card.
Not asking is not the same as not telling: use the quote or preview if offered,
otherwise read current state. Restate intended effects, amounts, fees, impact
and ETA before executing; a call awaiting a card blocks. Report every outcome
and never retry an unknown one. Only the user can change this level in Vex's
project settings; no tool widens it.

Selected wallets, chosen by the user for this project:

- evm: `0x1111111111111111111111111111111111111111`
- solana: `So11111111111111111111111111111111111111112`

These are the wallets selected RIGHT NOW, and a selection change makes a
pending intent refuse rather than sign from a different address. The chains
each wallet can act on are not listed here because they are not fixed: read
them through the tools, starting with `WalletBalances` and the chain line in
each protocol section in `.vex/vex-guide.md`.

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
app is closed. Diagnose connection failures from the actual error: check
whether Vex is running, then the configured bridge command, path and
transport details the error names. Do not assume a predetermined cause.
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

Each protocol has a section in `.vex/vex-guide.md`, with its chains, tools
and whether its provider key is configured here.

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
- `expired` - nobody decided the card in time. CALL AGAIN? report expiry; if the user still wants it, obtain a fresh quote or intent and call again to create a new approval.
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

If a mutating call times out, disconnects or returns an unresolved outcome,
do not submit the action again. Preserve its transaction hash, signature,
order or request id or approval reference and use read-only reconciliation.
An absent receipt is not proof that nothing was broadcast.
Resolve an unknown outcome by READING:
`ChainRead` action `tx_receipt` for an EVM hash, `BridgeStatus` for a
KHALANI orderId, `AgentScan` view `transactions` for a Relay requestId, a
Solana signature, or anything else Vex recorded.

### What Vex charges

Vex fees depend on the operation. Consult its quote and fee disclosure;
network and venue fees are separate. A refused, reverted or never-broadcast
operation has no Vex execution fee. Collection follows the successful swap,
origin deposit, transaction or fill described below.

- Swaps (`SwapQuote`/`SwapExecute` on KyberSwap and Solana): 25 bps (0.25%)
  of the input, taken inside the route for a swap and EMBEDDED IN THE QUOTE,
  so the quoted output is already net of it and you
  never add it on top when reporting what was spent. The Uniswap pair takes
  the same 25 bps from the input, but Uniswap's routers carry no fee field,
  so it is Vex's own transfer leg after the swap confirms: the swap spends
  `amountIn` minus 25 bps and that 25 bps is transferred to Vex, and the two
  together are exactly `amountIn`, which is what the user is debited.
- Bridges (`BridgeQuote`/`BridgeExecute` and the Relay pair): 25 bps of the
  origin input as a SEPARATE transfer only after the deposit lands. The fee
  follows the origin deposit's success; destination delivery is a separate outcome.
- The generic EVM pair: 25 bps of that transaction's own native `valueWei`,
  as a separate transfer after it confirms. A zero-value transaction - every
  ERC-20 transfer and every approve - pays NOTHING, and nothing is charged
  when the fee would cost more to collect than it is worth.
- pools.fun launches: 25 bps of the native value the launch sends.
- Lighter: 10 bps perpetual and 25 bps spot fees on fills, maker and taker,
  separate from exchange fees; fee authorization is required before trading.
- Virtuals curve buys: 25 bps of committed VIRTUAL, deducted before the curve
  and transferred after confirmation. Sells: 25 bps of proven VIRTUAL proceeds
  after settlement; a quote's sell fee is an estimate. No proven proceeds, no fee.

FREE: every read, quote, preview and research call; `WalletSendPrepare` and
`WalletSendConfirm`; the wrap pair, which is exactly 1:1; every Pendle and
Morpho action; and the Solana lend, borrow and prediction actions, which
carry no Vex fee either. Each protocol section in `.vex/vex-guide.md` states
its own fee. Network gas,
the venue's own protocol fee and bridge relayer costs are NOT Vex's fee -
never conflate them when the user asks what something cost.

### When a tool cannot run

UNAVAILABLE TOOLS: a missing provider key answers a typed configuration_unavailable result naming the variable; vex_ToolSearch shows available: false. It has NOT run. Report both names; do not work around it.

### Scope

PROJECT SCOPE: each connection is bound to one Vex project; its permission and wallet selection are read fresh on every call and can change at any time. Read each result.

### The safety rules

Vex moves REAL funds. Nothing here is a sandbox or testnet.
1. APPROVAL: a restricted destructive call BLOCKS until the user answers Vex's card; the result IS the settled outcome. Never call again while one is unanswered or retry an UNKNOWN outcome.
2. QUOTE FIRST: use quotes/previews if offered; else read current market/position state. Disclose effects, amounts, costs, impact and ETA before acting.
3. AMOUNTS: units are PER FIELD - human decimals or raw smallest units. Read field descriptions; never guess.

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
slippage. That pair routes EVM trades to KyberSwap and Solana to Jupiter
itself; `SwapQuoteUniswap` then `SwapExecuteUniswap` is the Uniswap pair, on a
chain with a verified Vex deployment.

On Robinhood Chain, quote both venues when both price the pair; prefer direct Uniswap when it has a route (V2/V3 only, no v4). KyberSwap drops quiet pools; its USD reference lags. Elsewhere, KyberSwap is the usual first choice. Use Uniswap when KyberSwap is region/edge-blocked, unavailable, mispriced, or on request. Quote both when unsure. Execute on the venue you quoted.

Restate the quote's expected output, price impact, gas and safety verdicts
before executing. Slippage binds the quote you were SHOWN: the execute writes
that floor into the calldata and refuses BY NAME rather than filling worse. So
RE-QUOTE AT THE SAME SLIPPAGE FIRST. Increase `slippageBps` only within the
user's stated limit or after the user authorizes the new worst-case amount.
Announcing a larger bound does not authorize it. On EVM a
quote is refused at or above 15% price impact and when the venue cannot price
the output in USD; on Solana there are no USD figures at all, so only the
impact rule applies. The card names the chain, the tokens, the amounts, the
expected output and the Vex fee when a card is required.

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
is the call that signs and broadcasts, with a card under RESTRICTED. Ask the user
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
only after the authorized decoded effect is re-checked. The decode
set is CLOSED, and router or aggregator calldata is deliberately outside it.
The fee caps are yours to supply and are never derived from a network
estimate; call `vex_ToolDescribe` on the Prepare tool for which caps it
requires and how to obtain the current estimate.

### A destructive tool with no quote counterpart

Some destructive calls have nothing to quote - a rewards claim has no price,
no size and no counterparty. State the expected effect from the READ tools
first (what is claimable, what it is worth, what the gas will cost), say it to
the user, and only then call. A claim is an on-chain transaction that costs
gas and requires a card under RESTRICTED; say so before claiming dust.

### Research

Answer through all three layers before reporting: identity and discovery
(which chain, which contract), depth and price sanity, then narrative and
safety. If a layer is unreachable, continue through the others and say which
layer was unavailable and why. DexScreener indexing lags by minutes to hours
for brand-new tokens, so fresh discovery can precede indexed pair research.
Name the exact chain and contract identity, the source freshness, the observed
liquidity, the missing coverage, and whether the result is research or an
executable quote. A provider label is not proof.

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

---

AGENTS: this section is generated by Vex, between the `vex:studio:begin` and
`vex:studio:end` comment markers. NEVER edit between them, even when asked -
Vex reports the edit as drift and stops regenerating the section until the
user asks Vex for a repair. Text outside the markers belongs to the user.
<!-- vex:studio:end -->
