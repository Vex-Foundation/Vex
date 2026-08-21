# Protocol publicName Map, Part 2

Authoritative toolId to publicName mapping for seven namespaces: khalani,
kyberswap, uniswap, relay, virtuals, trench, pools. 41 tools.

Machine-readable companions (the artifacts G2 validates):
`docs/tool-surface/mappings/{khalani,kyberswap,uniswap,relay,virtuals,trench,pools}.json`.
This document is the rendered view plus the reasoning; the JSON is the contract.

Scope note: this is Batch 1 specification work. Nothing here renames a live
tool. The dotted `toolId` stays exactly as it is in every manifest, database
row, embedding, mutation matrix entry and approval envelope; `publicName` is a
new projection field that lands on live manifests in Batch 2 (plan v3 section
6). Merge proposals in this document are proposals only.

## 1. Grammar applied

`publicName = <namespace>__<resource>_<action>`

- lowercase `[a-z0-9_]`, exactly one `__`, at the namespace boundary;
- the action part carries no double underscore, no leading or trailing
  underscore; total length at most 64 (longest here is 30,
  `virtuals__genesis_launches_list`);
- canonical read verbs: `discover` (filtered screening), `search` (free text),
  `get` (detail by id), `list` (bounded listing);
- the verb goes LAST within its resource group;
- existing snake segments keep their words (`pools.claim_fees`,
  `trench.launch_execute`).

Two catalog-wide conventions this batch fixes, both proposed as rules for the
whole catalog (S2 coordination item, section 6):

1. **Singular resource for a by-id read, plural for a listing.**
   `pools__token_get` vs `pools__tokens_discover`, `khalani__order_get` vs
   `khalani__orders_list`, `virtuals__agent_get` vs `virtuals__agents_discover`.
   This is what breaks the `pools.token` / `pools.tokens` near-typo pair
   (section 5.2) without merging anything.
2. **Every fund-moving tool ends in a mutation verb.** `khalani.bridge` and
   `relay.bridge` broadcast real transactions
   (`khalani/manifest.ts:186-187`, `relay/manifests/bridge.ts:63-64`) but read
   as nouns. They become `khalani__bridge_execute` and `relay__bridge_execute`,
   matching `kyberswap__swap_execute`, `trench__trade_execute`,
   `pools__launch_execute`. `pools.claim_fees` is reordered to
   `pools__fees_claim` for the same reason: verb last, words unchanged.

## 2. khalani (9 tools, source `khalani/manifest.ts`)

| toolId | publicName | kind |
| --- | --- | --- |
| `khalani.chains.list` (:43) | `khalani__chains_list` | mechanical |
| `khalani.tokens.top` (:56) | `khalani__tokens_top_list` | verb normalization |
| `khalani.tokens.search` (:69) | `khalani__tokens_search` | mechanical |
| `khalani.tokens.autocomplete` (:83) | `khalani__tokens_autocomplete` | verb exception |
| `khalani.tokens.balances` (:98) | `khalani__token_balances_get` | resource rename |
| `khalani.quote.get` (:113) | `khalani__bridge_quote_get` | semantic rename |
| `khalani.orders.list` (:149) | `khalani__orders_list` | mechanical |
| `khalani.orders.get` (:169) | `khalani__order_get` | singular for by-id |
| `khalani.bridge` (:182) | `khalani__bridge_execute` | verb added, mutation |

### Verb normalization notes (the khalani list family)

khalani is the namespace where the canonical four-verb set is under the most
pressure, because it has four read shapes over one `tokens` resource.

- `tokens.top` -> `khalani__tokens_top_list`. `top` is a qualifier, not a verb.
  Dropping it (`khalani__tokens_list`) would have been cleaner to read but
  would have hidden that the provider returns a RANKING, not an arbitrary
  page. Keeping the qualifier inside the resource group and putting the verb
  last preserves both the grouping and the meaning.
- `tokens.autocomplete` -> `khalani__tokens_autocomplete`. This is a
  deliberate exception to the canonical verb set. It is semantic keyword
  completion over a `keyword` param that parses phrases like
  "100 usdc on ethereum" (`manifest.ts:86,90`); `khalani.tokens.search` is
  address-or-symbol resolution over a `query` param (`:72,76`). Both are "find
  a token", so both would map to `search` and collide. **Proposal for S4:**
  admit `autocomplete` as a fifth registered verb rather than inventing a
  qualifier, and record it in the verb vocabulary so no future namespace
  reinvents a synonym.
- `tokens.balances` -> `khalani__token_balances_get`. It does not belong in the
  token-catalogue group at all: it reads ONE wallet's balances across chains
  (`:101`). `get` rather than `list` because there is no pagination contract,
  only a chain filter.
- `quote.get` -> `khalani__bridge_quote_get`. The bare `quote` resource never
  said what was quoted. The rename also makes the quote-then-execute pairing
  legible, which matters here: `khalani.bridge` hard-fails with
  `deadline_expired` past the route deadline the quote returns (`:116`).

## 3. kyberswap (5 tools)

| toolId | publicName | kind |
| --- | --- | --- |
| `kyberswap.swap.quote` (`manifests/swap.ts:15`) | `kyberswap__swap_quote` | mechanical |
| `kyberswap.swap.execute` (`manifests/swap.ts:32`) | `kyberswap__swap_execute` | mechanical |
| `kyberswap.tokens.check` (`manifests/tokens.ts:6`) | `kyberswap__token_safety_check` | semantic rename |
| `kyberswap.chains` (`manifests/chains.ts:6`) | `kyberswap__chains_list` | verb added |
| `kyberswap.chains.supported` (`manifests/chains.ts:17`) | `kyberswap__chains_status_list` | near-typo resolution |

`tokens.check` says neither what is checked nor what a pass means. The tool
inspects one token for honeypot and fee-on-transfer behavior
(`manifests/tokens.ts:9`), so `kyberswap__token_safety_check` states the
subject (singular, by address) and the question. `check` stays as the action
because `get` would imply a neutral read of stored data rather than a safety
verdict.

## 4. uniswap (2), relay (2), virtuals (4)

| toolId | publicName | kind |
| --- | --- | --- |
| `uniswap.swap.quote` (`manifests/swap.ts:21`) | `uniswap__swap_quote` | mechanical |
| `uniswap.swap.execute` (`manifests/swap.ts:38`) | `uniswap__swap_execute` | mechanical |
| `relay.quote.get` (`manifests/bridge.ts:32`) | `relay__bridge_quote_get` | semantic rename |
| `relay.bridge` (`manifests/bridge.ts:56`) | `relay__bridge_execute` | verb added, mutation |
| `virtuals.list` (`manifests/agents.ts:33`) | `virtuals__agents_discover` | resource + verb |
| `virtuals.get` (`manifests/agents.ts:58`) | `virtuals__agent_get` | resource named |
| `virtuals.graduations` (`manifests/agents.ts:72`) | `virtuals__graduations_list` | verb added |
| `virtuals.geneses` (`manifests/agents.ts:89`) | `virtuals__genesis_launches_list` | jargon expanded |

`virtuals.list` and `virtuals.get` were the worst names in this half of the
catalog: neither states its resource, and `list` understates the operation. The
tool takes `chain`, `status`, `sortBy`, `limit`, `page`, `pageSize`, filters
client-side over a bounded window and rejects every unrecognised value by name
(`manifests/agents.ts:37-47`). That is canonical `discover`, not `list`.

`geneses` is provider jargon with no meaning to a model scanning a namespace
list; `virtuals__genesis_launches_list` says it browses the genesis launch
calendar (`manifests/agents.ts:93`).

The two uniswap tools are reveal-gated hidden fallbacks for KyberSwap
(`manifests/swap.ts:24,41`). Naming changes nothing about that: the gate is
visibility, not obscurity of the name, and the mechanical mapping keeps the
pair symmetric with kyberswap so the model reads them as the same operation at
a different venue once revealed.

## 5. trench (10) and pools (9)

| toolId | publicName | kind |
| --- | --- | --- |
| `trench.tokens` (`manifests/tokens.ts:12`) | `trench__tokens_discover` | verb added |
| `trench.search` (`manifests/search.ts:9`) | `trench__tokens_search` | regrouped |
| `trench.trades` (`manifests/trades.ts:10`) | `trench__token_trades_list` | scope named |
| `trench.images` (`manifests/images.ts:16`) | `trench__images_list` | verb added |
| `trench.my_launches` (`manifests/my-launches.ts:11`) | `trench__my_launches_list` | verb added |
| `trench.trade_quote` (`manifests/trade.ts:27`) | `trench__trade_quote` | mechanical |
| `trench.trade_execute` (`manifests/trade.ts:39`) | `trench__trade_execute` | mechanical |
| `trench.launch_preview` (`manifests/launch-preview.ts:18`) | `trench__launch_preview` | mechanical |
| `trench.launch_request_form` (`manifests/launch.ts:50`) | `trench__launch_request_form` | mechanical |
| `trench.launch_execute` (`manifests/launch.ts:86`) | `trench__launch_execute` | mechanical |
| `pools.tokens` (`manifests/tokens.ts:11`) | `pools__tokens_discover` | verb added |
| `pools.token` (`manifests/token.ts:11`) | `pools__token_get` | near-typo resolution |
| `pools.search` (`manifests/search.ts:11`) | `pools__tokens_search` | regrouped |
| `pools.candles` (`manifests/candles.ts:15`) | `pools__token_candles_list` | scope named |
| `pools.my_launches` (`manifests/my-launches.ts:11`) | `pools__my_launches_list` | verb added |
| `pools.claim_fees` (`manifests/claim.ts:15`) | `pools__fees_claim` | verb last, mutation |
| `pools.launch_preview` (`manifests/launch.ts:13`) | `pools__launch_preview` | mechanical |
| `pools.launch_request_form` (`manifests/launch.ts:28`) | `pools__launch_request_form` | mechanical |
| `pools.launch_execute` (`manifests/launch.ts:40`) | `pools__launch_execute` | mechanical |

Decisions worth stating:

- **`search` regrouped under `tokens`.** `trench.search` and `pools.search`
  name an operation with no object while searching exactly the resource that
  `*.tokens` screens (same row shape, `pools/manifests/search.ts:11-16`). After
  the rename each namespace shows `tokens_discover` and `tokens_search`
  adjacent, which is where the discover-vs-search choice actually gets made.
- **Scope moved into the name.** `trench.trades` requires a `token` address and
  a `page` (`manifests/trades.ts:18-19`); `pools.candles` reads one token's
  OHLCV series (`manifests/candles.ts:15`). Both read as namespace-wide feeds
  today. The singular scoping resource states the required param.
- **`my_launches` keeps `my_`.** The wallet is the session's selected wallet
  and cannot be overridden (`trench/manifests/my-launches.ts:14`). The name
  states a fixed scope, which is honest rather than clumsy.
- **`launch_request_form` keeps three words.** The form IS the approval
  (`pools/manifests/launch.ts:7-9,28-34`); shortening to `launch_request` would
  blur it against `launch_execute`, which is the tool that spends.

## 6. Near-typo pairs: 1:1 now, merge proposals for Batch 2+

### 6.1 `kyberswap.chains` vs `kyberswap.chains.supported`

Both map 1:1 today (`kyberswap__chains_list`, `kyberswap__chains_status_list`).

Evidence (`kyberswap/handlers/swap/chain-token-handlers.ts:15-25`):

- `kyberswap.chains` returns `getKyberChains()`, the STATIC local registry:
  `{ slug, chainId, name, aggregator }` per row
  (`src/tools/kyberswap/chains.ts:95-97`, `types.ts:36-41`). No network call, so
  it cannot fail on a provider outage, and it is the only tool that returns the
  `slug` every other kyberswap tool requires in its `chain` param.
- `kyberswap.chains.supported` calls the Common Service, then INTERSECTS the
  result with the same local registry by `chainId`. Rows are
  `{ chainId, chainName, displayName, state }` (`types.ts:28-33`). No `slug`,
  no `aggregator` flag.

So the shorter tool does not exclude the longer one's data, and the longer one
does not subsume the shorter one either: the live call is a strict subset by
row (intersected) and a different field set by column, and it drops the one
field the model needs to make the next call.

**Proposal (Batch 2+):** merge into a single `kyberswap__chains_list` with a
`liveStatus: boolean` param (default false). The merged output is the registry
row joined with the live `state` by `chainId`, with `state: null` and a stated
reason when the live read is off or the Common Service is unavailable. The join
is already what the current handler does, so the merge removes a tool without
inventing behavior. Cost: one more parameter on the namespace's simplest tool;
benefit: the confusable pair disappears and `slug` is always present.
Alternative rejected: deleting `kyberswap.chains.supported` outright, because
`state` is the only signal that a registry chain is currently degraded.

### 6.2 `pools.token` vs `pools.tokens` (found while reading, not in the plan)

One character apart, and the more dangerous pair of the two: `pools.tokens` is
a filtered market screen, `pools.token` is a single-address deep read joining
the launchpad row with on-chain PartyLocker state at a pinned block
(`pools/manifests/token.ts:11-16`). A model that types the wrong one gets a
plausible-looking answer about the wrong thing.

**No merge proposed.** The two have different inputs (filter set vs one
address), different sources (API only vs API plus on-chain at a pinned block)
and different failure modes. The naming rule is the fix:
`pools__tokens_discover` vs `pools__token_get` cannot be confused by shape.

### 6.3 `virtuals.list` vs `virtuals.graduations` (functional near-duplicate)

Not a spelling pair, but a stronger merge candidate than 6.1.

Evidence (`virtuals/handlers.ts`):

- `virtuals.graduations` (:139-178) calls `scanVirtualsPages` with
  `sort: "lpCreatedAt"` and the predicate `isGraduation` (`status === "AVAILABLE"
  && lpCreatedAt !== null`, :49-51), then projects with `projectVirtualsList`.
- `virtuals.list` (:81-120) calls the SAME `scanVirtualsPages` with the same
  projector, and already accepts `status: "graduated"` plus
  `sortBy: "recentGraduation"`, which `list-params.ts:63` maps to exactly
  `lpCreatedAt`.

So `virtuals__graduations_list` is `virtuals__agents_discover` with
`status=graduated, sortBy=recentGraduation`, differing only by the extra
`lpCreatedAt !== null` guard and a fixed `filterLabel` in the window note.

**Proposal (Batch 2+):** retire `virtuals.graduations` behind
`virtuals__agents_discover`, after moving the `lpCreatedAt !== null` guard into
the `graduated` status filter (today `matchesStatus` accepts AVAILABLE rows with
a null LP time, so the two tools genuinely disagree on a small set of rows and
the merge must not silently change `status=graduated` semantics). Stop
condition: if that guard change is judged a behavior change to
`status=graduated`, keep both tools and merge nothing.

### 6.4 dexscreener pattern note (S2 owns the files)

S2 owns dexscreener's pairs. The pattern this document proposes and applies,
offered for consistency rather than as a decision on their files:

1. Map every near-typo member 1:1 first; a merge never rides along with a
   naming batch.
2. Resolve confusability by GRAMMAR where the two tools have genuinely
   different inputs or sources (6.2): singular-plus-`get` against
   plural-plus-`discover`.
3. Propose a MERGE only where one tool is a parameterisation of the other over
   the same producer (6.1, 6.3), and state the exact param that replaces the
   retired tool plus the behavior difference the merge must preserve.

## 7. Red flags found while reading

Reported, not fixed. None of these is in Batch 1 scope.

1. **Two banned param keys remain in khalani** (param wave item, explicitly out
   of scope here): `key: "wallet"` on `khalani.tokens.balances`
   (`khalani/manifest.ts:106`) and `khalani.orders.list` (`:157`), both carried
   in `_manifest-lint/allowlist.ts:346,352` as `param-key` violations with the
   reason "deleted by the rename waves (W5/W6)". Canonical key is
   `walletFamily` (plan 5.3).
2. **`wallet` and `walletAddress` coexist on the same two tools**
   (`manifest.ts:105-106`, `:156-157`) meaning wallet FAMILY and wallet
   ADDRESS. That is a fund-adjacent confusion, worse than either key alone;
   the param wave should rename both together, not just the banned one.
3. **`virtuals.list` still ships `sortBy` and `sort` as one knob under two
   spellings** (`manifests/agents.ts:43-44`, guarded by
   `atMostOne: [["sortBy","sort"]]` :53). Already named in plan 5.3 for removal
   in a later wave; recorded here because it survives the rename untouched.
4. **`pools.launch_preview` is `mutating: true` with `actionKind:
   "local_write"`** (`pools/manifests/launch.ts:18,22`) while its description
   says it "spends nothing, signs nothing, takes no image lock". The flag is
   correct (it writes a local preview record) but `mutating: true` on a tool
   the model is told is advisory is worth a look when the description wave
   reaches it. `trench.launch_preview` is `mutating: false` for what reads as
   the same class of operation (`trench/manifests/launch-preview.ts:21-24`) -
   the difference is real (trench writes nothing) but the asymmetry across two
   near-identical namespaces will read as noise to a model.
5. **`trench.search` and `trench.tokens` both claim coverage boundaries in
   prose** ("only tokens launched on Trench Express - never other Robinhood
   pools", `manifests/search.ts:12`). Fine content, but it is per-tool prose
   duplicating a namespace fact; plan 5.2 moves that class of statement to
   namespace-level guidance.
6. **Continuation vocabulary is already split inside these seven namespaces**:
   `cursor` / `nextCursor` (pools, khalani orders), `page` + `pageSize` +
   `limit` with a five-page window (virtuals, `manifests/agents.ts:45-47`), a
   REQUIRED 0-based `page` (`trench/manifests/trades.ts:19`), and bounded
   non-pageable `limit` only (trench images, my_launches). This is the input
   S4's pagination classification needs; no tool here is `pagination: none`
   except the two kyberswap chain reads.

## 8. Verification performed

- All seven JSON artifacts parse (`node`, `JSON.parse`).
- Grammar: 41/41 match `^[a-z0-9]+__[a-z0-9]+(_[a-z0-9]+)*$`, exactly one `__`,
  correct namespace prefix, length at most 64.
- Uniqueness: 41 publicNames, 41 unique, no collision across the seven files.
- Completeness against live manifests (`khalani/manifest.ts` plus the
  `manifests/` directories of the other six namespaces): 41 live toolIds, 41
  mapped, 0 missing, 0 orphaned.
- Namespace aggregation cross-checked so no manifest file was missed: each
  `<namespace>/manifest.ts` re-exports exactly the `manifests/*` arrays read
  here, and `protocols/catalog.ts:51-63` registers all seven namespaces.
- Counts per namespace: khalani 9, kyberswap 5, uniswap 2, relay 2, virtuals 4,
  trench 10, pools 9. Total 41, matching plan section 6.
