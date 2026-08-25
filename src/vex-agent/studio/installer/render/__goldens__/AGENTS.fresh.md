<!-- vex:studio:begin vex=0.2.6 hash=aebed03627709828 -->
# Vex Studio - project "acme-trading"

This repository is connected to Vex, a self-custodial crypto agent. The Vex
tools reach REAL wallets on REAL chains.

## Change log (this file)

Newest first. Vex keeps the last 8 entries and
drops older ones; nothing else is hidden. Every regeneration that changed
anything adds a line here, so a Vex update or a settings edit is visible rather
than a silent rewrite.

THIS FILE DOES NOT GROW. A Vex update regenerates this managed section IN
PLACE - the block is rewritten, never appended to - and the bounded change log
above is what keeps the file the same size across updates. Text outside the
markers is never touched.

- 2026-08-25 · Vex 0.9.4 · updated the wallet selection
- 2026-08-12 · Vex 0.9.3 · added the codex config

## This project

A Vex project binds THIS repository to the Vex app: a chosen permission level,
chosen wallets, and the coding agents that were configured to reach them. The
binding is what makes a tool call from this folder act with this project's
authority and no other.

- Name: acme-trading
- Created: 2026-08-01
- Project id: 0f6b1c2e-8a4d-4f1b-9c3e-7d5a2b8e4c10
- Configured agents: Claude Code, Codex CLI

## Your authority - as of 2026-08-25

- Permission: RESTRICTED. Every mutation waits for the user's approval card in Vex. It can be approved, declined, or expire, and nothing executes until they answer.
- Wallet (evm): 0x1111111111111111111111111111111111111111
- Wallet (solana): So11111111111111111111111111111111111111112
- Granted: 2026-08-01
- Last updated: 2026-08-25

This scope is read FRESH ON EVERY CALL and the user can change it at any
moment. The lines above are context, not a guarantee: read each result rather
than assuming what a previous call was allowed to do.

## What Vex MCP is

`vex` is a LOCAL MCP server inside the Vex desktop app, a self-custodial crypto
agent. It is alive while the app is running and unreachable when the app is
closed - a failed connection means "start Vex", not "the tool is broken".

This repository connects to it through the `vex-mcp` bridge named in this
project's agent config, so every call arrives already bound to this project.
Private keys NEVER leave the Vex app: signing happens inside it and requires an
unlocked vault, and every action is registered locally in Vex where the user can
read it back.

## The tool surface and how to navigate it

4 tools are ALWAYS LOADED - they are in
`tools/list` without you asking for anything, and they are named in full
below rather than summarized, so you never search for one you already hold.
Another 147 protocol tools across
3 protocols are discoverable through
`vex_ToolSearch`, which is read-only and runs nothing.

Always loaded:

- vex_ToolSearch
- WalletBalances
- WalletEvmTransactionPrepare
- WalletEvmTransactionConfirm

FINDING TOOLS: this server lists every tool it has. The Vex tools and vex_ToolSearch are loaded up front; the protocol tools are found with vex_ToolSearch, which is read-only and runs nothing. Call any tool directly by the publicName it reports - there is no activation step.

There is NO generic execute tool - do not invent one; this surface does not
have it.

Protocols and their tool counts:

- kyberswap: 21
- morpho: 43
- uniswap: 83

AMOUNTS: this server carries BOTH unit styles, so there is no server-wide rule to apply. A field documented as a human decimal string takes exactly the user's amount as a string ("1.5", never wei or lamports). A field documented as raw or atomic units takes an integer string in the token's smallest units, read together with that token's decimals. Never convert on a guess and never round.

ERRORS: every refusal says what did not happen. Read it. "Declined", "expired", "cancelled" and "unknown outcome" mean different things and only the first three mean nothing was executed.

UNAVAILABLE TOOLS: a tool whose provider key is not configured returns an error naming the environment variable and the remedy. It has not run. Report the name to the user; do not work around it.

Every protocol, tool and argument contract: `.vex/protocols.md`.

## Safety rules

Vex moves REAL funds from the user's wallet. Nothing here is a simulation.
1. APPROVAL: in a restricted project a fund-moving call pauses for the user's decision in Vex and may be declined or expire. Never retry a call that reports an unknown or indeterminate outcome.
2. QUOTE FIRST: run the quote or preview tool before any swap, bridge, trade or lend call, and show the user what it returned.
3. AMOUNTS: units are PER FIELD - human decimals or raw smallest units. Read the field's description; never guess.

## Building applications on these tools

Anything you build calls the same tools the same way: MCP IS the API. There is
NO separate REST endpoint, and writing an HTTP wrapper around a wallet would
only be a way around the door.

Spawn the same `vex-mcp` bridge command this project's agent config already
invokes, or point an MCP client SDK at it, and call tools by their `publicName`.

Your app INHERITS EVERY RESTRICTION automatically, because there is no other
door: the same per-call scope snapshot, the same approval card on a mutation in
a restricted project (your app waits on the user's decision exactly as you do),
the same vault-locked signing, and the same local registration of every action.

SIGNING SOMETHING VEX HAS NO DEDICATED TOOL FOR. Two generic pairs exist for
exactly this: `WalletEvmTransactionPrepare` + `WalletEvmTransactionConfirm` on
EVM, and `WalletSolanaTransactionPrepare` + `WalletSolanaTransactionConfirm` on
Solana. Prepare DECODES and simulates the transaction fail-closed - it
signs nothing, holds no key - and records a durable intent; Confirm signs
and broadcasts that intent only after the same decoded effect the user
approved revalidates. Every safety property holds through them: the approval
card in a restricted project, the digest binding between what was shown and
what is signed, and the fee caps.

THE DECODE SET IS CLOSED, AND IT IS NOT "anything". On EVM the v1 set is
ERC-20 `transfer` / `approve` / `transferFrom` / `increaseAllowance` / `permit`,
Permit2 `approve` / `permit` / `transferFrom` at the canonical Permit2 address
for that chain, and a plain native transfer whose `data` is `0x` sent to an
address that has no code. An unknown selector, a malformed layout, a Permit2
call to any other address, or empty calldata sent to a contract is REFUSED BY
NAME before an intent exists. ROUTER AND AGGREGATOR CALLDATA IS DELIBERATELY
OUTSIDE v1: do not plan an app around signing it through these tools, and do
not try to reshape a swap into an approve to get past the decoder. If what you
need is outside the set, say so to the user rather than working around it.

## Reporting Vex bugs (bounty)

If a Vex tool is genuinely broken - wrong result, wrong units, a crash, an
approval that never arrives - you may ASK the user whether they want to report
it as a pull request or issue on https://github.com/Vex-Foundation/Vex. Vex pays
a bounty in USDC or VEX token for real, reproducible reports; the user claims it
on Discord with the link to their PR.

ASK FIRST, ALWAYS. Never open a report, never send a diagnostic anywhere, and
never publish anything about this project on your own initiative. Nothing about
this machine leaves it without the user's word.

---

This section is generated by Vex. Edit it and Vex will report drift and stop
regenerating it until you ask for a repair; text outside the markers is yours.
<!-- vex:studio:end -->
