# Pendle read surface in `src/tools`

Local source-of-truth for the DOCUMENTED Pendle read endpoints under `src/tools/pendle/read`.
This shelf is deliberately separate from `../client.ts`, which is the money path.

## Verified From
- `https://api-v2.pendle.finance/core/docs` (OpenAPI 3.0.0 embedded in the Scalar bootstrap)
- `https://docs.pendle.finance/pendle-v2-dev/Backend/ApiOverview`
- Live keyless probes against `https://api-v2.pendle.finance/core`, verified on `2026-07-27`

## Covered Endpoints
- `GET /v2/markets/all` — market catalogue, active AND matured
- `GET /v1/sdk/{chainId}/markets/{market}/tokens`
- `GET /v1/sdk/{chainId}/markets/{market}/swapping-prices`
- `GET /v3/{chainId}/markets/{market}/historical-data`
- `GET /v4/{chainId}/prices/{asset}/ohlcv`
- `GET /v1/prices/assets`
- `GET /v1/dashboard/merkle-rewards/{user}`
- `GET /v2/limit-orders/book/{chainId}`
- `GET /v1/dashboard/positions/database/{user}` — wallet positions, with `filterUsd`

## Key Files
- `request.ts` — the request CONTRACT: filters, the live-verified sort-key union, and every guard
  that runs before a URL exists.
- `client.ts` — transport: URL building, TTL cache, CU throttle, measured CU costs.
- `validation/` — one strict validator module per endpoint family, over `_shared.ts` readers.
- `types.ts` — MARKET-scoped read shapes; `dashboard-types.ts` — WALLET-scoped ones.
- `errors.ts` — status → `VexError` with `httpStatus` + `retryable`.

## Design Rules
- **Nothing here is consumed financially.** `types.ts` is a reduced, display-tolerant shape set.
  It must never widen `../types.ts` (`PendleMarket`, `PendleAsset`), which back valuation, sizing
  and convert.
- **Tolerant on display, strict on identity.** Names, labels, APYs and USD figures degrade to
  `null`. Addresses must be 40-hex; raw base-unit amounts must be decimal-digit strings. A row that
  fails is dropped; a body where every row fails RAISES `PENDLE_INVALID_RESPONSE`.
- **A parse failure is never an empty collection.** "Pendle says there is nothing" and "I could not
  read the answer" are different facts.
- **Every error carries `httpStatus` and `retryable`** (`errors.ts`), so a definitive provider
  refusal is distinguishable from a transport failure. A transport failure carries NO `httpStatus`.
- **Truncation is always explicit** — `PendleReadMarketCatalog.complete`,
  `PendleReadCandles.truncated`. Nothing is silently trimmed.
- **Path segments are validated as addresses before the URL is built.** These values originate in
  tool params, i.e. in model output.
- **No claim material.** The merkle read carries tokens and amounts only.

## Local Notes
- `order_by` **needs the dotted path for nested fields**: `details.liquidity:-1` sorts,
  `liquidity:-1` is accepted and silently does not — as is `nonsense:1`. The endpoint never rejects
  an unknown sort key, which is why `PENDLE_READ_MARKET_SORT_KEYS` is a closed, live-verified union.
- Omitting `isActive` returns active AND matured markets in one list (chain 1: 61 + 420 = 481).
- `ids` takes the `chainId-address` composite and resolves a market of EITHER maturity in one call.
- `historical-data` returns ROW OBJECTS under `results`, not parallel arrays, and its window
  parameters are `timestamp_start`/`timestamp_end` as ISO strings. Its selectable field list was
  verified field-by-field; `feeRate`, `liquidity`, `ptDiscount` and `yieldRange` are rejected.
- `ohlcv` returns a CSV STRING under `results`, with unix-SECOND timestamps and a legitimately
  empty trailing volume column. Its window bounds are ISO strings (a seconds bound is a 400:
  "timestamp_start must be a Date instance") — only the RESPONSE rows use unix seconds.
- `prices/assets` returns a MAP keyed by `chainId-address`, not an array of rows.
- `dashboard/positions` takes the wallet in the PATH and NEVER echoes it into the body — verified, which
  is why the recorded fixtures need no in-body sanitisation. `crossPtPositions` sits on each
  `openPositions[]` entry, not on the chain entry, and was empty on all 326 wallets probed.
  `activeBalance` is LP-only and is the STAKED share of `balance`, routinely a fraction of it.
  `updatedAt` is load-bearing: probed wallets came back 56 and 364 days stale.
- `swapping-prices` answers HTTP 404 (`Given market is expired`) for a matured market rather than
  null legs; `limit-orders/book` answers HTTP 404 for a market that is not limit-order whitelisted.
- CU costs in `client.ts` are MEASURED from the live `x-computing-unit` header, not assumed.
- **Open gap:** this shelf runs its own CU bucket (10 CU/min) because `../client.ts` builds its
  throttle privately. Two buckets against one per-IP budget is over-subscription; the fix when read
  handlers are wired is one shared bucket, not a re-tuned split. `PendleReadClient` already accepts
  an injected `PendleThrottle` for that purpose.

## Related
- `../client.ts`, `../validation.ts`, `../types.ts` — the FROZEN money path. Do not widen from here.
- `../../../vex-agent/tools/protocols/pendle/market-read.ts` — `resolveMarketForRead`, the read
  lane's matured-aware resolver, and the counterpart to the active-only `market-lookup.ts`.
- `../../../__tests__/vex-agent/tools/protocols/pendle/read-surface-fixtures.ts` — the recorded
  non-empty live bodies these validators are driven by.
