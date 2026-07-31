# Trench Express live response captures

Real, unedited responses from the public Trench Express REST API (mainnet
`api.trench.express`, testnet `api-testnet.trench.express`), used by the
`trench-express` validation and client tests through `../../_captures.ts`. The
validators and the client are proven against bytes the provider actually sent —
never a hand-rolled object that would merely re-assert the test's own
assumptions.

This convention is inherited deliberately from `../../../dexscreener/fixtures/live-captures/README.md`:
two DexScreener tools failed on 100% of calls for months while the suite stayed
green, because every fixture was hand-invented and encoded the shape the code
expected instead of the shape the API sends. Trench Express is even less
forgiving — it has NO published schema, returns HTTP 500 `text/plain` for input
mistakes, and answers "not found" with an empty 200 body — so hand-invented
fixtures are banned here too.

## Envelope

Each JSON capture is `{ endpoint, capturedAt, response }`. `response` is the
response body **verbatim** — values are never edited, reordered, or trimmed. The
one exception is `token-not-found-empty-body.json`: the provider's "not found"
is an HTTP 200 with a zero-length body that is not valid JSON, so that file uses
`{ endpoint, capturedAt, httpStatus, contentLength, bodyText, note }` and records
the empty body as `bodyText: ""`.

## Sanitization reasoning (not a ritual)

These endpoints are keyless public GETs returning public launchpad data: token
addresses, creator addresses, curve prices, on-chain trade hashes, and a
gamification XP/faction layer. Creator and maker addresses are public on-chain
identities and are kept verbatim on purpose — they are part of what each capture
pins.

The one address that must NEVER appear in a committed fixture is **our own
funded probe wallet** (`0x33eF…d2fA`). It does not appear in any of these
captures: the mainnet rows were authored by the partner's E2E wallet
(`0xE00Fef…547f`) and other public creators, so there was nothing to scrub. This
was verified (`grep -i 33eF` over the fixtures → no match), not assumed. If a
future refresh pulls a row created by our wallet, relabel/replace it with
another token's public data before committing.

## Files — each pins a measured fact

| file | endpoint | pins |
|---|---|---|
| `tokens-page0-launched-false.json` | `/api/tokens {launched:false}` | bonding-curve rows: `links` is a length-4 array of empty strings; `holders`/`stats24h` are 0; NO graduated block |
| `tokens-page0-launched-true-graduated.json` | `/api/tokens {launched:true}` | the graduated block — `launched` is a ms TIMESTAMP (number, NOT boolean) alongside `pair`/`currency0`/`currency1`/`poolId` |
| `token-single-graduated.json` | `/api/token {token}` | single graduated object; same token also queryable by address |
| `token-by-symbol-bonding.json` | `/api/token {symbol:"CUC"}` | symbol lookup works; a bonding token with NO graduated block and NO `priceUsd`/`verified`/`reserveAsset` |
| `search-with-results.json` | `/api/search {search:"test"}` | search rows carry the extra `_id` (first 12 bytes of the token address, lowercase hex) absent from `/api/tokens` |
| `search-empty.json` | `/api/search {search:"zzzznomatchqqq"}` | no match is `[]` (HTTP 200), NOT a 404 or empty body |
| `trades-page0.json` | `/api/trades {token,page:0}` | trade items carry NO `token` field; `type` 1=buy/-1=sell; `vol` is USD |
| `testnet-tokens.json` | testnet `/api/tokens {launched:false}` | identical byte-shape to mainnet; ONE row carries non-empty `links` (`["www.website.com","www.x.com/asdsad","",""]`) — the mixed-content links witness |
| `stats-wallet.json` | `/api/stats {address}` | the undocumented XP/faction/`volume`/`trades` gamification object |
| `token-not-found-empty-body.json` | `/api/token {token:0x00…00}` | the "not found" trap: HTTP 200, `content-length: 0`, EMPTY body — `res.json()` throws; must special-case to a typed not-found |

## Regenerating

```
curl -s '<endpoint>' | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"));\
  console.log(JSON.stringify({endpoint:"<endpoint>",capturedAt:new Date().toISOString(),response:b},null,2))'
```

Refresh only with a reason. The universe is tiny today (a handful of tokens per
network), so a refresh may change which rows appear — that is fine, the tests
assert on shape and on field presence, never on which token is first. What a
refresh must NOT silently lose is the property each capture pins above: the
timestamp-not-boolean `launched`, the empty-body not-found, the `_id` on search,
the non-empty `links` row, the missing `token` field on trades. If one of those
is gone, that is a finding to write down, not a capture to overwrite.
