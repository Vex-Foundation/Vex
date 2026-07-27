# DexScreener live response captures

Real, unedited responses from the public DexScreener REST API, used by
`../../dexscreener-live-shape.test.ts` and by the `pair-list-*` tests (through
`../../_pair-captures.ts`) so the validators, the projection and the byte budgets
are all proven against bytes the provider actually sent — never a hand-rolled
object that would merely re-assert the test's own assumptions.

These exist because two tools (`dexscreener.orders`, `dexscreener.boosts.top`)
failed on 100% of calls for months while the suite stayed green: every
DexScreener fixture in the tree was hand-invented, and each one encoded the
shape the code expected instead of the shape the API sends.

## Envelope

Each file is `{ endpoint, capturedAt, response }`. `response` is the response
body verbatim — field values are never edited, reordered, or trimmed. The
wrapper carries the provenance a future reader needs: which URL produced it and
when it was true.

These endpoints are keyless public GETs and return public market data and
promotional listings only (pool addresses, token addresses, prices, boost counts,
order status). There is nothing to sanitise: no wallet of ours, no personal data,
no credential. The pair captures DO carry issuer-authored free text verbatim,
including one 34,090-character token name — that is the point of one of them, and
it is public on-chain metadata.

## Files

### Promotional feeds (schema-drift witnesses)

| file | endpoint | pins |
|---|---|---|
| `token-boosts-top-v1.json` | `GET /token-boosts/top/v1` | 30 rows, `totalAmount` 30/30, **`amount` 0/30** — the omission that made `boosts.top` throw on every call |
| `token-boosts-latest-v1.json` | `GET /token-boosts/latest/v1` | 30 rows, `amount` **and** `totalAmount` 30/30 — the sibling path that must keep working |
| `orders-v1-solana-boosted-token.json` | `GET /orders/v1/solana/3pRSpPyE6EYeapDm2Ui2GHnU2d1dYUQxzfaQaJTWfHZP` | object root `{orders,boosts}` with a **non-empty** boost-payment ledger (3 rows) |
| `orders-v1-solana-empty-boost-ledger.json` | `GET /orders/v1/solana/A55XjvzRU4KtR3Lrys8PpLZQvPojPqvnv5bJVHMYy3Jv` | same object root, 7 orders, **empty** ledger — the collection-empty case, kept alongside a non-empty one on purpose |

### Pair windows (captured 2026-07-27 for the `AgentDexPair` pipeline)

Each of these exists because it reproduces one specific measured fact. Read
`../../_pair-captures.ts` for the loader and `../../pair-list-*.test.ts` for what
each one proves.

| file | endpoint | pins |
|---|---|---|
| `search-v1-sol-usdc-adversarial-strings.json` | `GET /latest/dex/search?q=SOL/USDC` | 30 rows; one row carries a **34,090-character `baseToken.name`** and a **9,575-character `baseToken.symbol`**. The witness for the untrusted-text exposure: `name` is kept out of the DEFAULT projection (projection, not truncation) while `symbol` is in the lean set and therefore delivered whole, ~9.6 KB and all |
| `search-v1-usdc.json` | `GET /latest/dex/search?q=USDC` | 30 rows across **15 chains with ZERO Ethereum rows**. The witness for "a chain-filtered empty result is not an absent market": `{query:"USDC", chainIds:"ethereum"}` must report `droppedByFilter: { chainIds: 30 }`, not an empty answer |
| `token-pairs-v1-ethereum-weth.json` | `GET /token-pairs/v1/ethereum/0xC02aaA39…` | 30 pools of one token — the 30-row lean/rich byte budget for `tokenPairs`, and the row the naming-law test projects with every field enabled |
| `token-pairs-v1-solana-bonk-price-outlier.json` | `GET /token-pairs/v1/solana/DezXAZ8z…` | 30 pools whose worst `priceUsd` is **13.8x the median** across the same token's pools. The cross-pool price-sanity witness. The same mint showed **4,892x** a day earlier — the magnitude moves, the mechanism does not, so do not refresh this capture into one with no outlier without saying so |
| `tokens-v1-ethereum-40-requested-30-returned.json` | `GET /tokens/v1/ethereum/<40 addresses>` | **40 addresses requested, 30 rows returned, 10 silently absent, HTTP 200.** The provider-side-truncation witness; the requested list is recoverable from the `endpoint` string |
| `pairs-v1-ethereum-weth-usdc-pool.json` | `GET /latest/dex/pairs/ethereum/0x88e6A0c2…` | The single-row case, plus the undocumented top-level `pair` field (a duplicate of `pairs[0]` when one id is requested, `null` when several are) |

### Feeds and narratives (captured 2026-07-27 for the `AgentDexFeedRow` / `AgentDexNarrative` pipelines)

Loaded through `../../_feed-captures.ts`. The two profile feeds and the two
narrative files were each captured in the SAME second as their sibling, because
what they pin is a disagreement between two endpoints — a capture taken minutes
apart could not prove it.

| file | endpoint | pins |
|---|---|---|
| `token-profiles-latest-v1.json` | `GET /token-profiles/latest/v1` | 30 rows carrying `updatedAt` and `cto` on **30/30** — both were parsed off the wire and **discarded** by this feed's validator until card D-2. **13 of the 30 are on the `robinhood` chain**, which is the owner's worked example. `cto` is `false` on all 30, so this capture proves the `ctoOnly` DROP path; the keep path is proven in `feed-list-envelope.test.ts` against this same capture with one row's flag flipped, labelled as a derived variant |
| `token-profiles-recent-updates-v1.json` | `GET /token-profiles/recent-updates/v1` | 30 rows across 6 chains, 11 on `base`. Shares **exactly ONE token** with the `latest` capture taken in the same second — the two feeds are different windows on the market and neither is a superset of the other. Its 30 `description` values are ~14,000 characters, which is why this is the one tool still over the context cap on a no-params call |
| `community-takeovers-latest-v1.json` | `GET /community-takeovers/latest/v1` | 28 rows, each with a `claimDate`. 28 not 30: the feed is not always full, so `providerCapped` must be computed rather than assumed |
| `ads-latest-v1.json` | `GET /ads/latest/v1` | 30 rows. `impressions` is **10,000 or `null`, never anything else**, and ad rows carry no `description`, `icon`, `header` or `links` at all — which is why `ads` is the one feed the lean projection does not shrink |
| `metas-trending-v1.json` | `GET /metas/trending/v1` | 19 narratives. Reports **67 tokens for the `cat` slug**. 19 is a floor on this endpoint's cap, not the cap, so `providerCap` is emitted as `null` here rather than borrowing the 30-row one |
| `metas-meta-v1-cat.json` | `GET /metas/meta/v1/cat` | The aggregate-disagreement witness. `marketCap` is **EXACTLY** `sum(pairs[].marketCap)` (228,639,930 both sides, to the last digit); `tokenCount` is **EXACTLY** `pairs.length` (31) against the trending feed's 67 for the same slug in the same second; `liquidity` is **NOT** a sum of the same pairs (23,493,587.84 against 21,906,813.54). Its 31 pairs span 6 chains, carry `pairCreatedAt` on 29/31 and `labels` on only 10/31 |

## What these captures established

- `/orders/v1/...` returns an **object** `{orders, boosts}`, not an array. Each
  `orders[]` row also carries `chainId` and `tokenAddress`; each `boosts[]` row
  is `{chainId, tokenAddress, id, amount, paymentTimestamp}`.
- `paymentTimestamp` is Unix epoch **MILLISECONDS** (13 digits, e.g.
  `1785076668204` → 2026-07-26). Read as seconds it lands in the year ~58,000.
- `top/v1` and `latest/v1` disagree about `amount`. Both amounts are
  display-only promotional credits, so the schema treats both as nullable
  rather than encoding either endpoint's current field set as a requirement.
- Every one of these feeds also sends `openGraph`, which no validator in the
  tree reads. Dropped silently, not a failure — recorded here so the next
  reader knows it was seen and not simply missed.

From the pair windows:

- **`/tokens/v1` truncates silently.** 40 distinct addresses in, 30 rows out, 10
  absent, HTTP 200, no error and no echo of what resolved. On all 30 rows the
  requested token is the `baseToken`, which is why address reconciliation matches
  the base side only.
- **Provider strings are unbounded.** 34,090 characters of `name` and 9,575 of
  `symbol` on one row; across the 30-row `SOL/USDC` window, name + symbol are the
  clear majority of the payload.
- **`search` ignores every parameter except `q`.** The same query with
  `chainId`/`limit`/`sort`/`order`/`page`/`minLiquidity` appended returns the
  identical row set, which is why every filter is applied by Vex.
- **Two endpoints of one provider can disagree by orders of magnitude about one
  token's price**, and `liquidity.usd`, `fdv` and `marketCap` are all derived from
  that price — so a mispriced pool arrives with three more fabricated numbers.

From the feeds and narratives:

- **Both profile feeds send the same ten fields**, including `updatedAt` and
  `cto` on 30/30 rows of each. The `latest` validator declared neither, so
  `z.object` stripped both — we were paying for the bytes and deleting the only
  field from which profile freshness is computable, while maintaining a separate
  `communityTakeovers` tool to answer what `cto` already answered.
- **They are not the same data.** One token in common out of 30 and 30, captured
  in the same second. Neither feed is a superset of the other and both are worth
  calling.
- **`openGraph` arrives on 30/30 rows of three feeds and is emitted nowhere**, by
  decision rather than oversight: its value is
  `cdn.dexscreener.com/token-images/og/{chainId}/{tokenAddress}?timestamp=…`, a
  pure function of two fields already on the row plus a cache-buster. `icon` and
  `header` are opaque CMS ids and are NOT derivable, so they survive as `fields`
  opt-ins — dropping them from the default row is what brings four feeds from
  20-23 KB under the 16 KiB cap.
- **The narrative detail endpoint's object is internally inconsistent.** Two of
  its four aggregates are exact sums of the subset it returned and two are not
  sums of anything the caller can see. That is why `dexscreener.meta` renames them
  rather than passing them through.
- **The boost feeds carry no timestamp of any kind.** Not a null one — the field
  does not exist, on either endpoint. A freshness filter there is refused rather
  than silently matching nothing.

## Regenerating

```
curl -s <endpoint> | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"));\
  console.log(JSON.stringify({endpoint:"<endpoint>",capturedAt:new Date().toISOString(),response:b},null,2))'
```

Refresh only with a reason. These are dated evidence, and a capture that no
longer shows `amount` missing from `top/v1` is itself a finding worth reading
before it is overwritten. The `orders` captures target specific tokens whose
promotional history is fixed in the past; the boost feeds are live rankings and
will differ on every capture, which is fine — the tests assert on shape and on
field presence, never on which token happens to be ranked first.

The pair windows are live market snapshots, so a refresh legitimately moves the
byte totals by a few percent. `pair-list-byte-budget.test.ts` therefore asserts
CEILINGS with headroom rather than exact numbers, and
`_measure-pair-list-bytes.ts` prints the current matrix. What a refresh must NOT
silently lose is the property each capture pins: the 34,090-character name, the
zero-Ethereum-rows window, the price outlier, the 10 absent addresses. If one of
those is gone, that is a finding to write down, not a capture to overwrite.
