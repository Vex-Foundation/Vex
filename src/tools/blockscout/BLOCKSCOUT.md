# Blockscout REST v2 on Robinhood Chain (4663)

Reference document, live-probed. Every statement below that describes provider
behavior was measured against the running instance on 2026-08-31; nothing here
is copied from Blockscout documentation or inferred from another instance.
Anything not measured is named as such in "Not verified" at the end.

- Host: `https://robinhoodchain.blockscout.com`
- Base path: `/api/v2`
- Backend: `v11.2.8.+commit.1169dbc5` (`GET /api/v2/config/backend-version`)
- Chain: Robinhood Chain, chain id 4663, native ETH, 18 decimals
- Auth: none. No API key was sent on any probe; every call succeeded anonymously.
- Fixtures: `src/__tests__/fixtures/blockscout/`, provenance in that directory's
  `PROVENANCE.md`.

## Why this exists

Vex reads 4663 balances today from a hardcoded 4-token seed list (WETH, VEX,
VIRTUAL, USDG in `src/tools/evm-chains/registry.ts`) plus whatever the user
pinned. A token held on 4663 that was never pinned and never bought through Vex
is invisible. `GET /api/v2/addresses/{address}/token-balances` returns the
complete ERC-20 and NFT inventory for an address in one unpaginated call, which
is exactly the enumeration the seed list cannot do. On the owner's address it
returned 34 tokens where the seed list can see at most 4.

Blockscout is scoped to chain 4663 by product decision. It is not a general EVM
balance source for Vex; see "Where Blockscout is not an option" below.

## Endpoint index

| # | Method and path | Purpose | Live status | Fixture |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/v2/addresses/{address}/token-balances` | full token inventory, unpaginated | 200, 14457 B, 559 ms | `address-token-balances.json`, `other-address-token-balances-with-nft.json` |
| 2 | `GET /api/v2/addresses/{address}` | native coin balance and address metadata | 200, 630 B, 992 ms | `address.json` |
| 3 | `GET /api/v2/addresses/{address}/tokens?type=...` | same inventory, paginated envelope, type filter | 200, 14491 B, 114 ms | `address-tokens-erc20.json`, `address-tokens-nft-empty.json`, `other-address-tokens-erc20-page1.json`, `other-address-tokens-erc20-page2.json` |
| 4 | `GET /api/v2/tokens/{tokenAddress}` | single token metadata and price | 200, 437 B, 486 ms | `token-priced.json`, `token-unpriced.json` |
| 5 | `GET /api/v2/tokens?type=ERC-20` | chain-wide token list, paginated | 200, 22312 B, 863 ms | `tokens-list-page1.json`, `tokens-list-page2.json` |
| 6 | `GET /api/v2/addresses/{address}/transactions` | address transaction history, paginated | 200, 270387 B, 951 ms | `address-transactions-page1.json`, `address-transactions-filter-to.json` |
| 7 | `GET /api/v2/transactions/{txHash}` | single transaction | 200, 1980 B, 6464 ms | `transaction.json` |
| 8 | `GET /api/v2/config/backend-version` | backend version | 200, 46 B, 77 ms | not committed (value quoted above) |
| - | `GET /api/v2/openapi.json` | machine schema | 400 `Unknown API v2 action` | `error-400-unknown-api-v2-action.json` |
| - | `GET /api-docs/openapi.json` | machine schema | 404 HTML | not committed |

The instance publishes no OpenAPI or JSON-schema artifact on either path
probed. The machine artifacts that do exist and that wire names must be taken
from are the committed fixtures in this repository and the validation error
bodies (endpoint 3's 422 spells out the exact accepted token-type regex, and
that regex is the authority for the `type` parameter).

## Cloudflare and transport

Plain `curl` cannot reach this host at all. Measured 2026-08-31 on two
different paths:

```
HTTP/2 403
content-type: text/html; charset=UTF-8
cf-mitigated: challenge
server: cloudflare
```

with a 5.5 KB `Just a moment...` interstitial as the body. This is a blanket
challenge on the host, not a per-endpoint rule: `/api/v2/config/backend-version`
(5507 B) and `/api/v2/addresses/{address}/token-balances` (5706 B) both 403.

Electron 42 `net.fetch` (Chromium's own network stack, which is what the app
uses) passes with no special headers: `accept: application/json` was the only
header set, and every one of the 30 probes returned the real API response.
Consequence for the implementation: this client must go through the main
process `net.fetch`, and a Node `fetch`/`undici`/`axios` path is not an option.
A 403 whose `content-type` is `text/html` must be classified as a transport or
bot-gate failure, never as an address-not-found or empty-balance result.

## Rate limiting

Response headers on every 200 (exposed via `access-control-expose-headers`):

| header | observed value |
| --- | --- |
| `x-ratelimit-limit` | `180` |
| `x-ratelimit-remaining` | `179` (fresh window) |
| `x-ratelimit-reset` | `20631` |
| `bypass-429-option` | `temporary_token` |

No 429 was provoked; the whole session ran at roughly one request per 2.5 s and
`x-ratelimit-remaining` never dropped near zero. The unit of
`x-ratelimit-reset` was not verified. `bypass-429-option: temporary_token`
advertises an escape hatch (`api-v2-temp-token` is also in the exposed-header
list) that was not exercised. The 429 body shape is therefore unknown and a
client must treat any 429 as "retry after backoff", not parse it.

Other constant response headers: `access-control-allow-origin: *`,
`cache-control: max-age=0, private, must-revalidate`, `content-encoding: br`,
`x-request-id` (an opaque request correlation id worth logging on failures).

## 1. GET /api/v2/addresses/{address}/token-balances

The endpoint that replaces the seed list.

Path parameter `address`: must match `^0x([A-Fa-f0-9]{40})$`. Lowercase input
is accepted and returns a byte-identical body to the checksummed input
(measured: both 14457 B). Anything else is 422, see "Errors".

Query parameters: **none are accepted**. `?type=ERC-20&page=2` returns 422
`Unexpected field: page`, so the request is a bare path fetch. Note the 422
names only `page`; `type` was tolerated in that same request, so a `type`
filter may exist here undocumented, but it was not proven to do anything and
must not be relied on. Use endpoint 3 when a type filter is needed.

Response: a **bare JSON array**, not an envelope. There is no `items` wrapper
and no `next_page_params`: the array is the complete inventory in one call
(34 rows for the owner, 171 rows for the burn address, both unpaginated).
Ordering observed is descending by fiat value then by raw value, with the four
priced tokens first; ordering is not guaranteed by anything measured and should
not be relied on.

Each element:

| field | JSON type | null? | meaning and units |
| --- | --- | --- | --- |
| `value` | string | never null in 205 observed rows | **raw atomic integer, base 10, as a string.** Not divided by decimals, not a float. For an NFT row it is the item count (`"1"`). |
| `token_id` | null | always null here | populated only on per-instance NFT endpoints; rows here are aggregated per token |
| `token_instance` | null | always null here | as above |
| `token` | object | never null | see the token object below |

The `token` object, identical in shape to endpoints 3, 4 and 5:

| field | JSON type | null? | meaning and units |
| --- | --- | --- | --- |
| `address_hash` | string | never | checksummed contract address. **The field is `address_hash`, not `address`.** |
| `symbol` | string | never observed null | token symbol, arbitrary user-supplied text, includes emoji in live data (one row's symbol is a single feather glyph) |
| `name` | string | never observed null | token name, same trust level as `symbol` |
| `decimals` | string | **yes** | decimal exponent as a **decimal string** (`"18"`, `"9"`). `null` on ERC-721 rows. Never a number. |
| `type` | string | never | one of `ERC-20`, `ERC-721`, `ERC-1155`, `ERC-404`, `ERC-7984` (the accepted-value regex from endpoint 3's 422; `ERC-20` and `ERC-721` observed live) |
| `exchange_rate` | string | **yes** | USD price of one whole token, decimal string (`"0.00348046"`). **`null` is how "no price" is spelled.** Never `"0"`, never absent: the key is present on all 205 observed rows. |
| `circulating_market_cap` | string | yes | USD, decimal string; null when unpriced |
| `circulating_supply` | string | yes | null on every row observed on 4663 |
| `total_supply` | string | yes | raw atomic integer string; null on ERC-721 rows |
| `holders_count` | string | no on balance rows | decimal string on endpoints 1/3/4. **On endpoint 5's cursor it is a number**, see "Pagination". |
| `volume_24h` | string | yes | USD 24 h volume, decimal string; null when unpriced |
| `icon_url` | string | yes | absolute https URL, mostly CoinGecko-hosted; null when the token has no icon |
| `reputation` | string | never | see "Spam and reputation" |

Measured on the owner's address: 34 rows, all `type: ERC-20`, 33 with
`decimals: "18"` and 1 with `"9"`, 4 priced and 30 with `exchange_rate: null`,
no zero-value row. That is 4 tokens visible and 30 invisible to today's seed
list. The burn address adds the missing variants: 167 ERC-20 plus 4 ERC-721
rows, the ERC-721 rows carrying `decimals: null`, `total_supply: null` and
`value: "1"`.

## 2. GET /api/v2/addresses/{address}

Native coin balance and address metadata. No query parameters probed; the
address path parameter obeys the same regex.

| field | JSON type | null? | meaning and units |
| --- | --- | --- | --- |
| `coin_balance` | string | no | **native balance in wei, raw atomic integer string** (18 decimals on 4663). Observed `"19381080962157947"`. |
| `exchange_rate` | string | yes | USD price of one whole native coin, decimal string (`"2437.86"`) |
| `block_number_balance_updated_at` | number | no | block height the balance was read at. The freshness anchor for the native read. |
| `hash` | string | no | checksummed address |
| `is_contract` | boolean | no | |
| `is_scam` | boolean | no | address-level scam flag, distinct from `reputation` |
| `is_verified` | boolean | no | source-verification of a contract |
| `reputation` | string | no | `"ok"` observed |
| `ens_domain_name` | string | yes | null on 4663 |
| `name` | string | yes | contract or tag name |
| `implementations` | array | no | `[]` for an EOA; proxy implementation entries otherwise |
| `proxy_type` | string | yes | |
| `creation_status`, `creation_transaction_hash`, `creator_address_hash` | string | yes | null for an EOA |
| `has_beacon_chain_withdrawals`, `has_logs`, `has_token_transfers`, `has_tokens`, `has_validated_blocks` | boolean | no | cheap capability hints; `has_tokens` is a valid pre-check before endpoint 1 |
| `metadata` | object | yes | null observed |
| `private_tags`, `public_tags`, `watchlist_names` | array | no | `[]` anonymously; these are per-account features of the hosted UI |
| `watchlist_address_id` | number | yes | null anonymously |
| `token` | object | yes | non-null only when the address is itself a token contract |

## 3. GET /api/v2/addresses/{address}/tokens

Same rows as endpoint 1, wrapped and paginated, with a working type filter.

| parameter | accepted | omitted | invalid |
| --- | --- | --- | --- |
| `type` | `ERC-20`, `ERC-721`, `ERC-1155`, `ERC-404`, `ERC-7984`, comma-joined, case-insensitive, optional surrounding brackets | returns all types (measured: `?type=ERC-20` 14491 B and no `type` at all 14491 B on an ERC-20-only address) | 422 with the exact regex in the body |
| cursor fields | see "Pagination" | first page | 422 naming the offending field |

The accepted-value regex, verbatim from the live 422 body and the authority for
this parameter:

```
^\[?(ERC-20|ERC-721|ERC-1155|ERC-404|ERC-7984)(,(ERC-20|ERC-721|ERC-1155|ERC-404|ERC-7984))*\]?$
```

Response: `{ "items": [...], "next_page_params": object | null }`. Items are
the same `{ value, token_id, token_instance, token }` rows as endpoint 1. Page
size is 50. An address with no matching token returns
`{"items":[],"next_page_params":null}` (36 B), which is a **success with an
empty inventory** and must not be confused with an error.

Endpoint 1 is preferable for a balance read: one call, no cursor loop, no page
size to exhaust. Endpoint 3 is the right choice only when filtering by type or
when a caller wants bounded pages.

## 4. GET /api/v2/tokens/{tokenAddress}

Returns the bare `token` object documented under endpoint 1, with no wrapper
and no balance. Priced example (`VEX`): `exchange_rate: "0.00348046"`,
`decimals: "18"`, `circulating_market_cap` and `volume_24h` populated.
Unpriced example (`RATO`): `exchange_rate`, `circulating_market_cap`,
`volume_24h` and `icon_url` all `null`, `decimals: "9"`, and it is still a
200 with full metadata. An unknown or non-token address is 404
`{"message":"Not found"}` (23 B). A malformed address is 422.

This endpoint is not needed for a balance read: endpoints 1 and 3 already embed
the whole token object per row. It is the right call for refreshing one token's
price or resolving a token the user pins by address.

## 5. GET /api/v2/tokens?type=ERC-20

Chain-wide token list, 50 per page, sorted by descending fiat/market value.
Items are the bare token object (no `value` wrapper). Used here as a broad
sample for the `reputation` value space; it has no role in a balance read.

## 6. GET /api/v2/addresses/{address}/transactions

For later settlement use.

| parameter | accepted | omitted | invalid |
| --- | --- | --- | --- |
| `filter` | an enum; `to` probed live and returned 15 items | all transactions for the address (50 newest) | 422 `Invalid value for enum`, which does not list the members |
| cursor fields | see "Pagination" | newest first page | 422 |

Response: `{ "items": [...], "next_page_params": object | null }`, 50 items per
page, newest first. Page 1 for an active address is large: **270387 B for 50
transactions**, roughly 5.4 KB per transaction, and page 2 measured 699270 B
because its transactions carry decoded input and token transfers. Any consumer
must treat this endpoint as expensive and page deliberately.

## 7. GET /api/v2/transactions/{txHash}

Path parameter must match `^0x([A-Fa-f0-9]{64})$`; anything else is 422.

Item shape (same object as the items of endpoint 6). Money-relevant fields:

| field | JSON type | null? | meaning and units |
| --- | --- | --- | --- |
| `value` | string | no | native value moved, **raw wei string** |
| `fee` | object | no | `{ "type": "actual" \| ..., "value": string }`, value in raw wei. Only `"actual"` observed. |
| `gas_used`, `gas_limit`, `gas_price`, `base_fee_per_gas`, `max_fee_per_gas`, `max_priority_fee_per_gas`, `priority_fee`, `transaction_burnt_fee` | string | some yes | all raw integer strings, wei for prices and fees |
| `status` | string | no | `"ok"` observed; the settlement signal |
| `result` | string | no | `"success"` observed; human-readable twin of `status` |
| `revert_reason` | string | yes | |
| `has_error_in_internal_transactions` | boolean | no | a transaction can be `status: ok` and still have failed internal calls |
| `is_pending_update` | boolean | no | |
| `confirmations` | number | no | |
| `block_number` | number | no | |
| `nonce`, `position`, `type` | number | no | `type` is the EIP-2718 transaction type (2 observed) |
| `timestamp` | string | no | ISO 8601 UTC with microseconds |
| `from`, `to` | object | `to` yes on contract creation | address objects carrying `hash`, `is_contract`, `is_scam`, `is_verified`, `reputation`, `name`, `implementations`, `proxy_type`, `ens_domain_name`, tags |
| `created_contract` | object | yes | |
| `method`, `decoded_input`, `raw_input` | string/object/string | first two yes | `raw_input` is `"0x"` for a plain transfer |
| `token_transfers` | array | yes | `[]` on the single-transaction endpoint for a plain transfer; `null` in the list endpoint's items |
| `token_transfers_overflow` | boolean | yes | true means the list was cut by the server, so the transfer set is incomplete and must be re-read per transaction |
| `exchange_rate` | string | yes | current USD price of the native coin |
| `historic_exchange_rate` | string | yes | USD price at the transaction's timestamp; `null` on the probed transaction, so do not assume a historic price is available |
| `confirmation_duration` | array | no | `[0, 101.0]`, a two-number window in milliseconds |
| `transaction_types` | string[] | no | e.g. `["coin_transfer"]` |
| `authorization_list` | array | no | EIP-7702 authorizations, `[]` observed |
| `transaction_tag`, `fhe_operations_count` | string / number | first yes | |
| `arbitrum` | object | yes | **chain-family extension**: 4663's Blockscout is built as an Arbitrum-flavoured instance, so a rollup block sits under this key with `batch_number`, `batch_data_container`, `commitment_transaction { hash, status, timestamp }`, `confirmation_transaction { ... }`, `gas_used_for_l1`, `gas_used_for_l2`, `contains_message`, message fields. Observed `commitment_transaction.status: "finalized"`. Treat the key as optional and the object as extensible. |

## Money-path facts

These are the facts a balance or settlement reader depends on. All measured.

1. **Token amounts are raw atomic integers encoded as base-10 strings.**
   `value: "4229196476593709361909"`. Never a float, never pre-divided, never a
   JSON number. Parse with `BigInt`, never `Number`, never `parseFloat`.
2. **Native balance is likewise a raw wei string**, `coin_balance`, from
   endpoint 2, with `block_number_balance_updated_at` as its freshness anchor.
3. **`decimals` is present but is a string, and it is nullable.** `"18"`,
   `"9"`; `null` for ERC-721. A row with `decimals: null` has no meaningful
   fixed-point interpretation and its `value` is a count, not an amount. Parse
   the string to an integer at the boundary; do not pass it into arithmetic as
   a string, and do not default a missing value to 18.
4. **"No price" is spelled `exchange_rate: null`.** The key is always present.
   It is never `"0"` and never omitted, on 205 balance rows and 100 chain-wide
   token rows. `"0"` from this provider would mean a genuine zero price, so the
   two must not be collapsed. 30 of the owner's 34 tokens on 4663 are unpriced,
   so an unpriced token is the normal case here, not an anomaly: a USD total
   computed from this endpoint is a **lower bound** and must be presented as
   such.
5. `exchange_rate` is a USD price per whole token, so a USD value requires
   `value / 10**decimals * exchange_rate`. Do that in decimal arithmetic, never
   in IEEE floats, and only when `decimals` is non-null.
6. **All monetary strings are provider-supplied and display-tolerant.** Prices,
   market caps and volumes are decimal strings with arbitrary precision
   (`"3480814.587298996"`). They are fit for display and ranking. They are not
   fit as a safety floor for any signing decision.
7. `symbol` and `name` are attacker-controlled contract metadata. On 4663 they
   include emoji and impersonation-shaped names. Never key a balance, a route
   or an approval on them; key on `address_hash`.

## Spam and reputation

Two independent flags exist, and the product rule is that Vex shows every
token and filters none.

- `token.reputation`: a **string**, present on every token object on every
  endpoint. Observed value across 305 rows (34 owner balances, 171 burn-address
  balances, 100 chain-wide tokens): `"ok"` and nothing else. The full value
  space could not be enumerated from 4663 live data, and this instance
  publishes no schema, so the field must be modelled as an **extensible union**:
  a known member `"ok"` plus an unknown-value fallback that is passed through
  and displayed verbatim rather than mapped to a boolean.
- `address.is_scam` and the `is_scam` on every embedded address object (`from`,
  `to`): a **boolean**, `false` observed everywhere on 4663.

How to read the flag without filtering on it: carry `reputation` through to the
row model as an opaque string and surface it as a label next to the token, and
carry `is_scam` as a badge on the address. Never use either in a `filter`,
`where` or early `continue`, never let either suppress a row, and never let an
unknown `reputation` value be treated as worse (or better) than `"ok"`. The
count of rows returned by the provider must equal the count of rows the agent
and the user see.

## Pagination

Two of the three shapes matter here, and the balance endpoint has none.

- Endpoint 1 (`token-balances`) is **unpaginated**: a bare array, complete.
- Envelope endpoints return `next_page_params`, an **opaque object**, and
  `null` on the last page. Blockscout expects its keys flattened into the query
  string of the next request, unchanged.

Observed cursors, verbatim:

```jsonc
// /addresses/{a}/transactions
{"index":5,"value":"0","hash":"0x1332e8...06f0","inserted_at":"2026-08-10T13:14:35.883226Z",
 "block_number":32826100,"fee":"9085187072000","items_count":50}

// /addresses/{a}/tokens?type=ERC-20
{"id":190361936,"value":"1000000000000000000000","fiat_value":null,"items_count":50}

// /tokens?type=ERC-20
{"name":"Hey Anon","contract_address_hash":"0x79bb...f7a3","fiat_value":"0.261073",
 "market_cap":"4010898.564327559","holders_count":272,"items_count":50,"is_name_null":false}
```

**Measured serialization trap.** The cursor mixes strings, numbers, booleans
and nulls, and the server re-validates each key by type. Serializing the cursor
with a naive stringifier that produces Python-style `False` yields a real 422:

```json
{"errors":[{"title":"Invalid value","source":{"pointer":"/is_name_null"},"detail":"Invalid boolean. Got: string"}]}
```

The round-trip that works, verified live on both cursor shapes: `true`/`false`
lowercase for booleans, the empty string for `null` (`fiat_value=`), and the
decimal string as-is for numbers and strings. Note also that `holders_count` is
a **number** in this cursor while it is a **string** in the token object, so a
cursor must never be reconstructed from parsed row fields; round-trip the
provider's object and nothing else.

Page size is 50 on every paginated endpoint observed, and there is no parameter
to change it (`page` is rejected outright).

## Errors

Two distinct body shapes, both `application/json`.

| status | condition | body |
| --- | --- | --- |
| 422 | malformed address | `{"errors":[{"title":"Invalid value","source":{"pointer":"/address_hash_param"},"detail":"Invalid format. Expected ~r/^0x([A-Fa-f0-9]{40})$/"}]}` |
| 422 | malformed transaction hash | same shape, pointer `/transaction_hash_param`, 64-hex regex |
| 422 | invalid `type` value | three-element `errors` array, the third carrying the accepted-value regex |
| 422 | unexpected query field | `{"errors":[{"title":"Invalid value","source":{"pointer":"/page"},"detail":"Unexpected field: page"}]}` |
| 422 | invalid `filter` enum | `{"errors":[{"title":"Invalid value","source":{"pointer":"/filter"},"detail":"Invalid value for enum"}]}` |
| 422 | cursor field of the wrong JSON type | `{"errors":[{"title":"Invalid value","source":{"pointer":"/is_name_null"},"detail":"Invalid boolean. Got: string"}]}` |
| 404 | unknown token or unknown resource | `{"message":"Not found"}` |
| 400 | unrouted `/api/v2/...` path | `{"message":"Unknown API v2 action"}` |
| 403 | Cloudflare bot gate, `content-type: text/html` | 5.5 KB challenge page, `cf-mitigated: challenge`. Not an API error; a transport failure. |

So: `errors[].{title,source.pointer,detail}` for validation, `message` for
routing and not-found. A client must branch on `content-type` before parsing,
because the 403 case is HTML. Non-existent but well-formed addresses are not an
error at all: they return 200 with an empty array or `{"items":[]}`.

Distinguish four outcomes and never collapse them: a 200 empty inventory (the
address genuinely holds nothing), a 422 (our request is wrong, do not retry), a
404 (the resource does not exist), and a 403/HTML or network failure (we could
not read, so the previous balance is not disproven and must not be shown as
zero).

## Chain mapping

Blockscout host to Vex chain id, for the instances the Blockscout chains
registry lists as first-party. Only the first row is in scope for Vex.

| Vex chain id | slug | host | in Vex's Blockscout scope |
| --- | --- | --- | --- |
| 4663 | robinhood | `https://robinhoodchain.blockscout.com` | **yes, the only one** |
| 1 | ethereum | `https://eth.blockscout.com` | no |
| 10 | optimism | `https://explorer.optimism.io` | no |
| 130 | unichain | `https://unichain.blockscout.com` | no |
| 137 | polygon | `https://polygon.blockscout.com` | no |
| 324 | zksync | `https://zksync.blockscout.com` | no |
| 1868 | soneium | `https://soneium.blockscout.com` | no |
| 8453 | base | `https://base.blockscout.com` | no |
| 42161 | arbitrum | `https://arbitrum.blockscout.com` | no |
| 42220 | celo | `https://celo.blockscout.com` | no |

The non-4663 hosts are listed only so nobody re-derives them. Their paths were
not probed under this scope and their behavior here is asserted for none of
them.

## Where Blockscout is not an option

Blockscout is a 4663-only balance source in Vex, by product decision, because
4663 is an app-local chain absent from Khalani's registry and therefore the one
chain with no enumerating balance provider. Every other chain Vex reads is
served by Khalani, which returns correct native and token balances there.

Independently of that decision, Blockscout could not serve these even if we
wanted it to:

- **monad 143** and **plasma 9745**: no instance in the Blockscout chains
  registry at all.
- **linea, ink, ronin, hyperevm, world**: explorers that are self-hosted or
  vendor-operated forks rather than first-party `*.blockscout.com` instances.
  Their `/api/v2` surface may differ in version, field set, auth and bot gate,
  and none of it was probed. Nothing in this document may be assumed to hold
  for them.

## Not verified

Named explicitly so no reader mistakes silence for measurement.

- The full value space of `token.reputation`. Only `"ok"` appears in 305 live
  rows on 4663; no non-`ok` value was observable on this chain.
- The 429 body shape, the unit of `x-ratelimit-reset`, and the
  `bypass-429-option: temporary_token` / `api-v2-temp-token` mechanism. No 429
  was provoked, deliberately.
- Whether `token-balances` silently honours a `type` query parameter. The 422
  it returned named only `page`.
- Behavior of the `filter=from` value on endpoint 6 (`to` was probed, `from`
  was not) and of any other query parameter on endpoint 6 beyond `filter` and
  the cursor.
- ERC-1155, ERC-404 and ERC-7984 rows. Those names come from the live
  validation regex, but no live row of those types was seen on 4663.
- Every per-instance NFT endpoint (`/tokens/{a}/instances`, `token_id`-bearing
  responses). `token_id` and `token_instance` were `null` on every row observed.
- Any write, search, stats, or websocket surface. Out of scope.
- Behavior under an authenticated API key. Every probe was anonymous.
