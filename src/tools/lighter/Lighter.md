# Lighter Module Map

**Last updated: 2026-08-08**

Lighter support starts as Core + Robinhood Chain read-only market data. This
module has no credentials, no auth tokens, no signing helpers, and no
state-changing order/deposit/withdrawal/transfer paths.

## Sources

- Core docs: https://apidocs.lighter.xyz/
- RHC docs: https://apidocs.rh.lighter.xyz/
- Core REST base: `https://mainnet.zklighter.elliot.ai`
- RHC REST base: `https://api.rh.lighter.xyz`
- Core WebSocket base: `wss://mainnet.zklighter.elliot.ai/stream`
- RHC WebSocket base: `wss://api.rh.lighter.xyz/stream`

## File Map

| File | Role |
|------|------|
| `constants.ts` | Public base URLs, endpoint paths, explicit environment names, limits |
| `types.ts` | TypeScript request and response shapes for Phase 1 market reads |
| `validation.ts` | Runtime validators for the public REST responses |
| `errors.ts` | Lighter HTTP/provider failures mapped to `LIGHTER_*` `VexError`s |
| `throttle.ts` | Per-process public REST throttle, small TTL cache, in-flight dedupe |
| `client.ts` | Read-only REST client and singleton |

## Phase 1 REST Surface

| Client method | Endpoint | Notes |
|---------------|----------|-------|
| `getStatus(environment)` | `GET /` | Public status |
| `getSystemConfig(environment)` | `GET /api/v1/systemConfig` | Public system config |
| `getMarkets(environment, params)` | `GET /api/v1/orderBooks` | Optional `market_id`, `filter` |
| `getMarketDetails(environment, params)` | `GET /api/v1/orderBookDetails` | Required `market_id`; optional `filter` |
| `getOrderBookOrders(environment, params)` | `GET /api/v1/orderBookOrders` | Required `market_id`; `limit` 1-250 |
| `getRecentTrades(environment, params)` | `GET /api/v1/recentTrades` | Required `market_id`; `limit` 1-100 |
| `getCandles(environment, params)` | `GET /api/v1/candles` | Required market, resolution, epoch-ms timestamp range, bounded `count_back` |

## Safety Notes

- Every call requires an explicit `environment`: `core` or `rhc`.
- The module never reads environment variables, local secret vault entries, API
  keys, auth tokens, private keys, wallets, or signer state.
- Candle timestamps are JavaScript epoch milliseconds. Seconds-scale Unix
  timestamps are rejected before a provider request is sent.
- Candle ranges are bounded by Vex before the provider request. In Phase 1,
  broad ranges are rejected if they can exceed the requested `countBack` at the
  selected resolution. This is a Vex-owned safety and output-size policy, not a
  claim about Lighter's full candle query semantics.
- Provider error bodies are redacted and length-bounded before they enter a
  `VexError`.
