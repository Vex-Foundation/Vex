# Wave 2 reconnaissance: the prompt stack as it stands before the rebuild

Measured 2026-08-22 on feat/tool-surface-3 at 4ef0cfda (the Batch 3 closure
head), by a read-only Explore pass. Environment posture for every byte
figure: JUPITER, RETTIWT and TAVILY keys absent, the same posture as the Wave
0 baseline, so the deltas are attributable. This document is the evidence
base for the Wave 2 plan under owner decisions D4, D9, D10, D13 and D14.

## 0. Corrections to the Wave 0 ledger

- Ledger open items 1 (missionPromptContext unsanitized) and 2 (missing
  lockstep test) are FIXED on this branch (Batch 3 WP3). Items 3 (unpinned
  copy in response-format.ts, plan.ts PENDING, agent.ts), 4 (no byte-budget
  ratchet) and 5 (protocols.ts has no facade) are still open and Wave 2
  inherits them.
- The ledger's byte figures are stale by 1,604 B: Wave 1 shrank protocols.ts
  from 71,172 to 69,568 B.

## 1. The stack, layer by layer

Entry point buildPromptStack(context, options) at engine/prompts/index.ts:147,
pure and synchronous, returning { staticLayers, turnLayers }; consumed by
core/turn-envelope.ts (static prefix as messages[0] with cacheHint
static_prefix; turn layers as a trailing system message after history).

Static prefix per mode (bytes): agent/restricted 102,128; agent/full 102,829;
mission setup/restricted 108,551; mission setup/full 108,570; mission
run/restricted 107,165; mission run/full 106,980.

| # | Layer | Builder | Bytes (agent/full) | Ledger verdict |
| --- | --- | --- | --- | --- |
| 1 | Identity | identity.ts:66 | 3,716 | mixed |
| 2 | Execution Policy | execution-policy.ts:79 | 1,889 | PRESERVE |
| 3 | Session wallets | wallet-state.ts | 254 | PRESERVE-VERBATIM |
| 4 | Safety Contract | safety-contract.ts | 6,594 | PRESERVE-VERBATIM, all 8 sections |
| 5 | Tool Model | tool-model.ts:59 | 9,343 | mixed, 2 DELETE blocks |
| 6 | Available Protocol Namespaces | protocols.ts:105 | 69,568 | the batch |
| 7 | Memory and Learning | memory-policy.ts | 3,349 | mixed |
| 8 | Research | research.ts:148 | 6,059 | mixed |
| 9 | Response Formatting | response-format.ts | 1,203 | RELOCATE + PRESERVE |
| 10 | Time Rules | runtime-clock.ts | 276 | PRESERVE |
| 11 | mode core | agent.ts 578 / mission-setup.ts 6,919 / mission-run.ts 4,601 | | RELOCATE + PRESERVE-VERBATIM |
| 12 | Loaded Content | index.ts:317 | conditional | PRESERVE-VERBATIM |

Turn layers, pinned order (index.ts:226-307): clock, $VEX own-token banner,
context pressure, resume packet, Memory, Active Plan, Available Tool Map,
Bridge Routing (live), Mission Capital, Iteration N, one-shots, and the
Safety Re-anchor literally last (488 B). Constant floor 633 B restricted,
1,087 B full.

Protocols is 68.1 percent of the agent/restricted prefix.

### The PRESERVE-VERBATIM set Wave 2 must not touch

Structural contracts: S1 static/turn cache split (index.ts:1-23,
turn-envelope.ts:49-59); S2 static determinism; S4 turn layer order; S5
buildPromptStack pure and sync; S6 sentinels and turn-state no-echo
(system-boundary.ts); S7 sanitizer call-site discipline with the sentinel
neutralized first (sanitize.ts:44-49).

Prose: the Loaded Content fence and DATA-ONLY caveat (index.ts:320-333); the
identity precedence preamble, and that it is first; the User profile
subordination clause last (identity.ts:112); the Vex Fee section (25 bps,
input token, only after success, never waivable; identity.ts:159); Session
wallets (the destination allowlist source); every one of the eight Safety
Contract sections; buildBridgeCapabilityPrompt (turn layer, never enumerates
Relay's catalog; protocols.ts:387-413); Memory Routing single-home invariant;
buildRuntimeClockPrompt; mission-setup execution lock, Required Fields, Stop
Condition Semantics; mission-run Critical Rules, Token launches,
buildMissionTurnState; the four context-pressure band branches; the whole
resume-packet module and the Active Memory provenance caveat; the
mission-capital and own-token banners; plan.ts heading-as-subordination;
capability-availability.ts (env NAMES only, never memoized); every
safety-reanchor bullet and its last position.

## 2. protocols.ts anatomy: richness must replace duplication

One 313-line function buildProtocolsPrompt() (protocols.ts:105-370) renders a
registry-derived capability map (26,271 B), a registry-derived chain table
(1,793 B) and six hand-written doctrine sections (41,016 B), plus a turn-layer
builder and a cache keyed on an env fingerprint of requiresEnv NAMES
(protocols.ts:91-103; pinned by prompt-stack-protocols-prompt.test.ts:198-231).

### Capability capsules rendered from navigation metadata

| Namespace | Capsule B | summary | Use when | Use instead | Examples | facets | Try |
| --- | --- | --- | --- | --- | --- | --- | --- |
| khalani | 1,633 | 328 | 468 | 250 | 81 | 233 | 185 |
| relay | 1,085 | 320 | 152 | 151 | 57 | 130 | 191 |
| kyberswap | 1,456 | 390 | 266 | 298 | 87 | 195 | 128 |
| uniswap | 1,157 | 366 | 206 | 172 | 53 | 85 | 187 |
| morpho | 7,305 | 577 | 859 | 226 | 80 | 5,139 | 337 |
| pendle | 3,885 | 339 | 633 | 246 | 78 | 2,309 | 193 |
| trench | 2,308 | 460 | 404 | 375 | 84 | 668 | 230 |
| pools | 2,875 | 450 | 375 | 486 | 82 | 1,178 | 220 |
| solana | 806 | 339 | 225 | 92 | 0 | 0 | 0 (renders "0 actions" without JUPITER_API_KEY, protocols.ts:140-141) |
| dexscreener | 2,304 | 681 | 526 | 206 | 85 | 548 | 209 |
| virtuals | 1,457 | 382 | 276 | 186 | 85 | 264 | 222 |
| all | 26,271 | 4,632 | 4,390 | 2,688 | 772 | 10,749 | 2,102 |

Ledger DELETE class (summary + Use when + Examples + mutating line):
10,178 B. Ledger RELOCATE class (facets + Try): 12,851 B. "Use instead"
(2,688 B) is D8's routing sentence; it renders for all 11 namespaces although
D8 authorizes it only for the four real overlap pairs (protocols.ts:137-139
renders preferInstead whenever present, and every navigation entry sets one).

### Hand-written doctrine sections

| Section | Bytes | Share of protocols | Ledger verdict |
| --- | --- | --- | --- |
| Chain Coverage | 1,793 | 2.6% | PRESERVE (registry-derived) |
| Swap Venue Routing | 3,034 | 4.4% | PRESERVE (money path, D8 pair) |
| Trench Launch | 1,934 | 2.8% | PRESERVE (irreversible ETH) |
| pools.fun Launchpad | 6,079 | 8.7% | PRESERVE condensed |
| Virtuals Agent Tokens | 1,009 | 1.5% | PRESERVE (anti-sniper timing) |
| Fixed Yield (Pendle) | 6,820 | 9.8% | SPLIT |
| Lending (Morpho) | 21,639 | 31.1% | SPLIT |
| Bridge Routing (static half) | 510 | 0.7% | PRESERVE (D8 pair) |

Morpho alone: capsule 7,305 + doctrine 21,639 = 28,944 B = 41.6 percent of
the protocols layer and 28.3 percent of the whole static prefix, for 19 of
167 tools. Virtuals is 1.0 percent and carries the anti-sniper timing rule
that prevents a near-total buy tax.

### Duplication against the injected tool descriptions (lexical term overlap, confirmed by exact-phrase spot checks)

Per-namespace description corpus the model already receives: morpho 62,964 B,
pendle 42,957, solana 29,332, dexscreener 22,422, trench 12,718, pools
11,622, khalani 11,219, kyberswap 6,131, virtuals 3,752, relay 3,263, uniswap
1,759.

DUPLICATED (at least 80 percent term overlap, richness replaces these):
Morpho 32 of 40 bullets (8 at 100 percent: APY bases, USD oracle estimates,
vault net versus market gross, vault quote mandatory, deposit is two
transactions, full-debt repayment, direct versus curated figures, rewards;
"NO CLOSE FACTOR" verbatim in morpho__positions_get, "1.25" in six
descriptions, the permissionless 297,995 percent / 0.04 USD capture in
morpho__markets_discover); Pendle 16 of 20 bullets ("DECAYS to zero at
expiry" verbatim in three descriptions, matured semantics in 15); Trench all
five bullets at 71 to 93 percent ("SPENDS REAL FUNDS AND IS IRREVERSIBLE"
verbatim in trench__launch_execute); pools.fun launch-money bullets 73 to 100
percent ("CURRENT deployment fee" verbatim in pools__launch_preview).

JUDGMENT the descriptions do NOT carry, which must survive as prompt prose
(overlap percent, protocols.ts line):
- Trench exception on Robinhood 4663: a curve token has no KyberSwap route
  (22 percent, :189).
- pools.fun contrast on the same chain, 13 of 13 sampled routed (25, :197).
- virtuals.* is read-only, trade through venue tools (25, :269).
- Robinhood caution: KyberSwap indexed reserves stale on thin pairs, negative
  priceImpact, do NOT retry with higher slippage (30, :188).
- isVerified is anti-impersonation, not a quality signal (33, :273).
- KyberSwap is PRIMARY swap, Khalani PRIMARY bridge; venue tools are
  alternatives (42, :184): the D4 venue policy, which exists nowhere else.
- There is NO plain staking tool; route by family; never substitute a swap
  for a yield position (42, :288): the yield-arbiter cross-namespace rule,
  currently buried inside the Pendle section.
- Do NOT switch venue for a trade-condition failure (43, :186).
- Unlike Trench there is NO byte limit here (44, :252).
- Reads on Robinhood go direct RPC; khalani__token_balances_get does NOT
  cover it (50, :365).
- Switch venue when the primary CANNOT serve the trade, a failure class,
  deliberately non-enumerated (53, :185; :177-179).
- Trading is deliberately NOT in this namespace; never evidence the token is
  untradeable (56, :242).
- Vex only acts on markets it can vouch for; 9 of 100 Base markets passed on
  2026-08-17; a refusal is confidence, not a scam verdict (69, :352).
- Quote and execute on the SAME venue; the runtime enforces this (67, :198,
  :364).

Pattern: duplicated content is per-tool operational (fields, units, bases,
mandatory quote); surviving content is cross-namespace routing, measured
failure modes, negative policy and product-truth framing. That is the D13
line.

Boundary caveat (ledger 2.7): four blocks were relocated INTO the prompt
because their tool description was withheld (safety-contract.ts:12-22,
tool-model.ts:33-44, execution-policy.ts:44-50, context-pressure.ts:51-57).
Deleting a doctrine block is safe only where the Wave 1 description landing
was individually verified; the namespaces above were spot-checked.

## 3. The per-tool inventory in the prompt

- EXAMPLE_TOOL_NAMES_PER_NAMESPACE = 3 (protocols.ts:25, rendered at :143 as
  "Examples: a, b, c", 772 B), pinned by
  prompt-stack-protocols-prompt.test.ts:50.
- The real inventory: 83 distinct publicNames are written into protocols.ts
  prose (30 pendle, 24 morpho, 8 trench, 8 pools, 3 dexscreener, 3 virtuals,
  more), in a layer whose header says "This is a MAP, not a call menu"
  (:117). tool-model.ts names 8 more.
- Dotted globs that name uncallable shapes: kyberswap.* x7, pendle.* x4,
  pools.* x4, solana.* x4, morpho.* x3, khalani.* x2, virtuals.* x2, relay.*,
  uniswap.*, trench.*, dexscreener.* (30 in total), plus solana__lend_*,
  trench__trade_*, kyberswap__swap_* and solana__swap_* (tool-model.ts:87).
  Every namespace heading renders `ns.*` (:134). The NamespaceSummary doc
  comment at :31-35 says rendering a dotted id "would teach an uncallable
  name" and the module then does so 30 times; no test pins the distinction.
  Smallest fix: say once that `ns.*` denotes a namespace and is never a call,
  or drop the notation.

## 4. Venue preference and chain coverage: claims versus proof

- The only statement of D4's preference is protocols.ts:184 ("KyberSwap is
  the PRIMARY swap route and Khalani the PRIMARY bridge route ... always
  callable alternatives, not the default choice"), pinned by
  protocols.test.ts:30 and
  prompt-stack-protocol-doctrine-and-reveal-safety.test.ts:154 and :165.
  Reinforced by the navigation preferInstead fields and the bridge half at
  :363-364; shortcut routing at tool-model.ts:87-88.
- GAP, D13 requires stating it: "Relay is EVM-only in our integration"
  appears nowhere in the prompt (proof: src/tools/relay/chain-client.ts:15,
  :179-183 throws RELAY_UNSUPPORTED_CHAIN unless vmType is evm; health.ts:
  10-11 and :52 refuse vm_type_not_evm by name).
- GAP, D13 requires stating it: "Khalani bridges EVM and Solana" appears
  nowhere in the prompt (proof: khalani/manifest.ts:48-49, "EVM and Solana
  alike", type field eip155 or solana).
- CORRECT, stated in four places: Relay is the only route to Robinhood Chain
  4663 (chain-coverage.ts:67, :91-94; identity.ts:89; the turn layer
  protocols.ts:404; relay/manifest.ts:3; khalani/manifest.ts:53).
- CORRECT: Trench and pools.fun are on 4663 only (protocols.ts:207, :241;
  chain-coverage.ts:49-55).
- CORRECT and S2-safe: the Khalani chain list is a pinned snapshot of 16 EVM
  ids dated 2026-08-17 in the static layer and registry-derived in the turn
  layer (bridge-capability.test.ts:73, :210, :220).
- Frozen-vocabulary conflict (D9 versus D4): embeddings/uniswap/*.ts:16,28
  describe Uniswap as "a HIDDEN fallback after KyberSwap reports no
  route/support". D9 freezes that text; the capability map will say "always
  callable alternative". The author must know.

## 5. Tests that a rebuild touches

No snapshot files exist under src/__tests__/vex-agent/. 304 tests across 26
files carry 773 string assertions on prompt text: 264 pin an invariant that
must survive (sentinels, sanitization, static/turn split, layer order,
re-anchor last, mode and permission gating, approval doctrine presence,
derive-from-registry, money-path facts, fail-soft branches, bounded caps);
40 pin wording a rebuild legitimately changes (doctrine headings, aspect
narratives, Examples publicNames, facets and Try rendering, WebResearch call
shapes, Capability-Orientation vocabulary). Every one of the 40 is a
deliberate contract change that must be stated, per the ledger's DELETE
definition.

Heading-parsing hazard: protocols.test.ts,
prompt-stack-protocols-prompt.test.ts,
prompt-stack-protocol-doctrine-and-reveal-safety.test.ts,
trench-launch-prompt-package.test.ts, prompt-stack-layer-composition.test.ts
and prompt-stack-permission-and-safety.test.ts:161 split the rendered prompt
on "## " / "### " headings or pin H1 strings as layer identity. Renaming a
heading breaks them mechanically. Precondition from the ledger: capture a
byte-exact buildProtocolsPrompt() snapshot under both env fingerprints
(JUPITER_API_KEY present and absent) BEFORE any heading rename.

Coverage gaps a rebuild would not notice: response-format.ts "Tools Are
Internal Machinery" has no test; plan.ts PENDING has no text pin; agent.ts
has only its anti-drift line pinned; memory-section Active Memory caveat and
safety-reanchor versus safety-contract owe parity tests.

## 6. The mode layers

Exactly one mode-core layer is selected by sessionKind and missionRunId
(index.ts:202-214): agent (578 B, six bullets, "do not loop"), mission setup
(6,919 B: Rules, Required Fields, Stop Condition Semantics, Action Plan in
plan mode, Current Draft / Still Missing / READY / Measurability Warnings;
mutations LOCKED regardless of permission), mission run (4,601 B: Runtime
State, Critical Rules, Token launches, Workflow, Mission Contract; proactive
loop plus LoopDefer; adds the Mission Capital and Iteration turn layers).

Restricted versus full lives in execution-policy.ts (six constants at
:91-185): restricted agent requires approval per mutation; full agent
"bypasses only the generic session approval gate, per-tool policies always
apply, does NOT waive the Safety Contract" and gets the WAITING_PATTERN;
mission setup is locked either way; mission run restricted approves per
mutation, full has no generic gate, logs decisions and does not stop on a
recoverable error. WAITING_PATTERN (:33-42) and ERROR_RESPONSE_PATTERN
(:51-55) are single constants so the six variants cannot drift.

Where the approval doctrine Batch 2 moved out of execute_tool lives now:
ERROR_RESPONSE_PATTERN (execution-policy.ts:44-55, all six variants); the
"Reading an injected tool schema" block (tool-model.ts:130-139, ledger DELETE
except the raw-units sentence); pressureAdvisory (context-pressure.ts:51-57,
PRESERVE). Approval authority itself: who may mutate (execution-policy.ts),
what approval means (safety-contract.ts "only the human approves",
PRESERVE-VERBATIM), per-tool authority matrices for the two launch executes
(protocols.ts:229 and :259, plus each description and the handlers): three
copies with money-path tests but no parity test.

## 7. Claude Code's declarative shape mapped onto this stack

Present and correct: identity (identity.ts, though it also carries chain
awareness and the fee, two responsibilities the ledger relocates);
precedence order (stronger than the reference's, and needed more with more
sections); the tool model (the deferred-schema loop at tool-model.ts:112 is
carried nowhere else); the Available Tool Map turn layer; the doctrine
layers (the strongest part of the stack).

Present but split: modes, across execution-policy.ts, the mode core and the
identity "current aspect" narrative.

Mostly missing: task shapes. research.ts:82 Token Research Map (~3,300 B) is
the only one, organized by namespace, which is why it failed as a map in
the live Robinhood session.

Inverted: 68.1 percent of the prefix is an inventory whose header claims to
be a map; doctrine is organized by protocol, so the cross-namespace rules
that decide behavior are buried inside protocol sections (the yield arbiter
at :288 inside Fixed Yield (Pendle), the launchpad contrast at :189 and :197
inside Swap Venue Routing); budget does not follow decision weight (Morpho
28.3 percent of the prefix, Virtuals 1.0); "Use instead" pushes for all 11
namespaces where D8 allows four pairs.

Missing outright: a byte-budget ratchet; a task-shape layer; the Relay
EVM-only and Khalani EVM-plus-Solana facts; a facade for protocols.ts (one
function owns the map, six doctrine sections, a turn-layer builder and a
cache lifecycle).

## 8. Per-namespace author packet

Shared reading for every author: navigation/types.ts (summary, whenToUse,
preferInstead, exampleQueries, aliases, discoveryHints, facets),
protocols/descriptions.ts (the map's only source), protocols/catalog.ts,
protocols/_embedding-text.ts. D9 consequence: the frozen embeddingText
(about 74 KB, 632 aliases, 388 example intents across 11 namespaces) is the
vocabulary the capability map must echo so the model's own ToolSearch
queries hit the index; the author picks which frozen terms the map surfaces
and says which it drops.

| ns | Manifests | Navigation entry (bytes) | Doctrine (bytes) | Frozen vocabulary to echo |
| --- | --- | --- | --- | --- |
| khalani | protocols/khalani/manifest.ts | khalani.ts (2,409) | Bridge Routing (510) | bridge chains, supported bridge networks, cross-chain networks, bridge quote, route quote, amount in smallest units, source/destination chain id |
| relay | protocols/relay/manifests/bridge.ts, plus src/tools/relay/chain-client.ts:179 and health.ts:52 (EVM-only) | relay.ts (1,648) | in Bridge Routing and Chain Coverage | relay quote, bridge quote to robinhood, bridge to/from robinhood, fund robinhood |
| kyberswap | protocols/kyberswap/manifests/ (3) | kyberswap.ts (2,993) | Swap Venue Routing (3,034) | swap quote, route preview, best route, price impact, slippage preview, RFQ liquidity, execute swap, sell/buy token, exit position, honeypot, fee on transfer, FOT, token tax, token safety, scam token, supported networks, chain ids, feature matrix, live chain status |
| uniswap | protocols/uniswap/manifests/swap.ts | uniswap.ts (2,621) | shares Swap Venue Routing | uniswap quote, uniswap route preview, robinhood swap quote, v2 v3 best route, uniswap fallback swap (frozen text says HIDDEN fallback) |
| morpho | protocols/morpho/manifests/ (21) plus Morpho.md | morpho.ts (14,225) | Lending (Morpho) (21,639) | morpho markets, lend stablecoins, where to earn interest, borrow against collateral, variable lending rate, supply apy, health factor, am I going to be liquidated, bad debt, liquidation threshold, curated vault, metamorpho, vault apy, passive earn, managed deposit, gated vault, vault timelock, share price, claimable rewards, merkl rewards, token allowance, unlimited approval, supply/withdraw collateral, borrow, repay, direct lend, skip the curator |
| pendle | protocols/pendle/manifests/ (14) | pendle.ts (7,197) | Fixed Yield (Pendle) (6,820) | fixed yield markets, pendle PT list, implied apy, lock fixed yield, exit fixed yield early, redeem PT, matured, YT / yield token / variable yield exposure, py mint/redeem, split into pt yt, lp add/remove, single-token lp add, sy mint/redeem, standardised yield wrap, pt rollover, extend fixed rate, move maturity, lp transfer, lp to pt, order book, merkle rewards |
| trench | protocols/trench/manifests/ (9) | trench.ts (3,958) | Trench Launch (1,934) | trench launchpad tokens, bonding curve tokens, trench express, trench trade quote, curve buy/sell quote, price impact, image locker, trench photos, launch images, launch preview, token launch dry run, ask to launch a token, open the launch form, deploy the token, my launches |
| pools | protocols/pools/manifests/ (9) plus src/tools/pools-fun/PoolsFun.md | pools.ts (5,283) | pools.fun Launchpad (6,079) | pools fun tokens, pools.fun launchpad, robinhood launchpad tokens, sushi launchpad tokens, price history/ohlc/candles, token detail, fee split, pool address, my pools fun launches, launch cost/estimate, launch form, deploy my coin, claim creator fees |
| solana | protocols/solana-jupiter/manifests/ (5) | solana.ts (2,174) | none (one clause at protocols.ts:285-288) | jupiter/solana price lookup, spl token search, resolve solana mint, fresh solana tokens, jupiter quote, swap on solana, ape solana, prediction market, jupiter predict, yes/no share, outcome shares, open positions, claim payout, order book, market depth, leaderboard, vault balance |
| dexscreener | protocols/dexscreener/manifests/ (7) | dexscreener.ts (3,652) | none (identity.ts positions it; freshness lag in the Token Research Map) | find token by name or symbol, resolve ticker to token address, inspect known pool address, pair liquidity analytics, batch exact token addresses, portfolio address pricing, token profiles, paid token boosts, trending narratives, hot metas, promotion orders, token ad placements |
| virtuals | protocols/virtuals/manifest.ts | virtuals.ts (2,354) | Virtuals Agent Tokens (1,009) | virtuals agents, agent tokens, robinhood agent tokens, virtuals screener, agent id lookup, anti-sniper window, recent graduations, just graduated, graduation feed, genesis calendar, launch schedule, genesis sales |

## 9. Constraints the rebuild carries

- protocols.ts exports four symbols with external consumers
  (buildProtocolsPrompt, buildBridgeCapabilityPrompt,
  resetProtocolsPromptCache, protocolAvailabilityFingerprint); the env
  fingerprint cache must keep keying on requiresEnv NAMES, and
  capability-availability.ts must never be memoized.
- Every Safety Contract section, the fee basis, the session-wallet
  allowlist, the two launch authority matrices, the Morpho 1.25 floor
  framing, the Virtuals anti-sniper window and the pools.fun dynamic-fee and
  no-predicted-address rules are irreversible-effect facts: rule 00 hard
  stop on any semantic change.
- Measurement posture for the Wave 2 delta: the same absent keys as the
  baseline, or the delta is not attributable.
