# Blockscout fixture provenance

Every file in this directory is a raw live response body captured from the
Robinhood Chain (chain id 4663) Blockscout instance
`https://robinhoodchain.blockscout.com`, backend `v11.2.8.+commit.1169dbc5`.

Capture transport: Electron 42 `net.fetch` (Chromium network stack) running
headless under xvfb, `accept: application/json`, `AbortSignal.timeout(15000)`,
requests issued sequentially 2.5 s apart. Plain `curl` cannot be used against
this host: Cloudflare answers every path with a 403 `cf-mitigated: challenge`
interstitial (see BLOCKSCOUT.md section "Cloudflare and transport").

Sanitization, and the only edit applied to any body: the wallet owner's EVM
address was replaced by the literal `0xOWNER` (case-insensitive match on the
full 40-hex address). Nothing else was added, removed, reordered, reformatted
or truncated; bodies are byte-for-byte the provider's output apart from that
substitution. The "owner substitutions" column counts how many occurrences
were replaced in that body; `0` means the address never appeared inside the
payload (it was only in the request path).

`0x0000000000000000000000000000000000000001` is a public burn-style address
with a large, varied token inventory. It is captured deliberately: it supplies
the ERC-721 rows, `decimals: null` rows and real multi-page cursors that the
owner's own inventory does not contain.

The raw byte count is the compressed-decoded body length reported by the
capture harness at fetch time.

| fixture | URL | captured (UTC) | HTTP | raw bytes | owner substitutions |
| --- | --- | --- | --- | --- | --- |
| `address-token-balances.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/token-balances` | 2026-08-31T08:42:37.130Z | 200 | 14457 | 0 |
| `address.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER` | 2026-08-31T08:42:40.196Z | 200 | 630 | 1 |
| `address-tokens-erc20.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/tokens?type=ERC-20` | 2026-08-31T08:42:42.394Z | 200 | 14491 | 0 |
| `address-tokens-nft-empty.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/tokens?type=ERC-721%2CERC-1155` | 2026-08-31T08:42:45.011Z | 200 | 36 | 0 |
| `address-transactions-page1.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/transactions` | 2026-08-31T08:42:47.590Z | 200 | 270387 | 71 |
| `address-transactions-filter-to.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/transactions?filter=to` | 2026-08-31T08:45:55.779Z | 200 | 23053 | 15 |
| `token-priced.json` | `https://robinhoodchain.blockscout.com/api/v2/tokens/0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b` | 2026-08-31T08:43:39.141Z | 200 | 437 | 0 |
| `token-unpriced.json` | `https://robinhoodchain.blockscout.com/api/v2/tokens/0x8763C3E06a1A45691795a003140f9c4198Dbac63` | 2026-08-31T08:43:42.134Z | 200 | 312 | 0 |
| `transaction.json` | `https://robinhoodchain.blockscout.com/api/v2/transactions/0x4977f90355aafb39be7af9e6cbafb1867889726ba8c4321defb20f63330392f9` | 2026-08-31T08:43:44.706Z | 200 | 1980 | 1 |
| `tokens-list-page1.json` | `https://robinhoodchain.blockscout.com/api/v2/tokens?type=ERC-20` | 2026-08-31T08:45:44.424Z | 200 | 22312 | 0 |
| `tokens-list-page2.json` | `https://robinhoodchain.blockscout.com/api/v2/tokens?type=ERC-20&name=Hey+Anon&contract_address_hash=0x79bbf4508b1391af3a0f4b30bb5fc4aa9ab0e07c&fiat_value=0.261073&market_cap=4010898.564327559&holders_count=272&items_count=50&is_name_null=false` | 2026-08-31T08:46:52.121Z | 200 | 22510 | 0 |
| `other-address-token-balances-with-nft.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0x0000000000000000000000000000000000000001/token-balances` | 2026-08-31T08:43:59.435Z | 200 | 70479 | 0 |
| `other-address-tokens-erc20-page1.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0x0000000000000000000000000000000000000001/tokens?type=ERC-20` | 2026-08-31T08:45:47.789Z | 200 | 22483 | 0 |
| `other-address-tokens-erc20-page2.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0x0000000000000000000000000000000000000001/tokens?type=ERC-20&id=190361936&value=1000000000000000000000&fiat_value=&items_count=50` | 2026-08-31T08:46:55.372Z | 200 | 20225 | 0 |
| `error-422-malformed-address.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xdeadbeef/token-balances` | 2026-08-31T08:43:56.828Z | 422 | 143 | 0 |
| `error-422-malformed-transaction-hash.json` | `https://robinhoodchain.blockscout.com/api/v2/transactions/0xdead` | 2026-08-31T08:44:07.283Z | 422 | 147 | 0 |
| `error-404-unknown-token.json` | `https://robinhoodchain.blockscout.com/api/v2/tokens/0x000000000000000000000000000000000000dEaD` | 2026-08-31T08:44:02.107Z | 404 | 23 | 0 |
| `error-422-invalid-token-type.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/tokens?type=BOGUS` | 2026-08-31T08:44:04.690Z | 422 | 485 | 0 |
| `error-422-unexpected-query-field.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/token-balances?type=ERC-20&page=2` | 2026-08-31T08:45:50.492Z | 422 | 101 | 0 |
| `error-422-invalid-filter-enum.json` | `https://robinhoodchain.blockscout.com/api/v2/addresses/0xOWNER/transactions?filter=sideways` | 2026-08-31T08:45:58.580Z | 422 | 103 | 0 |
| `error-422-cursor-boolean-as-string.json` | `https://robinhoodchain.blockscout.com/api/v2/tokens?type=ERC-20&name=Hey+Anon&contract_address_hash=0x79bbf4508b1391af3a0f4b30bb5fc4aa9ab0e07c&fiat_value=0.261073&market_cap=4010898.564327559&holders_count=272&items_count=50&is_name_null=False` | 2026-08-31T08:46:29.369Z | 422 | 115 | 0 |
| `error-400-unknown-api-v2-action.json` | `https://robinhoodchain.blockscout.com/api/v2/openapi.json` | 2026-08-31T08:44:36.872Z | 400 | 35 | 0 |

## Captured but not committed

| capture | URL | captured (UTC) | HTTP | raw bytes | why not committed |
| --- | --- | --- | --- | --- | --- |
| address transactions page 2 | `/api/v2/addresses/0xOWNER/transactions?<page-1 cursor>` | 2026-08-31T08:43:47Z | 200 | 699270 | 699 KB, and it proves only that the page-1 cursor round-trips; its own `next_page_params` is quoted verbatim in BLOCKSCOUT.md. |
| Cloudflare challenge | `/api/v2/config/backend-version` via plain `curl` | 2026-08-31T08:48Z | 403 | 5507 | An HTML challenge page, not an API contract. Its status line and headers are transcribed in BLOCKSCOUT.md. |
| `/api-docs/openapi.json` | `https://robinhoodchain.blockscout.com/api-docs/openapi.json` | 2026-08-31T08:44:39Z | 404 | 84611 | The instance's HTML 404 page, not JSON. Recorded here so nobody re-probes it: this instance publishes no OpenAPI document. |

## Chains probed

Robinhood Chain 4663 only. Four live calls were spent on base, arbitrum,
ethereum and optimism Blockscout hosts before the scope was narrowed to 4663;
those captures were discarded and are not part of this fixture set.
