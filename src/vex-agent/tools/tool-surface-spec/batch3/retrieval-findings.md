# Retrieval verification: per-namespace findings

Batch 3 closure, 2026-08-22. One author agent per namespace read ONLY the
namespace's manifests and navigation entry (never the frozen embeddingText,
never the existing datasets), wrote at least one blind and one protocol-aware
query per live tool into `src/__tests__/eval/datasets/tool-discovery-<ns>.json`,
and validated it offline with `tool-retrieval-probe --namespace <ns>
--validate-only`. The coordinator then ran the dense path sequentially against
the eval database (134 candidates, every row `method: dense`). Numbers are in
the measurement section; this file also keeps the authors' description-quality
findings, which are evidence for the D9 retrieval exercise and for a later
description pass, not edits (descriptions are a contract artifact after Wave 1
and embeddingText is frozen by D9).

Ground truth for the dense lane: the canonical 116-query seed misses three
of the four floors in `src/__tests__/eval/dense-quality-floors.ts` (overall
recall@5 0.94 against 0.95, overall mrr@5 0.868 against 0.88, protocol-aware
recall@5 0.918 against 0.98; blind recall@5 0.964 clears 0.94), so the dense
runner stops before any baseline writer (open decision O18). Nothing in
Batch 3 can have moved it: the index text is frozen (D9).

## Datasets authored

| Namespace | Tools | Rows (blind / protocol-aware) | Validator |
| --- | --- | --- | --- |
| morpho | 19 | 57 (38 / 19) | valid, coverage complete, no identity leaked |
| pendle | 29 | 67 (35 / 32) | valid, coverage complete, no identity leaked |
| trench | 10 | 24 (14 / 10) | valid, coverage complete, no identity leaked |
| dexscreener | 12 | 35 (23 / 12) | valid, coverage complete, no identity leaked |
| khalani | 9 | 27 (18 / 9) | valid, coverage complete, no identity leaked |
| pools | 9 | 19 (9 / 10) | valid, coverage complete, no identity leaked |
| solana | 34 | 68 (34 / 34) | valid, coverage complete, no identity leaked |
| kyberswap | 4 | 20 (12 / 8) | valid, coverage complete, no identity leaked |
| uniswap | 2 | 12 (7 / 5) | valid, coverage complete, no identity leaked |
| relay | 2 | 11 (5 / 6) | valid, coverage complete, no identity leaked |
| virtuals | 4 | 17 (7 / 10) | valid, coverage complete, no identity leaked |

Total: 357 dataset rows over 134 tools, every tool with at least one blind
and one protocol-aware row. (The authors' reports summed to 364 because two
of them counted their quote-then-execute workflow rows under both tools they
cover; 357 is the row count of the JSON files and the figure the probe
measured.) The kyberswap and uniswap authors deliberately wrote
near-parallel blind swap rows so the D11 expectation (both venues' quote tools
surfacing together) can be observed rather than assumed.

Scenario vocabulary gap reported by two authors: the harness `SCENARIOS` enum
has no launchpad or token-creation value, so launch rows use `workflow`.

## Description-quality findings from the authors

These are the places where a blind query was hard to write because two
descriptions say the same thing, or a description buries its own purpose.
Each is a candidate for the metadata-only description pass (O2) and for the D9
retrieval benchmark; none was edited.

### morpho

- `morpho__markets_discover` vs `morpho__market_get`: discovery already
  promises depth, oracle, liquidity and warnings per market, which is also
  what `market_get` sells; only a known `marketId` separates them and neither
  states that routing trigger in one sentence.
- `morpho__market_supply` vs `morpho__vault_deposit`: both are "put an asset
  somewhere to earn"; blind "where do I earn on USDC" sits between them and
  both discover tools, and the separating words (isolated pair, curator fee)
  are vocabulary a user rarely types.
- `morpho__market_quote` vs `morpho__vault_quote`: near-identical purpose
  statements; a generic "simulate my deposit before signing" is unresolvable
  from the descriptions alone.
- `morpho__market_withdraw` vs `morpho__market_withdraw_collateral`: both
  "take my token back out of this market"; the lender-versus-collateral
  split depends on the user knowing which leg they hold.
- `morpho__wallet_balance_get`: its own text defers plain balance questions
  to `WalletBalances` and `ChainRead`, so only the allowance audit is
  reliably reachable by query.
- `morpho__vaults_discover` vs `morpho__vault_get`: both answer "is this
  vault gated"; neither says which owns the question.
- `morpho__markets_activity_list`: "who liquidated me" (activity) and "am I
  close to liquidation" (positions) read alike; the history tool does not
  warn off personal-risk phrasing.

### pendle

- `pendle__pt_quote` (and likewise `pendle__lp_quote`, `pendle__py_quote`):
  one quote covers buy, early sell and matured redeem, so "what would this
  cost" cannot be written to separate three downstream actions.
- `pendle__lp_quote` vs `pendle__lp_add` with dryRun: "estimate depositing
  2000 USDC into that pool" reads as either; the distinction is a protocol
  precondition, not a user need.
- `pendle__lp_add` vs `pendle__lp_add_keep_yt`: the difference is what
  happens to the produced YT, which users never state; the plain add does
  not say it sells the YT until the sibling is read.
- `pendle__lp_remove` vs `pendle__lp_remove_dual`: both "withdraw my
  liquidity"; the plain remove does not say up front that it exits to one
  token.
- `pendle__lp_to_pt` vs `pendle__pt_rollover` vs `pendle__lp_transfer`: all
  three "move a position without withdrawing", each scoped by a CANNOT list
  that cross-references the other two.
- `pendle__py_redeem` vs `pendle__pt_redeem`: separated only by expiry state
  and whether the YT leg is held, which users rarely volunteer.
- `pendle__rewards_claim` vs `pendle__merkle_rewards_list`: both answer
  "what have my positions earned"; only the merkle tool says the other pot
  exists, and its name suggests a mutation while it is read-only.
- `pendle__market_candles_get` vs `pendle__market_history_get` vs
  `pendle__asset_prices_get`: three overlapping price and time surfaces whose
  "when to use" is defined mostly by what each gets wrong.
- `pendle__market_orderbook_get`: clear, but deliberately non-actionable
  (Vex cannot fill those orders); worth deciding whether trading intent
  should reach it at all.

### trench

- `trench__tokens_discover` vs `trench__tokens_search`: one clause separates
  them ("cannot name a token yet" vs "resolves one they can name") while the
  search repeats the discover's row vocabulary.
- `trench__launch_preview`: dominated by parameter and output enumeration;
  the distinguishing intent ("what will this cost, without deploying") is
  buried.
- `trench__launch_request_form` vs `trench__launch_execute`: both open with
  creating a token and consent; the discriminator (who signs, the restricted
  rule) is mid-paragraph in both.
- `trench__images_list`: written as a planning obligation and an app-UI
  instruction rather than a capability a user asks for.
- `trench__trade_quote` vs `trench__trade_execute`: the fee explanation is
  repeated nearly verbatim in both.

### dexscreener

- `dexscreener__pairs_get` vs `dexscreener__token_pairs_list`: both open
  with pool liquidity, volume and price-change language; only the input key
  (pair address vs token address) separates them.
- `dexscreener__tokens_get` vs `dexscreener__token_pairs_list`: a plain
  "price these tokens" intent points at two tools; the separator is "many
  addresses at once" vs "one token, all its pools".
- `dexscreener__attention_list`: purpose stated only negatively, no positive
  user outcome to query against.
- `dexscreener__boosts_list` vs `dexscreener__ads_list`: both "paid
  visibility" with near-identical framing.
- `dexscreener__profiles_list` vs `dexscreener__community_takeovers_list`:
  both name CTO prominently; the axis (per-token flag vs recent window) is
  buried.
- `dexscreener__pairs_search`: mostly caveat text; the retrievable purpose
  ("name or ticker to pool") is a small fraction.

### khalani

- `khalani__tokens_search`: stated mostly as a redirection to the
  `TokenFind` shortcut, so its own positive trigger must be inferred.
- `khalani__tokens_top_list` vs `khalani__tokens_search`: identical row
  shape; the only separator is "popularity list, not a resolver".
- `khalani__tokens_autocomplete`: distinct from search only by a half-typed
  input phrase.
- `khalani__token_balances_get` vs `WalletBalances`: "what do I hold across
  chains" is ambiguous between them.
- `khalani__orders_list` vs `khalani__order_get`: separated by whether an
  order id is in hand, a parameter fact rather than an intent.
- `khalani__bridge_quote_get`: deadline, fee policy and rejected-parameter
  text crowd out the plain "what would arrive and how long" purpose.
- `khalani__bridge_execute`: most of its length is post-execution status
  semantics, which reads close to the order-tracking tools.

### pools

- `pools__tokens_discover` vs `pools__tokens_search`: discover advertises a
  free-text `query` filter and search returns "the same rows"; the separator
  is a soft hint inside a param.
- `pools__my_launches_list` vs `pools__tokens_discover` with
  `deployerAddress` and `isOwnLaunch`: "what did I launch" is expressible
  through both.
- `pools__fees_claim`: one tool serves both "what would I get" (dryRun) and
  "claim it", overlapping `includeClaimable` on `pools__my_launches_list`.
- `pools__launch_preview` vs `pools__launch_request_form`: same kind, same
  params, both "spend nothing, sign nothing"; only intent wording differs.
- `pools__token_candles_list`: carries two sibling tools' purposes alongside
  its own.
- `pools__launch_execute`: front-loads refusal conditions, authority modes and
  the 13 pre-sign proofs before the returned fields.

### solana

- `solana__predict_events_discover` / `solana__predict_events_search` /
  `solana__predict_suggested_events_list`: same projected row shape,
  differing only by how the user arrived (browse, keyword, wallet), so
  "prediction markets about X" without a cue is ambiguous between three.
- `solana__predict_positions_list` / `solana__predict_position_get`: the
  singular reader is a near-verbatim field list of the plural; only "by its
  positionPubkey" separates them.
- `solana__predict_order_get` / `solana__predict_order_status_get`: both
  "read one order by orderPubkey"; the split is an implementation fact (the
  on-chain account closes on fill).
- `solana__predict_trades_list` / `solana__predict_trade_history_list`:
  global-venue vs own-wallet scope, with names that invert the expected
  reading (the history one is the personal one).
- `solana__predict_market_get` / `solana__predict_orderbook_get`: both
  answer "what does this contract cost"; top-of-book vs depth is a
  distinction only a sizing-aware caller makes.
- `solana__predict_vault_get`: "vault" collides with the Lend Borrow vault
  vocabulary while meaning the venue's treasury account; the description
  says so defensively.
- `solana__lend_earn_withdraw` / `solana__lend_borrow_operate`: Earn's
  opening clause disclaims Borrow's collateral withdrawal, and Borrow's
  `withdrawAmountRaw` / `withdrawAll` are named identically, so "withdraw
  from my Solana lending position" has two honest owners.
- `solana__token_prices_get` / `solana__tokens_search`: search also returns
  a price per row, so "what is BONK worth" is answerable by either.
- `solana__predict_pnl_history_get`: opens with the outage notice before its
  purpose, so its most retrievable text is about a 404 (kept per D12).
- `solana__swap_quote`: "when to use" is buried behind the slippage, tip and
  priority-fee parameter essay shared with execute; quote and execute read
  almost identically apart from one BROADCAST sentence.

### kyberswap and uniswap

- `kyberswap__token_safety_check`: its own text says it is "not required
  before a swap" because `kyberswap__swap_quote` reports the same audit for
  both legs, so the two compete for any "is this token a scam before I buy"
  query.
- `kyberswap__chains_list`: framed almost entirely as a spelling helper for
  the `chain` param of the other tools; the only user outcome named is
  "which networks KyberSwap covers".
- `uniswap__swap_quote` and `uniswap__swap_execute`: both end with the
  identical two-sentence fallback clause (KyberSwap is primary; use this when
  it cannot serve the pair), so the fallback intent cannot separate quote
  from execute.
- Navigation entry `entries-market/kyberswap.ts`: the "Chains and token
  safety" facet advertises "search token metadata" / "token search", but the
  namespace has no token-search tool (only `kyberswap.tokens.check`). A query
  written from that hint expects a tool that does not exist. Candidate
  navigation fix (metadata).
- Frozen index text (D9, not edited): `protocols/embeddings/kyberswap/
  swap.ts:31` still says "Requires a fresh matching kyberswap.swap.quote
  first", a dotted id the model can never call, while the parallel Uniswap
  sentence was swept to `uniswap__swap_quote`. The embeddingText is retrieval
  input only, so no model reads it, but the D9 exercise should sweep it.
- Lexical fallback sensitivity (Builder 4, measured): a publicName
  cross-reference inside a description normalizes to a phrase (`trench__
  tokens_search` becomes "trench tokens search"), which the lexical scorer
  credits at description weight; that is how `trench.tokens` (score 127)
  overtook `khalani.tokens.search` (105) for the query "tokens.search". Every
  cross-reference Wave 1 added can shift a lexical ranking the same way. Under
  D11 the lexical lane is the fallback only; the D9 exercise should decide
  whether cross-references are excluded from the scored description field.

### relay and virtuals

- `relay__bridge_quote_get` and `relay__bridge_execute`: four near-identical
  paragraphs (the fee sentence, the `amountRaw` sentence, the Khalani
  preference block twice). The only distinctive content is "PREVIEW without
  signing" vs "Execute a REAL ... SPENDS FUNDS"; the largest retrieval risk
  in these two namespaces, and the execute embeds the quote's public name in
  its own text.
- `virtuals__agents_discover` and `virtuals__graduations_list`: graduations
  returns "the same fields virtuals__agents_discover returns" plus the same
  windowing paragraph; "graduated agent tokens on Base" matches both.
- `virtuals__agent_get`: its "when to use" is a buying instruction (always
  call before buying a graduated agent) and the anti-sniper block is also in
  the two list tools' rows, so "check the anti-sniper window" is ambiguous
  between three tools.
- `virtuals__genesis_launches_list`: the only tool with no `chain` param,
  yet it opens with "mostly on Base"; it also mixes upcoming launches and
  sale history in one sentence with no guidance on which params serve which.

## Measurement

Dense path, global retrieval (no namespace argument), limit 5, 134
candidates on every row, every row `method: dense`, run sequentially by the
coordinator on 2026-08-22 against the eval database (tool vectors
re-embedded from the frozen embeddingText the same day). `hitRank` is
1-based; MISS means the expected tool was not in the top 5.

| Namespace | Rows | recall@1 | recall@5 | mrr@5 | Misses |
| --- | --- | --- | --- | --- | --- |
| morpho | 57 | 0.719 | 0.965 | 0.822 | 2 |
| pendle | 67 | 0.851 | 0.940 | 0.891 | 4 |
| trench | 24 | 0.792 | 0.958 | 0.858 | 1 |
| dexscreener | 35 | 0.771 | 0.971 | 0.860 | 1 |
| khalani | 27 | 0.667 | 0.926 | 0.760 | 2 |
| pools | 19 | 0.789 | 0.947 | 0.868 | 1 |
| solana | 68 | 0.838 | 0.985 | 0.902 | 1 |
| kyberswap | 20 | 0.750 | 0.900 | 0.825 | 2 |
| uniswap | 12 | 0.750 | 0.917 | 0.794 | 1 |
| relay | 11 | 0.909 | 1.000 | 0.955 | 0 |
| virtuals | 17 | 0.882 | 1.000 | 0.941 | 0 |
| all | 357 | | 15 misses of 357 rows = 0.958 | | 15 |

Against the four dense floors (`dense-quality-floors.ts`: overall recall@5
0.95, blind 0.94, protocol-aware 0.98, mrr@5 0.88), measured by the
per-target dense runner on 2026-08-22: relay and virtuals clear every floor
and have dense baselines; dexscreener and morpho miss only mrr@5; solana
misses only protocol-aware recall@5 (0.971); trench misses mrr@5 and blind
recall@5; khalani, kyberswap, pendle, pools and uniswap miss three floors
each; the supplemental dataset misses blind recall@5 because it has no
blind rows at all. Whether one canonical-calibrated floor set should gate
every dataset is open decision O18.

### The misses, with what ranked instead

Every miss below is a D9 finding: the index text is frozen, and the
descriptions cannot move the dense ranking. Patterns are named after the
list.

morpho (2 of 57):
- "is this lending pair still being used at all, list the supplies and
  borrows in the last week" expected `morpho.markets.activity`; top 5 were
  solana lend borrow positions, operate, vaults, `morpho__positions_get`,
  solana lend earn positions. Activity history lost to position readers.
- "price pulling 0.5 wstETH of collateral back out of this lending pair
  without doing it" expected `morpho.market.quote`; top 5 were
  `morpho__market_withdraw_collateral`, `morpho__market_withdraw`, solana
  borrow operate, `morpho__market_borrow`, solana earn withdraw. The execute
  outranked its own quote for a "price it, do not do it" phrasing.

pendle (4 of 67):
- "how much fixed yield would I get if I put 5000 USDC into this maturity,
  price it first" expected `pendle.pt.quote`; got markets discover, solana
  earn rates, `pendle__yt_buy`, `pendle__pt_buy`, solana earn deposit.
- "preview what selling my principal token early would return in USDC on
  ethereum" expected `pendle.pt.quote`; got `pendle__pt_sell`,
  `pendle__yt_sell`, `kyberswap__swap_quote`, `solana__swap_quote`,
  `pendle__sy_redeem`. The sell execute outranked the quote that prices it.
- "quote the Pendle yield token side both ways for 100 USDC on base"
  expected `pendle.yt.quote`; got `pendle__py_mint`, `pendle__yt_buy`,
  `pendle__pt_buy`, `pendle__yt_sell`, `pendle__pt_sell`. Protocol-aware
  and still missed: the quote is outranked by four executes.
- "estimate what depositing 2000 USDC into that yield pool would give me in
  pool tokens" expected `pendle.lp.quote`; got solana earn deposit,
  `pendle__lp_add_keep_yt`, solana earn rates, `pendle__sy_mint`,
  `pendle__yt_buy`.

trench (1 of 24):
- "find a launchpad coin whose ticker is DOGWIF on Robinhood Chain" expected
  `trench.search`; got `pools__tokens_search`, `pools__tokens_discover`,
  `pools__my_launches_list`, `trench__tokens_discover`, `pools__token_get`.
  The two Robinhood Chain launchpads collide on "launchpad coin on Robinhood
  Chain"; the blind query carries no venue cue.

dexscreener (1 of 35):
- "price 30 token contract addresses I hold on Solana all at once for a
  portfolio snapshot" expected `dexscreener.tokens`; got
  `solana__token_prices_get`, `khalani__token_balances_get`,
  `solana__tokens_search`, `solana__swap_quote`, `khalani__tokens_search`.
  Arguably a correct answer: the Solana price reader is a legitimate owner
  of that query; the dataset row is defensible but not the only truth.

khalani (2 of 27):
- "find a funded network holding enough USDT before I price a transfer"
  expected `khalani.tokens.balances`; got `uniswap__swap_quote`, pendle
  markets discover, pendle market get, `kyberswap__swap_quote`,
  `pendle__pt_buy`. Nothing bridge-shaped in the top 5: the query's words
  (funded, network, price a transfer) did not reach the balance reader.
- "how much USDC would land on Base if I send 500 from Ethereum and how
  long does it take" expected `khalani.quote.get`; got
  `kyberswap__swap_execute`, `khalani__bridge_execute`,
  `kyberswap__swap_quote`, pendle markets discover,
  `khalani__tokens_autocomplete`. The bridge execute outranked the bridge
  quote for a "how much would land" phrasing.

pools (1 of 19):
- "deploy the token now on Robinhood Chain: name Moon Cat, ticker MCAT,
  paired against ETH, 0.02 ETH prebuy, using the staged image" expected
  `pools.launch_execute`; got `pools__launch_preview`,
  `relay__bridge_quote_get`, `trench__launch_preview`,
  `pools__tokens_search`, `relay__bridge_execute`. The preview outranked the
  execute for an explicit "deploy now".

solana (1 of 68):
- "Jupiter routed quote for SOL to JUP with price impact and the full fee
  breakdown" expected `solana.swap.quote`; got `solana__swap_execute`,
  `solana__predict_order_get`, `solana__predict_market_get`,
  `solana__lend_borrow_operate`, `solana__predict_sell`. Protocol-aware and
  still missed: the swap execute outranked the swap quote.

kyberswap (2 of 20):
- "how much WETH would I get for 500 USDC on Base right now, no signing"
  expected `kyberswap.swap.quote`; got `trench__trade_quote`,
  `pendle__market_get`, `dexscreener__tokens_get`,
  `pendle__markets_discover`, `trench__trade_execute`. A plain "how much
  would I get" with no venue cue went to the launchpad quote and to price
  readers.
- "best routed price across many DEXes for an exact-input trade on
  Optimism, including gas cost and which pools the route crosses" expected
  `kyberswap.swap.quote`; got `dexscreener__token_pairs_list`,
  `kyberswap__swap_execute`, `uniswap__swap_quote`, `dexscreener__tokens_get`,
  `dexscreener__pairs_search`. The execute outranked its quote again, and
  the sibling venue's quote was in the top 5 while the intended one was not.

uniswap (1 of 12):
- "go ahead with the spot pool trade we priced, 1 ETH into USDC on
  Ethereum, broadcast from my wallet" expected `uniswap.swap.execute`; got
  `trench__trade_execute`, `pendle__lp_transfer`, `solana__swap_execute`,
  `kyberswap__swap_execute`, `morpho__market_supply`. Every execute of every
  venue came before the fallback venue's; consistent with D4 (KyberSwap
  primary) and with nothing in the query naming Uniswap.

relay and virtuals: no misses (11 and 17 rows).

D11 evidence, the venue pair: the blind kyberswap row "price 2 ETH into
USDC on Arbitrum before trading, show the rate and price impact" returned
`kyberswap__swap_quote` first and `uniswap__swap_quote` second; the blind
uniswap row "price 2 ETH into USDC on Ethereum against the pools directly,
show output amount and price impact" returned `dexscreener__token_pairs_list`,
`kyberswap__swap_quote`, `solana__token_prices_get`, `dexscreener__pairs_get`,
`uniswap__swap_quote`. Both venues' quotes co-surface in the top 5 for a
plain swap query, with KyberSwap ahead, which is the outcome D4 and D11 ask
for.

### The canonical seed on the same index (116 rows, measured the same way)

overall recall@1 0.81, recall@5 0.94, coverage@5 0.888, mrr@5 0.868;
blind (55 rows) recall@5 0.964; protocol-aware (61 rows) recall@5 0.918;
every row dense, 134 candidates. Seven misses:

- "what chains can I move USDC between" expected `khalani.chains.list`; got
  `khalani.bridge`, `pendle.lp.transfer`, `kyberswap.swap.execute`,
  `relay.bridge`, `khalani.tokens.top`.
- "estimate moving 250 USDC from Ethereum to Solana" expected
  `khalani.quote.get`; got `solana.swap.execute`, `solana.swap.quote`,
  `solana.prices`, `khalani.bridge`, `solana.tokens.search`.
- "use Khalani to estimate USDC from Ethereum to Base" expected
  `khalani.quote.get`; got `khalani.bridge` first, then four khalani token
  readers. Execute over quote, protocol-aware.
- "use KyberSwap to find PEPE on BNB Chain" expected `khalani.tokens.search`;
  got the four kyberswap tools and `uniswap.swap.quote`. The seed's
  expectation predates the KyberSwap-phrased routing and is itself
  questionable; a D9 dataset review item, not a retrieval defect.
- "use Jupiter to check SOL and JUP prices" expected `solana.prices`; got
  four predict readers and `solana.swap.execute`.
- "use Jupiter for trending Solana tokens" expected
  `solana.tokens.trending`; got `solana.swap.execute` and four predict tools.
- "use Jupiter to estimate SOL to USDC" expected `solana.swap.quote`; got
  `solana.swap.execute`, three lend tools, `solana.predict.sell`. Execute
  over quote again.

Scenario recall@5 on the seed: account_history 1, bridge 0.8, evm_lp 1,
evm_swap 0.923, limit_order 0 (one row), market_research 0.962,
prediction_discovery 1, prediction_trading 1, rewards 0 (one row),
solana_lend 1, solana_swap 0.75, token_safety 1, workflow 1.

This is the 0.94 that sits under the 0.95 floor (O18). Three of the seven
seed misses are the same quote-versus-execute inversion the per-namespace
datasets found, so the pattern is in the index, not in how the new rows
were written.

### The lexical fallback on the same datasets (full 134-tool catalog)

The lexical scorer runs only when the embedding model, database or table
fails (`protocols/dense-score.ts`), so the model never sees these numbers
while the sidecar is up; they are the bad-day path and a regression guard
(D11). Captured as baselines `src/__tests__/eval/baselines/lexical*.json`
after the requiresEnv sentinels made the catalog the full 134 (an earlier
capture on a 100-tool catalog, with the Solana tools hidden, was wrong and
was replaced; the Solana baseline had read zero for every row).

| Dataset | recall@1 | recall@5 | mrr@5 |
| --- | --- | --- | --- |
| canonical seed (116) | 0.509 | 0.672 | 0.569 |
| supplemental (12) | 0.417 | 0.917 | 0.565 |
| pools | 0.684 | 0.895 | 0.789 |
| morpho | 0.474 | 0.842 | 0.616 |
| dexscreener | 0.457 | 0.800 | 0.588 |
| relay | 0.273 | 0.727 | 0.412 |
| trench | 0.375 | 0.667 | 0.497 |
| virtuals | 0.412 | 0.647 | 0.492 |
| pendle | 0.254 | 0.642 | 0.398 |
| solana | 0.441 | 0.603 | 0.496 |
| kyberswap | 0.200 | 0.400 | 0.279 |
| uniswap | 0.083 | 0.333 | 0.163 |
| khalani | 0.074 | 0.148 | 0.100 |

Reading: the fallback is far below the dense path everywhere, and collapses
on the namespaces whose queries are phrased in user language rather than in
the vocabulary of the descriptions (khalani, uniswap, kyberswap). If the
sidecar is down, retrieval quality drops from about 96 percent to between
15 and 90 percent depending on the protocol. That is a product risk worth
a health signal in the UI, and a D9 item, not a Batch 3 change.

Patterns across all eleven namespaces:
1. Quote versus execute is the dominant confusion in BOTH directions: four
   misses are a quote query answered by its execute (morpho market quote,
   pendle pt quote twice, pendle yt quote, khalani bridge quote), one is an
   execute query answered by its preview (pools launch). This matches the
   authors' finding that quote and execute descriptions share most of their
   text; in the frozen embeddingText the same sharing evidently holds.
2. Cross-protocol bleed from Solana lend tools into EVM lending queries
   (morpho activity, pendle lp quote): "deposit", "positions", "rates"
   vocabulary is shared across lend families.
3. Launchpad collision between trench and pools on Robinhood Chain when the
   query names the chain but not the venue.
4. Recall@1 is the weak metric (0.67 to 0.85): the right tool is usually in
   the top 5 but often not first, which is acceptable for a model that
   reads five slim rows, and is exactly the D11 outcome for overlapping
   pairs.
