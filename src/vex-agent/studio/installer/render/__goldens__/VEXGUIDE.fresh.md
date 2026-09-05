<!-- vex:studio:begin vex=0.2.6 hash=b9fed7a42c41b7f4 -->
# Vex guide - project "acme-trading"

The companion to this project's `AGENTS.md`, which carries the authority:
the permission level in force, the selected wallets, how to call the tools,
what a result means and the task shapes. READ THIS FILE AT THE START OF A
SESSION - `AGENTS.md` says so in its first section, and everything here is
part of the same protocol.

## What's new in Vex 0.2.6

The notes below cover the last 8 Vex versions that changed anything
an agent can see. A section or protocol block that one of them names carries
its version beside its own heading.

A note whose subject is a section of `AGENTS.md` names a heading in THAT
file; the sections below are this one's.

- **Vex 0.2.7, changed** `Read these on start`: AGENTS.md now carries the authority alone - this project's permission level, its wallets, how to call the tools, what a result means and the task shapes - and the rest moved WHOLE into `.vex/vex-guide.md`: what's new in Vex, the protocol blocks, building on Vex MCP and the bug bounty. Nothing was shortened. Codex loads AGENTS.md under a 32 KiB total budget and truncates the file rather than splitting it, so what must be in context on every turn is kept short; read the guide at the start of a session, as the first section of AGENTS.md says.
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

Virtuals is intelligence for Virtuals agents and agent tokens across the chains indexed by the provider, and the bonding-curve trading venue for the agents that have not graduated on Base and Robinhood.

- Chains: base, solana, robinhood, ethereum for screening, detail, graduations and genesis. Narrower per capability: trade tape base and solana only; candles for graduated agents everywhere but ethereum, and for bonding agents on all three of those. Curve trading is base and robinhood only: an agent still on its BondingV5 curve is bought and sold HERE on those two chains. Everything else trades elsewhere - a GRADUATED agent through kyberswap on base/ethereum or uniswap on robinhood, and solana through the solana tools, whose curve is a Meteora pool rather than BondingV5. LAUNCHING an agent is base and robinhood only, and immediate normal-mode only.
- Read: Read one agent's bonding-curve trade tape and build a price chart from its pool's ohlcv candles, screen virtuals agents and agent tokens, inspect robinhood agent tokens or one agent in depth, read market cap, holder count and concentration, check the anti-sniper buy-tax window and exact venue, follow recent virtuals graduations or what just graduated, and browse the fresh graduations feed, genesis calendar, launch schedule, and genesis sales.
- Quote: Price a bonding-curve buy or sell of an agent token that has not graduated, on Base or Robinhood: the output, the taxes, the anti-sniper window and the floor the contract will enforce. Research alone still establishes no executable price.
- Act: Execute a bonding-curve buy or sell against a quote already taken, spending real funds under approval, or launch your own agent on Base or Robinhood and cancel a launch the venue keeper has not made live yet. Acquiring a GRADUATED agent token is still a separate swap task on the venue identified by the research result.
- Vex fee: 25 bps of the VIRTUAL you commit on a bonding-curve buy, taken off the input before the curve, and 25 bps of the VIRTUAL a receipt proves you received on a sell, taken as a separate leg after the sale settles; a trade that reverts or cannot be proven is never charged. On an agent LAUNCH, 25 bps of the VIRTUAL you commit, taken off the input, and charged ONLY when Vex has seen the Virtuals keeper launch your agent while it still held your approval - if the keeper is slower than that the launch is recorded awaiting_keeper and the fee is WAIVED PERMANENTLY, never collected later. Cancelling a launch is free. Every Virtuals read is free, a graduated agent trades under its venue's own fee with no second one, and genesis participation is not a path Vex executes at all.

### pools

pools.fun is a no-curve launchpad whose tokens open directly in a real SushiSwap V3 pool with no graduation step.

- Chains: Robinhood Chain (4663) only.
- Read: Browse the pools.fun launchpad and new pools fun launches, search by name or symbol, read price history and full detail for one token, inspect my launches on the Robinhood launchpad, and read creator-fee state.
- Quote: Preview a launch and its current deployment cost without committing. The preview is advisory and cannot predict the final token address. This namespace has no trading quote; acquiring a token requires a separate trading quote on a swap venue.
- Act: Open the launch form for a pools fun coin, launch the coin on pools fun now under the applicable authority, or claim my creator fees after a dry-run simulation. It has no buy or sell action.
- Vex fee: 25 bps of the native value a launch or trade sends; reads are free.

### launchpads

The launchpad-neutral half of a token launch: the shared image locker, and the public content-addressed host a launch's image URL points at.

- Chains: No chain of its own: the locker and its host are chain-agnostic, and one staged picture serves a launch on any chain.
- Read: List the pictures staged in the user's image locker: label, size, format, and whether each already has a public address.
- Quote: Nothing here is priced; publishing a picture costs nothing.
- Act: Publish one staged picture to Vex's public image host, under the ordinary approval card, and record its permanent URL.
- Vex fee: none - the image locker is a read and publishing a picture moves no value, so neither charges anything. The launch a picture is FOR is charged by its own launchpad namespace.

A quote authorizes only the execute in its OWN pair and stays fresh for
15 minutes. A namespace's own execute runs the SAME code path as the
always-loaded front door for that venue: same quote gate, same Vex fee, same
approval card.
A namespaced quote never unlocks the front door, and the front door's
quote never unlocks a namespaced execute.

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

AGENTS: this file is generated by Vex, between the `vex:studio:begin` and
`vex:studio:end` comment markers. NEVER edit between them, even when asked -
Vex reports the edit as drift and stops regenerating the file until the user
asks Vex for a repair. Text outside the markers belongs to the user.
<!-- vex:studio:end -->
