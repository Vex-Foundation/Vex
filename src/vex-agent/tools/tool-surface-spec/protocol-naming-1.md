# Protocol publicName Map, Part 1

Namespaces: `solana`, `pendle`, `morpho`, `dexscreener`.
Owner: spec builder S2 (Batch 1, plan v3 section 6).
Status: specification. No live manifest carries `publicName` yet; that field
lands in Batch 2, driven by the machine-readable artifacts beside this file.

## 1. What this document decides, and what it does not

It decides ONE thing per tool: the model-visible `publicName`.

- The dotted `toolId` is immutable (plan 5.1). It stays the internal and audit
  identity: `protocol_executions.tool_id`, `tool_embeddings.tool_id`,
  `MUTATION_MATRIX` keys, `protocol_sync_jobs.read_tool_id`, and the failure
  classifiers keep their meaning with no migration.
- Nothing here renames a tool id, changes a description, changes a parameter
  key, merges two tools, or edits code.
- Where the evidence argues for a merge or a read consolidation, both tools are
  still mapped 1:1 below and the merge is recorded as a PROPOSAL in section 7.
  Merges are a Batch 2+ decision.

Authoritative artifacts (the ones G2 validates, not this prose):

- `docs/tool-surface/mappings/solana.json`
- `docs/tool-surface/mappings/pendle.json`
- `docs/tool-surface/mappings/morpho.json`
- `docs/tool-surface/mappings/dexscreener.json`

Each entry carries `toolId`, `publicName`, and a mandatory `rationale`. This
document renders the same mapping and adds the reasoning that does not fit in a
JSON field. If the two ever disagree, the JSON wins.

## 2. Grammar applied

`publicName = namespace__resource_action`

- lowercase `[a-z0-9_]`, total length at most 64;
- exactly one `__`, at the namespace boundary;
- the action part contains no `__` and neither starts nor ends with `_`;
- the verb goes LAST inside the resource group (`markets_discover`,
  `swap_quote`, `predict_close_all`);
- camelCase segments become snake_case (`closeAll` to `close_all`,
  `supplyCollateral` to `supply_collateral`).

Canonical verbs used here:

| verb | meaning as applied | example |
| --- | --- | --- |
| `discover` | filtered screening over many candidates the caller has not named | `morpho__markets_discover` |
| `search` | free-text lookup | `dexscreener__pairs_search` |
| `get` | detail for a resource the caller names by id (including a batch of named ids) | `pendle__market_get` |
| `list` | bounded enumeration of a scope the caller did not name item by item | `solana__predict_orders_list` |

Mutating tools keep their domain verb (`buy`, `sell`, `claim`, `repay`,
`mint`, `redeem`, `deposit`, `withdraw`, `operate`). None of them was folded
into a method enum: mutations stay atomic so approval binds to the exact action
(plan 5.1, rules/90).

The `get` versus `list` line, stated once because it decides eleven names: the
question is whether the CALLER named the subject. `dexscreener__pairs_get`
takes up to 60 pair addresses the caller supplies and reconciles every one, so
it is `get`. `dexscreener__token_pairs_list` takes one token and returns
whatever pools the provider indexes for it, so it is `list`.

## 3. Inventory and verification

| namespace | manifest source | live toolIds | mapped | plan estimate |
| --- | --- | --- | --- | --- |
| solana | `solana-jupiter/manifest.ts` + `manifests/{core,swap,predict,lend,lend-borrow}.ts` | 34 | 34 | 34 |
| pendle | `pendle/manifest.ts` + 13 modules under `manifests/` | 29 | 29 | 29 |
| morpho | `morpho/manifest.ts` + 18 modules under `manifests/` | 19 | 19 | 19 |
| dexscreener | `dexscreener/manifest.ts` + `manifests/{core,trending,orders}.ts` | 14 | 14 | 14 |
| total | | 96 | 96 | 96 |

Checks run:

1. Inventory extracted from the manifest modules and diffed against the mapping
   artifacts: exact match, no missing id, no unknown id, no duplicate id.
2. All four namespaces are registered in `protocols/catalog.ts:83-93`
   (`NAMESPACE_MODULES`), and `catalog.ts:104-118` throws at module load on a
   duplicate `toolId` or a namespace mismatch, so the manifest arrays are the
   registration truth for these four namespaces.
3. Every one of the 96 manifests declares `lifecycle: "active"`. No deprecated
   or retired tool is in scope, and none was silently dropped.
4. Grammar validated per entry: charset, length, single `__` at the namespace
   boundary, action shape.
5. 96 unique `publicName` values across the four files; no collision.

Note on the plan's figure of 25 unread `solana.predict.*` tools: the live count
is 22 (`solana-jupiter/manifests/predict.ts:4-344`). All 22 descriptions were
read in full for this mapping. The remaining 12 solana tools are 3 core, 2
swap, 4 Earn lend, and 3 Borrow lend.

## 4. solana (34)

`solana-jupiter/manifests/core.ts`, `swap.ts`, `predict.ts`, `lend.ts`,
`lend-borrow.ts`.

| toolId | publicName |
| --- | --- |
| `solana.prices` | `solana__token_prices_get` |
| `solana.tokens.search` | `solana__tokens_search` |
| `solana.tokens.trending` | `solana__tokens_discover` |
| `solana.swap.quote` | `solana__swap_quote` |
| `solana.swap.execute` | `solana__swap_execute` |
| `solana.predict.events` | `solana__predict_events_discover` |
| `solana.predict.search` | `solana__predict_events_search` |
| `solana.predict.event` | `solana__predict_event_get` |
| `solana.predict.market` | `solana__predict_market_get` |
| `solana.predict.orderbook` | `solana__predict_orderbook_get` |
| `solana.predict.tradingStatus` | `solana__predict_trading_status_get` |
| `solana.predict.positions` | `solana__predict_positions_list` |
| `solana.predict.position` | `solana__predict_position_get` |
| `solana.predict.history` | `solana__predict_trade_history_list` |
| `solana.predict.orders` | `solana__predict_orders_list` |
| `solana.predict.order` | `solana__predict_order_get` |
| `solana.predict.orderStatus` | `solana__predict_order_status_get` |
| `solana.predict.trades` | `solana__predict_trades_list` |
| `solana.predict.profile` | `solana__predict_profile_get` |
| `solana.predict.pnlHistory` | `solana__predict_pnl_history_get` |
| `solana.predict.leaderboards` | `solana__predict_leaderboard_list` |
| `solana.predict.vaultInfo` | `solana__predict_vault_get` |
| `solana.predict.suggestedEvents` | `solana__predict_suggested_events_list` |
| `solana.predict.buy` | `solana__predict_buy` |
| `solana.predict.sell` | `solana__predict_sell` |
| `solana.predict.claim` | `solana__predict_claim` |
| `solana.predict.closeAll` | `solana__predict_close_all` |
| `solana.lend.rates` | `solana__lend_earn_rates_list` |
| `solana.lend.positions` | `solana__lend_earn_positions_list` |
| `solana.lend.deposit` | `solana__lend_earn_deposit` |
| `solana.lend.withdraw` | `solana__lend_earn_withdraw` |
| `solana.lend.borrowVaults` | `solana__lend_borrow_vaults_list` |
| `solana.lend.borrowPositions` | `solana__lend_borrow_positions_list` |
| `solana.lend.borrowOperate` | `solana__lend_borrow_operate` |

### 4.1 The `lend` split is the biggest naming decision here

`solana.lend.*` holds two different Jupiter programs. Earn is simple lending;
Borrow is collateral and debt tracked as position NFTs behind one `/operate`
endpoint (`manifests/lend-borrow.ts:207-213`). The shared `lend.` prefix makes
`solana.lend.positions` and `solana.lend.borrowPositions` read as siblings when
they return different things, and the manifests pay for that in prose:

- `lend.ts:144` ends with "for collateralized-borrowing limits and thresholds
  use solana.lend.borrowVaults instead";
- `lend.ts:160` ends with "for collateralized Borrow positions use
  solana.lend.borrowPositions instead";
- `lend.ts:174` says "not collateral for borrowing";
- `lend-borrow.ts:238` closes with "not solana.lend.positions' simple Earn
  positions".

Four descriptions spending a sentence each to correct the name is the defect.
`solana__lend_earn_*` versus `solana__lend_borrow_*` states the split before
any description is read, and the corrective sentences become shrinkable in the
later description wave.

### 4.2 Other non-mechanical solana decisions

- `solana.tokens.trending` to `solana__tokens_discover`. The toolId names one
  of seven categories; the description's own first word is "Discover"
  (`core.ts:67`). `discover` also disambiguates it from
  `dexscreener__narratives_list` (see 6.2), which is where "trending" as a word
  actually belongs.
- `solana.prices` to `solana__token_prices_get`. A bare `prices` in a namespace
  that also returns prediction-market prices is ambiguous.
- `solana.predict.search` to `solana__predict_events_search`. It searches
  events, not markets, and the results feed `predict_event_get`
  (`predict.ts:29-44`).
- `solana.predict.history` to `solana__predict_trade_history_list`. Three
  different histories live in this family; the bare word picked no side.
- `solana.predict.leaderboards` to `solana__predict_leaderboard_list`. Both
  `period` and `metric` are required, so one call returns one leaderboard.
- `solana.predict.vaultInfo` to `solana__predict_vault_get`. `Info` is a noise
  suffix once a verb exists.
- `solana.lend.borrowOperate` keeps `operate`. It is genuinely one multi-leg
  call under one approval and one ledger entry, with four `atMostOne` groups
  and one `atLeastOneOf` group enforcing the leg directions
  (`lend-borrow.ts:275-292`). Splitting it into four verbs would misdescribe
  the transaction and the approval binding.

## 5. pendle (29)

| toolId | publicName |
| --- | --- |
| `pendle.yields` | `pendle__markets_discover` |
| `pendle.position.value` | `pendle__positions_get` |
| `pendle.market.get` | `pendle__market_get` |
| `pendle.market.history` | `pendle__market_history_get` |
| `pendle.market.candles` | `pendle__market_candles_get` |
| `pendle.orderbook` | `pendle__market_orderbook_get` |
| `pendle.rewards.merkle` | `pendle__merkle_rewards_list` |
| `pendle.prices.assets` | `pendle__asset_prices_get` |
| `pendle.pt.quote` | `pendle__pt_quote` |
| `pendle.pt.buy` | `pendle__pt_buy` |
| `pendle.pt.sell` | `pendle__pt_sell` |
| `pendle.pt.redeem` | `pendle__pt_redeem` |
| `pendle.pt.rollover` | `pendle__pt_rollover` |
| `pendle.yt.quote` | `pendle__yt_quote` |
| `pendle.yt.buy` | `pendle__yt_buy` |
| `pendle.yt.sell` | `pendle__yt_sell` |
| `pendle.py.quote` | `pendle__py_quote` |
| `pendle.py.mint` | `pendle__py_mint` |
| `pendle.py.redeem` | `pendle__py_redeem` |
| `pendle.lp.quote` | `pendle__lp_quote` |
| `pendle.lp.add` | `pendle__lp_add` |
| `pendle.lp.remove` | `pendle__lp_remove` |
| `pendle.lp.removeDual` | `pendle__lp_remove_dual` |
| `pendle.lp.addKeepYt` | `pendle__lp_add_keep_yt` |
| `pendle.lp.transfer` | `pendle__lp_transfer` |
| `pendle.lp.toPt` | `pendle__lp_to_pt` |
| `pendle.sy.mint` | `pendle__sy_mint` |
| `pendle.sy.redeem` | `pendle__sy_redeem` |
| `pendle.claim` | `pendle__rewards_claim` |

### 5.1 Non-mechanical pendle decisions

- `pendle.yields` to `pendle__markets_discover`
  (`manifests/read.ts:18-48`). The tool screens markets by chain, liquidity,
  implied APY, expiry window, days to maturity, underlying, category and
  new/prime flags, sorts by nine keys and pages with offset/limit. `yields`
  names a returned column. Aligning it with `morpho__markets_discover` makes
  the fixed-rate versus variable-rate routing legible: `morpho.markets.discover`
  already says "use `pendle.yields` instead when they want a FIXED rate"
  (`morpho/manifests/markets-discover.ts:45`), and that sentence is easier to
  follow when both tools are `markets_discover`.
- `pendle.position.value` to `pendle__positions_get` (`read.ts:51-70`). It
  values EVERY leg the session wallet holds across every Pendle chain, so the
  singular was wrong and `value` is an output, not an action.
- `pendle.orderbook` to `pendle__market_orderbook_get`. Flat in the toolId but
  chain plus market scoped like the other three market reads
  (`manifests/orderbook.ts:47-70`); the prefix groups the four.
- `pendle.rewards.merkle` to `pendle__merkle_rewards_list`. Segment order fixed
  (merkle is the kind of reward, not an action) and deliberately NOT named
  `rewards_get`, because it must never read as the read half of a claim: the
  manifest states Vex can never claim these, since Pendle publishes the amount
  but not the proof (`manifests/rewards-merkle.ts:32-38`).
- `pendle.prices.assets` to `pendle__asset_prices_get`. The toolId's segment
  order reads backwards as a noun phrase.
- `pendle.claim` to `pendle__rewards_claim` (`manifests/yt.ts:58-72`). A bare
  `claim` does not say what is claimed, and this namespace holds a second,
  unclaimable reward surface. It now pairs with `pendle__merkle_rewards_list`
  and matches `morpho__rewards_claim`.

The eight quote/execute families keep their `dryRun`-in-tool or separate
`*.quote` shape unchanged; naming does not touch the prequote gate.

## 6. morpho (19) and dexscreener (14)

### 6.1 morpho

| toolId | publicName |
| --- | --- |
| `morpho.markets.discover` | `morpho__markets_discover` |
| `morpho.markets.activity` | `morpho__markets_activity_list` |
| `morpho.market.get` | `morpho__market_get` |
| `morpho.market.quote` | `morpho__market_quote` |
| `morpho.market.supply` | `morpho__market_supply` |
| `morpho.market.withdraw` | `morpho__market_withdraw` |
| `morpho.market.supplyCollateral` | `morpho__market_supply_collateral` |
| `morpho.market.withdrawCollateral` | `morpho__market_withdraw_collateral` |
| `morpho.market.borrow` | `morpho__market_borrow` |
| `morpho.market.repay` | `morpho__market_repay` |
| `morpho.vaults.discover` | `morpho__vaults_discover` |
| `morpho.vault.get` | `morpho__vault_get` |
| `morpho.vault.quote` | `morpho__vault_quote` |
| `morpho.vault.deposit` | `morpho__vault_deposit` |
| `morpho.vault.withdraw` | `morpho__vault_withdraw` |
| `morpho.positions.get` | `morpho__positions_get` |
| `morpho.rewards.get` | `morpho__rewards_get` |
| `morpho.rewards.claim` | `morpho__rewards_claim` |
| `morpho.wallet.balance` | `morpho__wallet_balance_get` |

Morpho is the namespace that already follows the target grammar most closely;
17 of 19 are mechanical. Two notes:

- The plural/singular split is already correct and is preserved:
  `markets.discover`/`vaults.discover` screen many, `market.get`/`vault.get`
  take one id plus a chain. `morpho__positions_get` keeps its plural with `get`
  on purpose: one call reads one wallet's whole footprint and a second address
  is rejected by name (`manifests/positions-get.ts` description), so the
  plurality is in the rows, not in the subject.
- `morpho.markets.activity` takes `list`, not `discover`: it enumerates a
  transaction record and its own description says it is history, not a
  recommendation signal (`manifests/markets-activity.ts:28`).

### 6.2 dexscreener

| toolId | publicName |
| --- | --- |
| `dexscreener.search` | `dexscreener__pairs_search` |
| `dexscreener.pairs` | `dexscreener__pairs_get` |
| `dexscreener.tokens` | `dexscreener__tokens_get` |
| `dexscreener.tokenPairs` | `dexscreener__token_pairs_list` |
| `dexscreener.orders` | `dexscreener__token_orders_list` |
| `dexscreener.ads` | `dexscreener__ads_list` |
| `dexscreener.profiles` | `dexscreener__profiles_list` |
| `dexscreener.profiles.recent` | `dexscreener__profiles_recent_list` |
| `dexscreener.boosts` | `dexscreener__boosts_list` |
| `dexscreener.boosts.top` | `dexscreener__boosts_top_list` |
| `dexscreener.communityTakeovers` | `dexscreener__community_takeovers_list` |
| `dexscreener.attention` | `dexscreener__attention_list` |
| `dexscreener.trending` | `dexscreener__narratives_list` |
| `dexscreener.meta` | `dexscreener__narrative_get` |

Every toolId here is flat, so every name gains a verb. Two semantic renames:

- `dexscreener.trending` to `dexscreener__narratives_list`. The description
  says in capitals "Returns NARRATIVES, not individual tokens"
  (`manifests/trending.ts:151-155`). A tool named `trending` in a crypto tool
  catalog will be reached for whenever the model wants trending TOKENS, which
  is a different tool entirely. Naming the resource after what it returns
  removes the trap.
- `dexscreener.meta` to `dexscreener__narrative_get`. `meta` is opaque and
  collides with the ordinary meaning of tool metadata; the tool drills into ONE
  narrative by slug (`manifests/trending.ts:167-185`). The pair
  `narratives_list` to `narrative_get` is now self-describing, and the slug's
  provenance is obvious from the names.

`dexscreener.orders` becomes `dexscreener__token_orders_list` because in a
crypto namespace a tool called `orders` reads as a trading-order surface;
DexScreener has none. These are paid promotional orders for one named token
(`manifests/orders.ts:23-38`).

## 7. Merge and consolidation proposals (Batch 2+, not executed here)

Every tool below is mapped 1:1 in the artifacts. These are recommendations for
the batch that owns merges.

`EXECUTED 2026-08-21 (Batch 2, owner decision D7):` proposals 1 and 2 shipped.
`dexscreener.boosts.top` and `dexscreener.profiles.recent` are RETIRED; their
rows are gone from `mappings/dexscreener.json` and no alias replaces the
retired names (D5). Both provider endpoints survive behind a `feed` param on
the surviving tool - `dexscreener.boosts` takes `latest | top`,
`dexscreener.profiles` takes `latest | recentUpdates` - and the enum text
carries the two measured differences the merge had to preserve: the top boost
feed omits the per-purchase `boostCount` on every row and defaults the sort to
`boostCountTotal`, and the latest profile feed sends no `updatedAt` (drift
measured 2026-08-21) while `recentUpdates` still does. The reply names which
endpoint it read through `providerWindow.endpoint`, which the provenance
envelope already carried; a second top-level echo was measured at 10 bytes over
the 16 KiB output cap on the recent-updates window and was dropped rather than
paid for. Proposals 3 and 4 are untouched.

1. **`dexscreener.boosts` + `dexscreener.boosts.top`.** Same namespace, same
   parameter set (`BOOST_FEED_PARAMS`, `manifests/trending.ts:69-99`), same row
   shape. The only stated difference is which provider endpoint fills them and
   that `boosts.top` reports no per-purchase amount (that field is null there).
   Proposal: one read with `feed: "latest" | "top"`, the null-amount fact
   attached to the enum value. Evidence to gather first: whether any caller
   depends on the two appearing as separate discovery hits.
2. **`dexscreener.profiles` + `dexscreener.profiles.recent`.** Also identical
   parameters (`PROFILE_FEED_PARAMS`). The distinction is "latest profiles"
   versus "recently updated profiles", which the descriptions themselves have
   trouble separating: both are profile-metadata feeds keyed on `updatedAt`,
   and both must repeat that a profile update is not a token launch. Proposal:
   one read with a mode enum, or a merge with the difference expressed as a
   sort. This is the strongest merge candidate in the four namespaces.
3. **`dexscreener.attention`.** Not a merge candidate but a retirement
   candidate. Its own description says it is a Vex-side synthetic merge of the
   profile and boost windows, not a provider feed and not a genuine attention
   signal, tells the model to use it ONLY when the user explicitly asks for the
   combined view, and admits its rows carry no timestamp and none can be added
   (`manifests/trending.ts:124-146`). A tool whose description spends most of
   its length arguing against being called should be measured for actual use
   before it keeps a slot in the working set.
4. **solana predict reads (method-enum candidate named in the plan).** The 16
   reads split into four clean groups: event/market discovery (`events`,
   `search`, `event`, `market`, `suggestedEvents`), wallet state (`positions`,
   `position`, `history`, `profile`, `pnlHistory`), order lifecycle (`orders`,
   `order`, `orderStatus`), and venue state (`orderbook`, `tradingStatus`,
   `trades`, `vaultInfo`). Only the order-lifecycle group is a genuine
   consolidation candidate, and even there `order` and `orderStatus` must stay
   distinguishable because `order` errors once the account closes post-fill
   while `orderStatus` survives closure (`predict.ts:230`, `:244`). My
   recommendation is NOT to method-enum the rest: they take different required
   parameters (`marketId`, `eventId`, `positionPubkey`, `orderPubkey`,
   `period`+`metric`+`limit`), and collapsing them would produce one tool with
   a large conditionally-valid parameter surface, which is the shape the plan's
   own schema-clarity goal is trying to remove.
5. **pendle reads (method-enum candidate named in the plan).** Also weak. The
   six market reads take genuinely different inputs and bounds:
   `market_get` accepts one of market/pt/yt, `market_history` requires a market
   address and a field list, `market_candles` accepts PT/YT/LP and rejects SY,
   `market_orderbook` adds precision and level bounds, `asset_prices` is
   chain-paged with an id cap, `merkle_rewards` takes an optional chain and no
   wallet at all (deliberately, so model output cannot aim it at a third party,
   `manifests/rewards-merkle.ts:14-18`). A single `method` enum would have to
   carry all of that as conditional validity. Recommendation: leave split.
6. **`pendle.lp.remove` versus `pendle.lp.removeDual`, and `pendle.lp.add`
   versus `pendle.lp.addKeepYt`.** Do NOT merge. Both pairs differ in the
   number of output legs and therefore in the number of independent minimums
   the approval binds. Mutations stay atomic (rules/90).

## 8. Description-quality red flags found while reading

Recorded for the description wave; none is fixed here.

### solana.predict (22 descriptions read in full)

1. **`solana.predict.pnlHistory` is documented as broken upstream**
   (`predict.ts:288`): "as of 2026-07-24 the provider's pnl-history route is
   documented but returns 404 upstream for every wallet ... prefer
   solana.predict.profile until it is restored upstream." A tool that cannot
   succeed is still in the catalog, still embedded, and still occupies a
   discovery slot. This is the closest thing to a dead tool in the four
   namespaces. It needs a decision: re-probe and confirm, gate it behind a
   capability check, or move it to a non-active lifecycle. Leaving a
   model-visible tool whose own description says it always 404s is a discovery
   cost with no upside.
2. **`solana.predict.profile` contains a duplicated clause**
   (`predict.ts:274`): "use solana.predict.leaderboards to compare other
   traders" appears, and then "or solana.predict.leaderboards to compare
   against other traders" appears again in the next sentence. Same referral
   twice in one description.
3. **`solana.predict.sell` and `solana.predict.claim` are near-duplicates**
   (`predict.ts:116` and `:130`). The last three sentences, covering JupUSD
   settlement, the later keeper transaction, and the USDC conversion recipe,
   are identical text. That is a canonical-shared-sentence candidate
   (`protocols/conventions.ts`), not two hand-maintained copies.
4. **`solana.predict.suggestedEvents` breaks the family's own session-scope
   rule** (`predict.ts:329-342`). Every other wallet-scoped predict read
   defaults to the session wallet and REJECTS a different address; this one
   requires `walletAddress` and explicitly accepts any wallet, "not only your
   own". That may be correct (recommendations are not a position read), but it
   is an inconsistency worth an explicit note in the description rather than a
   silent divergence, and it is worth confirming it cannot be used to profile a
   third party's interests.
5. **`solana.predict.tradingStatus` has the shortest description in the
   namespace** (`predict.ts:202`, 111 characters) while three mutating tools
   depend on it as a precondition. It states no failure mode and no cadence.
6. **`solana.predict.trades` requires `limit`** (`predict.ts:262`) while every
   other paged predict read defaults it to 20. The reason given (no upstream
   owner/market scope) is honest and probably right, but it is a parameter
   vocabulary inconsistency S4 should see.
7. **Classification check: all four mutating predict tools are
   `user_wallet_broadcast` and all 18 reads are `read`.** No misclassification
   found. `solana.predict.closeAll` is worth naming anyway: it is a BATCH
   broadcast, one independent sell-or-claim per position, and a failure on one
   never blocks the others (`predict.ts:144`). Its approval and its result
   contract are per-position while its `actionKind` is a single value. That is
   consistent with the plan's per-item batch reporting rule, but it deserves an
   explicit line in the money-description template.

### Other namespaces

8. **Stale output-cap copy confirmed** in `solana.tokens.trending`
   (`core.ts:67`): "a bare recent call measured 27,970 B against the 16,384 B
   tool-output cap". Plan section 3 records that no global output cap exists
   (`engine/core/turn-loop-tool-batch/results.ts:169-172`). This is one of the
   five stale references the later wave corrects.
9. **`solana.swap.quote` declares `actionKind: "read"` and `mutating: false`**
   (`swap.ts:116-117`) while the Pendle quotes declare the same but state
   plainly that quoting has a SIDE EFFECT: it records the prequote
   authorization that arms the broadcast tool for about 15 minutes
   (`pendle/manifests/pt.ts:24`, `yt.ts:21`, `py.ts:26`, `lp.ts:25`). The
   Jupiter quote description does not say so, though the same prequote identity
   gate applies (`swap.ts:89-93` names `prequote/identity/hash.ts`). Either the
   Solana quote genuinely has no such record and the comment is misleading, or
   its description is missing the disclosure the four Pendle quotes carry. This
   needs verification before the description wave, not a guess.
10. **`pendle.lp.transfer` is a misleading name that this batch preserves.**
    It moves LP from one market to another in one transaction; `transfer` reads
    as a wallet-to-wallet send. `pendle__lp_migrate` or `pendle__lp_move` would
    be honest. Not taken here because the toolId's own segment is `transfer`
    and a semantic rename of a mutating tool deserves its own review.
11. **`morpho.wallet.balance` is named after its secondary half.** Its own
    description says "THE APPROVAL HALF IS THE REASON THIS TOOL EXISTS"
    (`manifests/wallet-balance.ts`), and routes plain balance questions to
    `wallet_balances` and `chain_read`. `morpho__wallet_allowances_get` would
    describe it better. Recorded as a Batch 2 proposal; mapped mechanically
    here.
12. **Description length variance inside one namespace is extreme.** In morpho,
    `markets-discover.ts` and `vaults-discover.ts` run 269 and 263 lines with
    descriptions of several thousand bytes, against `rewards-get.ts` at 83
    lines. The plan's 2048-byte budget (5.2) will require allowlist entries for
    several morpho descriptions; that is expected and should be argued per
    tool, since these are the tools where decision ambiguity is genuinely
    highest.

## 9. Open questions for the coordinator

1. `solana.predict.pnlHistory`: keep, gate, or retire (red flag 1)? A
   model-visible tool that always 404s is a discovery-slot cost.
2. Does `solana.swap.quote` record a prequote authorization (red flag 9)? The
   answer changes whether its description is missing a disclosure or whether
   the Pendle quotes are over-claiming.
3. `solana.predict.suggestedEvents` accepting any wallet address (red flag 4):
   intended product behavior, or a scope gap?

None of the three blocks this mapping; all three affect the later description
wave.
